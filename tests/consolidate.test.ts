import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths as makePaths } from "../src/config.js";
import { MemoryStore } from "../src/memory.js";
import { loadLife, saveLife } from "../src/life.js";
import { readTimeline } from "../src/timeline.js";
import { dayKey } from "../src/time.js";
import { consolidateMemory, readConsolidateState, type ConsolidateContext } from "../src/consolidate.js";
import { callLLM } from "../src/llm.js";

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return { ...actual, callLLM: vi.fn() };
});

const config = structuredClone(DEFAULT_CONFIG);
const day = "2026-11-21";
const reply = {
  owner: "# 关于主人\n\n- 喜欢喝温的牛奶。\n- 11 月 20 日提过要把台灯修好。",
  me: "# 关于我\n\n- 昨天看了一篇关于海的文章，想起鱼缸。",
  we: "# 我们之间\n\n- 一起听过雨声。",
  topics: [{ title: "台灯", summary: "他说要把台灯修好。" }],
  relationship: { trust: 1, intimacy: 0.5, note: "整理时想起了一些事。" },
};

function okResponse(content = JSON.stringify(reply)) {
  return {
    content,
    toolCalls: [],
    usage: { prompt_tokens: 100, completion_tokens: 60 },
    model: "deepseek-flash",
    finishReason: "stop",
  };
}

let root: string;

function ctx(memory: MemoryStore): ConsolidateContext {
  return {
    config,
    paths: makePaths(root),
    memory,
    emit: vi.fn(),
    onChange: vi.fn(),
  };
}

function writeInbox(p = makePaths(root)): void {
  fs.writeFileSync(path.join(p.memoryInbox, `${day}.md`), "- 他说周末想把台灯修好。\n");
}

function todayTimeline(p = makePaths(root)) {
  const key = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  return readTimeline(p, key);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-consolidate-"));
  ensureLayout(makePaths(root));
  vi.mocked(callLLM).mockReset();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("consolidate outcomes", () => {
  it("reports an empty inbox without touching the model", async () => {
    const p = makePaths(root);
    const memory = new MemoryStore(p, config);
    memory.ensure();
    saveLife(p, { ...loadLife(p), lastConsolidate: "2026-11-19" });

    const result = await consolidateMemory(day, ctx(memory));

    expect(result.ok).toBe(false);
    expect(result.code).toBe("no-inbox");
    expect(result.detail).toContain("2026-11-19");
    expect(callLLM).not.toHaveBeenCalled();
    expect(readConsolidateState(p)).toBeNull();
  });

  it("keeps the old memory and records a model failure", async () => {
    const p = makePaths(root);
    const memory = new MemoryStore(p, config);
    memory.ensure();
    writeInbox(p);
    vi.mocked(callLLM).mockRejectedValue(new Error("网络没连上"));

    const result = await consolidateMemory(day, ctx(memory));

    expect(result).toMatchObject({ ok: false, code: "model-error", detail: "网络没连上" });
    const state = readConsolidateState(p);
    expect(state?.code).toBe("model-error");
    expect(state?.detail).toBe("网络没连上");
    expect(todayTimeline(p).some((event) => event.kind === "error" && event.text.includes("网络没连上"))).toBe(true);
  });

  it("records a parse failure separately", async () => {
    const p = makePaths(root);
    const memory = new MemoryStore(p, config);
    memory.ensure();
    writeInbox(p);
    vi.mocked(callLLM).mockResolvedValue(okResponse("不是 JSON"));

    const result = await consolidateMemory(day, ctx(memory));

    expect(result).toMatchObject({ ok: false, code: "parse-error" });
    expect(readConsolidateState(p)?.code).toBe("parse-error");
  });

  it("archives the inbox and clears the previous failure on success", async () => {
    const p = makePaths(root);
    const memory = new MemoryStore(p, config);
    memory.ensure();
    writeInbox(p);
    fs.writeFileSync(
      path.join(p.state, "consolidate.json"),
      JSON.stringify({ at: Date.now() - 1000, code: "model-error", detail: "旧失败" }),
    );
    vi.mocked(callLLM).mockResolvedValue(okResponse());

    const result = await consolidateMemory(day, ctx(memory));

    expect(result).toEqual({ ok: true, code: "ok" });
    expect(readConsolidateState(p)).toBeNull();
    expect(loadLife(p).lastConsolidate).toBe(day);
    expect(fs.readdirSync(p.memoryInbox).filter((file) => file.endsWith(".md"))).toHaveLength(0);
    expect(fs.existsSync(path.join(p.memoryInbox, "processed", `${day}.md`))).toBe(true);
    expect(todayTimeline(p).some((event) => event.kind === "memory")).toBe(true);
  });

  it("returns busy while another consolidation is running", async () => {
    const p = makePaths(root);
    const memory = new MemoryStore(p, config);
    memory.ensure();
    writeInbox(p);
    let finish!: (value: ReturnType<typeof okResponse>) => void;
    vi.mocked(callLLM).mockImplementationOnce(
      () => new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );

    const first = consolidateMemory(day, ctx(memory));
    const second = await consolidateMemory(day, ctx(memory));
    expect(second).toMatchObject({ ok: false, code: "busy" });

    finish(okResponse());
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);

    const third = await consolidateMemory(day, ctx(memory));
    expect(third.code).toBe("no-inbox");
  });
});
