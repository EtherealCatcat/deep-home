import type { AppConfig, LLMMessage, LLMResult, LLMUsage, ToolCall } from "./types.js";
import { acquireProviderCall, noteProviderFailure, releaseProviderCall, type ProviderTicket } from "./provider.js";

export type LLMFailureKind = "network" | "timeout" | "auth" | "rate" | "server" | "config" | "unknown";

export interface LLMErrorOptions {
  status?: number;
  body?: string;
  code?: string;
  kind?: LLMFailureKind;
  attempts?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class LLMError extends Error {
  readonly status: number;
  readonly body: string;
  code: string;
  kind: LLMFailureKind;
  attempts: number;
  retryAfterMs?: number;

  constructor(message: string, options: LLMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LLMError";
    this.status = options.status ?? 0;
    this.body = options.body ?? "";
    this.code = options.code ?? "";
    this.kind = options.kind ?? "unknown";
    this.attempts = options.attempts ?? 1;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: "auto" | "none";
  json?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 单次调用最多尝试几次（含第一次）。 */
  attempts?: number;
  /** 绕开熔断（连接测试用）。 */
  force?: boolean;
  /** false 时不更新供应商健康状态（连接测试用）。 */
  recordHealth?: boolean;
}

/** 聊天回合：失败得快一点，把重试交给用户。 */
export const CHAT_ATTEMPTS = 2;
export const CHAT_TIMEOUT_MS = 60_000;
/** 自己的时间 / 日记 / 整理：可以多等一会儿。 */
export const BACKGROUND_ATTEMPTS = 5;
export const BACKGROUND_TIMEOUT_MS = 120_000;
/** 心情、整理这类附带调用：一次就够，别拖住主流程。 */
export const SIDE_ATTEMPTS = 1;
export const SIDE_TIMEOUT_MS = 15_000;
export const PROBE_TIMEOUT_MS = 3000;

/** 最近一次失败的模型请求，调试页用它显示原因、时间和重试次数。 */
export interface LLMFailureRecord {
  kind: LLMFailureKind;
  message: string;
  code: string;
  status: number;
  attempts: number;
  at: number;
  model: string;
}

let lastFailure: LLMFailureRecord | null = null;

export function getLastLLMFailure(): LLMFailureRecord | null {
  return lastFailure;
}

export interface ProviderProbeResult {
  reachable: boolean;
  status?: number;
  kind: "ok" | "http" | "unreachable" | "captive";
}

/**
 * 探测供应商端点：拿到任意 HTTP 响应就算网络可达（401/404/5xx 都行）。
 * 200 但不是 JSON 通常是接住了 captive portal，当作不可用。
 * 这个请求不计费、不打印 Key。
 */
export async function probeProviderReachable(
  config: AppConfig,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProviderProbeResult> {
  const base = config.model.baseUrl.trim().replace(/\/+$/, "");
  if (!base) return { reachable: false, kind: "unreachable" };
  try {
    const response = await fetch(`${base}/models`, {
      method: "GET",
      headers: config.model.apiKey.trim() ? { Authorization: `Bearer ${config.model.apiKey}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 200) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) return { reachable: false, status: 200, kind: "captive" };
      return { reachable: true, status: 200, kind: "ok" };
    }
    return { reachable: true, status: response.status, kind: "http" };
  } catch {
    return { reachable: false, kind: "unreachable" };
  }
}

/** @deprecated 用 probeProviderReachable，这里保留给旧调用。 */
export async function probeOnline(config: AppConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return (await probeProviderReachable(config, timeoutMs)).reachable;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function friendlyError(status: number, body: string): string {
  if (status === 401 || status === 403) return "API Key 无效或没有权限。去设置里检查一下。";
  if (status === 402) return "账户余额不足，DeepSeek 拒绝了请求。";
  if (status === 429) return "请求太频繁或额度受限，稍后再试。";
  if (status >= 500) return "模型服务暂时不可用，稍后再试。";
  if (status === 400 || status === 404 || status === 405 || status === 422) {
    return "模型配置有问题，检查 Base URL / 模型名。";
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // ignore
  }
  return body.slice(0, 300) || `请求失败（HTTP ${status}）`;
}

function kindForStatus(status: number): LLMFailureKind {
  if (status === 401 || status === 403 || status === 402) return "auth";
  if (status === 429) return "rate";
  if (status === 400 || status === 404 || status === 405 || status === 422) return "config";
  if (status >= 500) return "server";
  return "unknown";
}

function isRetryable(error: LLMError): boolean {
  return error.kind === "network" || error.kind === "server";
}

/** 429 的 Retry-After 可能是秒数，也可能是 HTTP 日期；封顶 10 分钟。 */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, Math.min(seconds * 1000, 600_000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(1000, Math.min(date - Date.now(), 600_000));
  return undefined;
}

const NETWORK_DETAIL: Record<string, string> = {
  ENOTFOUND: "域名解析失败",
  EAI_AGAIN: "域名解析暂时失败",
  ECONNREFUSED: "连接被拒绝",
  ECONNRESET: "连接被重置",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "网络不可达",
  ENETUNREACH: "网络不可达",
  ENETDOWN: "网络断开",
  EPIPE: "连接中断",
  UND_ERR_CONNECT_TIMEOUT: "连接超时",
  UND_ERR_SOCKET: "连接被断开",
  UND_ERR_CLOSED: "连接被关闭",
  CERT_HAS_EXPIRED: "HTTPS 证书过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "HTTPS 证书不受信任",
  SELF_SIGNED_CERT_IN_CHAIN: "HTTPS 证书不受信任",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "HTTPS 证书无法验证",
  ERR_TLS_CERT_ALTNAME_INVALID: "HTTPS 证书和域名不匹配",
};

/** fetch 的真实原因藏在 error.cause（常常还套着 AggregateError）里，逐层挖出来。 */
function collectCodes(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 5) return [];
  const node = value as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes: string[] = [];
  if (typeof node.code === "string") codes.push(node.code);
  if (Array.isArray(node.errors)) {
    for (const inner of node.errors) codes.push(...collectCodes(inner, depth + 1));
  }
  if (node.cause) codes.push(...collectCodes(node.cause, depth + 1));
  return codes;
}

function networkFailure(error: unknown): LLMError {
  const codes = collectCodes(error);
  const code = codes.find((item) => item in NETWORK_DETAIL) ?? codes[0] ?? "";
  const detail = code ? NETWORK_DETAIL[code] : "";
  return new LLMError(detail ? `网络没连上（${detail}）` : "网络没连上", {
    kind: "network",
    code,
    cause: error,
  });
}

const MAX_ATTEMPTS = 5;

/** 1s / 2s / 4s / 8s，带 ±20% jitter，总计约 15 秒。 */
function retryDelay(attempt: number): number {
  const base = [1000, 2000, 4000, 8000][Math.min(attempt - 1, 3)] ?? 8000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export async function callLLM(
  config: AppConfig,
  messages: LLMMessage[],
  options: LLMOptions = {},
): Promise<LLMResult> {
  const ticket: ProviderTicket | null =
    options.force || options.recordHealth === false ? null : acquireProviderCall();
  if (ticket && !ticket.ok) {
    throw new LLMError("模型服务暂时不可用，稍后再试。", {
      status: 503,
      kind: "server",
      code: "CIRCUIT_OPEN",
      attempts: 0,
    });
  }
  try {
    const result = await requestLLM(config, messages, options);
    releaseProviderCall(ticket, null);
    return result;
  } catch (error) {
    const failure = error instanceof LLMError ? error : new LLMError("模型请求失败。", { cause: error });
    releaseProviderCall(ticket, failure);
    lastFailure = {
      kind: failure.kind,
      message: failure.message,
      code: failure.code,
      status: failure.status,
      attempts: failure.attempts,
      at: Date.now(),
      model: options.model ?? config.model.model,
    };
    console.warn(
      `[llm] ${failure.kind} ${failure.code || "-"} ${failure.message}（第 ${failure.attempts} 次尝试）`,
    );
    throw failure;
  }
}

async function requestLLM(
  config: AppConfig,
  messages: LLMMessage[],
  options: LLMOptions,
): Promise<LLMResult> {
  if (!config.model.apiKey.trim()) {
    throw new LLMError("还没有配置 DeepSeek API Key。打开设置，把 key 填进去。", {
      status: 401,
      kind: "auth",
      code: "NO_API_KEY",
    });
  }
  const model = options.model ?? config.model.model;
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name) out.name = m.name;
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      return out;
    }),
    temperature: options.temperature ?? config.model.temperature,
    max_tokens: options.maxTokens ?? config.behavior.maxOutputTokens,
    stream: false,
  };
  if (config.model.provider === "deepseek" && !config.model.thinking) {
    body.thinking = { type: "disabled" };
  }
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }
  if (options.json) {
    body.response_format = { type: "json_object" };
  }

  const attempts = Math.max(1, options.attempts ?? MAX_ATTEMPTS);
  let lastError: LLMError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(endpoint(config.model.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.model.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new LLMError(friendlyError(response.status, text), {
          status: response.status,
          body: text,
          kind: kindForStatus(response.status),
          code: `HTTP_${response.status}`,
          retryAfterMs:
            response.status === 429 ? retryAfterMs(response.headers.get("retry-after")) : undefined,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LLMError("模型返回的不是合法 JSON。", {
          status: response.status,
          body: text,
          code: "BAD_JSON",
        });
      }
      const root = parsed as {
        choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
        usage?: LLMUsage;
        error?: { message?: string };
      };
      if (root.error?.message) {
        throw new LLMError(root.error.message, { status: response.status, body: text, code: "API_ERROR" });
      }
      const choice = root.choices?.[0];
      const content = choice?.message?.content ?? "";
      const toolCalls = choice?.message?.tool_calls ?? [];
      return {
        content,
        toolCalls,
        usage: root.usage ?? {},
        model,
        finishReason: choice?.finish_reason ?? "stop",
      };
    } catch (error) {
      if (error instanceof LLMError) {
        if (isRetryable(error) && attempt < attempts) {
          lastError = error;
          console.warn(
            `[llm] ${error.kind} ${error.code}，${retryDelay(attempt)}ms 后重试（${attempt}/${attempts - 1}）`,
          );
          await sleep(retryDelay(attempt));
          continue;
        }
        error.attempts = attempt;
        throw error;
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        // 超时不重试：一次请求已经等满了 timeoutMs，重试只会让用户等更久。
        throw new LLMError("模型响应超时。", {
          kind: "timeout",
          code: "TIMEOUT",
          attempts: attempt,
          cause: error,
        });
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new LLMError("请求被取消了。", { code: "ABORT_ERR", attempts: attempt, cause: error });
      }
      const failure = networkFailure(error);
      failure.attempts = attempt;
      lastError = failure;
      if (attempt < attempts) {
        console.warn(
          `[llm] ${failure.code || "network"}，${retryDelay(attempt)}ms 后重试（${attempt}/${attempts - 1}）`,
        );
        await sleep(retryDelay(attempt));
        continue;
      }
    }
  }
  throw lastError ?? new LLMError("模型请求失败。");
}

export async function callJSON<T>(
  config: AppConfig,
  system: string,
  user: string,
  options: Omit<LLMOptions, "json"> = {},
): Promise<T | null> {
  const result = await callLLM(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { ...options, json: true, temperature: 0.2 },
  );
  return parseJSON<T>(result.content);
}

export function parseJSON<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 2));
}

export function trimMessages(messages: LLMMessage[], max: number): LLMMessage[] {
  if (messages.length <= max) return messages;
  return messages.slice(-max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
