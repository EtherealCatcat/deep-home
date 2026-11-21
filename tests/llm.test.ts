import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { callLLM, getLastLLMFailure, LLMError } from "../src/llm.js";
import { resetProviderHealth } from "../src/provider.js";

const config = structuredClone(DEFAULT_CONFIG);
config.model.apiKey = "sk-test";

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function networkFailure(code = "ENOTFOUND", message = "getaddrinfo ENOTFOUND example.com"): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError("fetch failed", { cause });
}

/** 假定时器下把重试等待全部跑完，再取结果（失败时返回错误对象）。 */
async function settle<T>(promise: Promise<T>): Promise<T | unknown> {
  const settled = promise.catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetProviderHealth();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("callLLM 失败分类与重试", () => {
  it("网络错误第一次失败后重试成功", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(networkFailure())
      .mockResolvedValueOnce(completion("在呢。"));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await settle(
      callLLM(config, [{ role: "user", content: "在吗" }]),
    )) as { content: string };

    expect(result.content).toBe("在呢。");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("持续断网时保留 cause 里的 code 并重试到上限", async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkFailure("ECONNREFUSED", "connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;

    expect(error).toBeInstanceOf(LLMError);
    expect(error.kind).toBe("network");
    expect(error.code).toBe("ECONNREFUSED");
    expect(error.attempts).toBe(5);
    expect(error.message).toContain("网络没连上");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(getLastLLMFailure()?.code).toBe("ECONNREFUSED");
    expect(getLastLLMFailure()?.attempts).toBe(5);
  });

  it("401 不重试，分类为 auth 并记录调试信息", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;

    expect(error).toBeInstanceOf(LLMError);
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
    expect(error.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getLastLLMFailure()?.kind).toBe("auth");
    expect(getLastLLMFailure()?.code).toBe("HTTP_401");
  });

  it("超时直接失败，不反复等", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;

    expect(error.kind).toBe("timeout");
    expect(error.code).toBe("TIMEOUT");
    expect(error.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.message).toBe("模型响应超时。");
  });
});

describe("callLLM 供应商健康", () => {
  it("429 不重试，并记录 Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "retry-after": "120" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;
    expect(error.kind).toBe("rate");
    expect(error.retryAfterMs).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400 分类为配置问题且不重试", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;
    expect(error.kind).toBe("config");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attempts 选项限制重试次数", async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkFailure());
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(
      callLLM(config, [{ role: "user", content: "在吗" }], { attempts: 2 }),
    )) as LLMError;
    expect(error.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("熔断时直接拒绝且不请求网络，force 可以绕过", async () => {
    const { noteProviderFailure } = await import("../src/provider.js");
    for (let index = 0; index < 3; index += 1) {
      noteProviderFailure({ kind: "server", message: "down", at: Date.now(), attempts: 1 });
    }
    const fetchMock = vi.fn().mockResolvedValue(completion("在呢。"));
    vi.stubGlobal("fetch", fetchMock);

    const error = (await settle(callLLM(config, [{ role: "user", content: "在吗" }]))) as LLMError;
    expect(error.code).toBe("CIRCUIT_OPEN");
    expect(fetchMock).not.toHaveBeenCalled();

    const forced = (await settle(
      callLLM(config, [{ role: "user", content: "在吗" }], { force: true, attempts: 1 }),
    )) as { content: string };
    expect(forced.content).toBe("在呢。");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
