import type { LLMError, LLMFailureKind } from "./llm.js";

export type ProviderState = "ok" | "down" | "auth" | "rate" | "config";

export interface ProviderFailure {
  kind: LLMFailureKind | "probe";
  message: string;
  code?: string;
  status?: number;
  at: number;
  attempts: number;
  model?: string;
}

export interface ProviderSnapshot {
  state: ProviderState;
  label: string;
  detail: string;
  consecutiveFailures: number;
  lastFailure?: ProviderFailure;
  openUntil: number;
  retryAt: number;
  lastProbeAt: number;
  lastProbeOk: boolean;
}

export interface ChatError {
  message: string;
  kind: LLMFailureKind;
  at: number;
  retryable: boolean;
}

export interface ProviderTicket {
  ok: boolean;
  halfOpen: boolean;
  reason?: ProviderState | "half-open";
}

/** 连续失败多少次进入熔断。 */
export const PROVIDER_DOWN_AFTER = 3;
/** 第一次熔断保持多久。 */
export const PROVIDER_OPEN_MS = 60_000;
/** 熔断时长上限。 */
export const PROVIDER_MAX_OPEN_MS = 600_000;
/** 429 没给 Retry-After 时默认等多久。 */
export const PROVIDER_RATE_DEFAULT_MS = 300_000;
export const PROVIDER_PROBE_TIMEOUT_MS = 3000;
export const PROVIDER_HEALTH_ENABLED = true;

let state: ProviderState = "ok";
let consecutiveFailures = 0;
let lastFailure: ProviderFailure | null = null;
let openUntil = 0;
let retryAt = 0;
let lastProbeAt = 0;
let lastProbeOk = false;
let halfOpenInFlight = false;
let cooldownMs = PROVIDER_OPEN_MS;

export function providerLabel(value: ProviderState = state): string {
  switch (value) {
    case "ok":
      return "模型服务正常";
    case "down":
      return "模型服务暂时不可用";
    case "auth":
      return "API Key 或余额有问题";
    case "rate":
      return "模型服务限流中";
    case "config":
      return "模型配置有问题";
  }
}

export function providerDetail(value: ProviderState = state): string {
  switch (value) {
    case "ok":
      return "聊天和后台活动都正常。";
    case "down":
      return "后台活动已暂停；恢复后继续。";
    case "auth":
      return "去设置里检查 Key / 余额。";
    case "rate":
      return "稍后再试。";
    case "config":
      return "检查 Base URL / 模型名。";
  }
}

export function providerSnapshot(): ProviderSnapshot {
  return {
    state,
    label: providerLabel(),
    detail: providerDetail(),
    consecutiveFailures,
    lastFailure: lastFailure ? { ...lastFailure } : undefined,
    openUntil: state === "down" ? openUntil : 0,
    retryAt: state === "rate" ? retryAt : 0,
    lastProbeAt,
    lastProbeOk,
  };
}

export function resetProviderHealth(): void {
  state = "ok";
  consecutiveFailures = 0;
  openUntil = 0;
  retryAt = 0;
  halfOpenInFlight = false;
  cooldownMs = PROVIDER_OPEN_MS;
}

/** 一次真实调用前申请放行；down 到点后只放一个请求去试探。 */
export function acquireProviderCall(force = false): ProviderTicket {
  if (!PROVIDER_HEALTH_ENABLED || force) return { ok: true, halfOpen: false };
  const now = Date.now();
  if (state === "auth" || state === "config") return { ok: false, halfOpen: false, reason: state };
  if (state === "rate") {
    if (now < retryAt) return { ok: false, halfOpen: false, reason: "rate" };
    state = "ok";
    retryAt = 0;
  }
  if (state === "down") {
    if (now < openUntil) return { ok: false, halfOpen: false, reason: "down" };
    if (halfOpenInFlight) return { ok: false, halfOpen: false, reason: "half-open" };
    halfOpenInFlight = true;
    return { ok: true, halfOpen: true };
  }
  return { ok: true, halfOpen: false };
}

export function releaseProviderCall(ticket: ProviderTicket | null, error?: LLMError | null): void {
  if (!ticket) return;
  if (ticket.halfOpen) halfOpenInFlight = false;
  if (error) noteProviderFailure(error);
  else noteProviderSuccess();
}

export function noteProviderSuccess(): void {
  state = "ok";
  consecutiveFailures = 0;
  openUntil = 0;
  retryAt = 0;
  cooldownMs = PROVIDER_OPEN_MS;
  halfOpenInFlight = false;
}

export function noteProviderFailure(error: LLMError): void {
  const now = Date.now();
  lastFailure = {
    kind: error.kind,
    message: error.message,
    code: error.code || undefined,
    status: error.status || undefined,
    at: now,
    attempts: error.attempts,
  };
  if (error.kind === "auth") {
    state = "auth";
    consecutiveFailures = 0;
    openUntil = 0;
    retryAt = 0;
    return;
  }
  if (error.kind === "config") {
    state = "config";
    consecutiveFailures = 0;
    openUntil = 0;
    retryAt = 0;
    return;
  }
  if (error.kind === "rate") {
    state = "rate";
    retryAt = now + Math.min(error.retryAfterMs ?? PROVIDER_RATE_DEFAULT_MS, PROVIDER_MAX_OPEN_MS);
    openUntil = 0;
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= PROVIDER_DOWN_AFTER) {
    state = "down";
    openUntil = now + cooldownMs;
    cooldownMs = Math.min(cooldownMs * 2, PROVIDER_MAX_OPEN_MS);
  }
}

/** 定时探测的结果。只有 down/rate 被 2xx 探活才恢复；可达但 5xx 不算健康。 */
export function noteProviderProbe(ok: boolean, status?: number): void {
  const now = Date.now();
  lastProbeAt = now;
  lastProbeOk = ok;
  if (ok && status !== undefined && status >= 200 && status < 300) {
    if (state === "down" || state === "rate") {
      state = "ok";
      consecutiveFailures = 0;
      openUntil = 0;
      retryAt = 0;
      cooldownMs = PROVIDER_OPEN_MS;
      halfOpenInFlight = false;
    }
    return;
  }
  if (state === "down") {
    lastFailure = {
      kind: "probe",
      message: ok ? `模型服务探测失败（HTTP ${status ?? "?"}）。` : "探测不到模型服务。",
      status: status ?? undefined,
      at: now,
      attempts: 0,
    };
    openUntil = now + cooldownMs;
    cooldownMs = Math.min(cooldownMs * 2, PROVIDER_MAX_OPEN_MS);
  }
}

export function providerRetryAt(): number {
  if (state === "rate") return retryAt;
  if (state === "down") return openUntil;
  return 0;
}

/** 聊天和补跑：ok、down 到点、rate 到点都可试；auth/config 直接拒绝。 */
export function providerAllowsEssential(now = Date.now()): boolean {
  if (!PROVIDER_HEALTH_ENABLED) return true;
  switch (state) {
    case "ok":
      return true;
    case "down":
      return now >= openUntil;
    case "rate":
      return now >= retryAt;
    case "auth":
    case "config":
      return false;
  }
}

/** 后台活动只在完全健康时进行。 */
export function providerAllowsNonEssential(): boolean {
  if (!PROVIDER_HEALTH_ENABLED) return true;
  return state === "ok";
}
