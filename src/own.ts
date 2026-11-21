import type { AppConfig, OwnTimeState, PendingCatchUp, PendingShare } from "./types.js";
import type { Paths } from "./config.js";
import { readJson, writeJson } from "./store.js";
import { addDays, dayKey, formatClock, zonedParts, zonedTimeToTs } from "./time.js";
import { isRestDay } from "./holidays.js";
import { isQuietHours } from "./rhythm.js";
import { isPeak } from "./pricing.js";

const WORK_WINDOWS: [number, number][] = [
  [12 * 60 + 10, 13 * 60 + 10],
  [18 * 60 + 20, 20 * 60],
  [20 * 60 + 40, 22 * 60],
];

const REST_WINDOWS: [number, number][] = [
  [10 * 60 + 20, 12 * 60],
  [15 * 60, 17 * 60],
  [20 * 60 + 40, 22 * 60],
];

/** 补跑的年龄上限；超过就丢弃，避免房间/心情/记忆的“当前值”穿帮。 */
export const CATCHUP_HORIZON_MS = 4 * 60 * 60_000;

/** 断网重试退避；实际触发还要等 60 秒的 tick。 */
export const CATCHUP_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** unknown 类失败最多再试 2 次，避免坏请求无限挂起。 */
export const CATCHUP_MAX_UNKNOWN_ATTEMPTS = 2;

export function catchUpBackoff(attempts: number): number {
  const index = Math.max(0, Math.min(CATCHUP_BACKOFF_MS.length - 1, attempts));
  return CATCHUP_BACKOFF_MS[index];
}

export function isInfraFailure(kind?: string): boolean {
  return kind === "network" || kind === "timeout" || kind === "rate" || kind === "server";
}

function ownFile(p: Paths): string {
  return `${p.state}/own.json`;
}

export function defaultOwnTimeState(): OwnTimeState {
  return {
    nextAt: 0,
    windowEnd: 0,
    windowKey: "",
    activeUntil: 0,
    day: "",
    runsToday: 0,
    lastWindowKey: "",
    lastRunAt: 0,
    lastResult: "",
    unread: 0,
    shareDay: "",
    shareCount: 0,
    pendingShares: [],
    retryDay: "",
    pendingCatchUp: null,
    lastCatchUpAt: 0,
    catchUpCount: 0,
    updatedAt: 0,
  };
}

function normalizeShare(item: unknown): PendingShare | null {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { text, ts: 0 } : null;
  }
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<PendingShare>;
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return null;
  const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : 0;
  return { text, ts };
}

function normalizePendingCatchUp(value: unknown): PendingCatchUp | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PendingCatchUp>;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const plannedAt = Number(raw.plannedAt);
  const windowEnd = Number(raw.windowEnd);
  if (!key || !Number.isFinite(plannedAt) || plannedAt <= 0) return null;
  if (!Number.isFinite(windowEnd) || windowEnd <= plannedAt) return null;
  const attempts = Number.isFinite(Number(raw.attempts)) ? Math.max(0, Math.floor(Number(raw.attempts))) : 0;
  const nextRetryAt = Number.isFinite(Number(raw.nextRetryAt)) ? Number(raw.nextRetryAt) : plannedAt;
  const createdAt = Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : plannedAt;
  const kind = raw.lastErrorKind;
  const lastErrorKind =
    kind === "network" || kind === "timeout" || kind === "auth" || kind === "rate" || kind === "server" || kind === "unknown" || kind === "aborted"
      ? kind
      : undefined;
  const lastError = typeof raw.lastError === "string" ? raw.lastError.slice(0, 300) : undefined;
  return { key, plannedAt, windowEnd, attempts, nextRetryAt, lastErrorKind, lastError, createdAt };
}

export function loadOwn(p: Paths): OwnTimeState {
  const raw = readJson<Partial<OwnTimeState>>(ownFile(p), {});
  const shares = Array.isArray(raw.pendingShares) ? raw.pendingShares.map(normalizeShare) : [];
  return {
    ...defaultOwnTimeState(),
    ...raw,
    // 旧版本存的是字符串，读进来时统一成 {text, ts}（ts=0 视为来历不明，稍后丢弃）。
    pendingShares: shares.filter((item): item is PendingShare => Boolean(item)).slice(-6),
    // 坏掉的 pending 会让调度一直卡在一个跑不了的窗口上，宁可直接丢掉。
    pendingCatchUp: normalizePendingCatchUp(raw.pendingCatchUp),
    lastCatchUpAt: Number.isFinite(Number(raw.lastCatchUpAt)) ? Number(raw.lastCatchUpAt) : 0,
    catchUpCount: Number.isFinite(Number(raw.catchUpCount)) ? Number(raw.catchUpCount) : 0,
  };
}

export function saveOwn(p: Paths, state: OwnTimeState): void {
  writeJson(ownFile(p), state);
}

function dayWindows(day: string): [number, number][] {
  return isRestDay(day) ? REST_WINDOWS : WORK_WINDOWS;
}

function tsForMinute(day: string, minute: number, timezone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTimeToTs(year, month, date, Math.floor(minute / 60), minute % 60, timezone);
}

export interface OwnPlan {
  nextAt: number;
  windowEnd: number;
  key: string;
}

/**
 * Pick the next 1–2 own-time slots. Each candidate is skipped with 30% chance,
 * so some days only get one slot and some get none.
 */
export function planOwnWindow(
  config: AppConfig,
  now: number,
  state: OwnTimeState,
  rng: () => number = Math.random,
): OwnPlan | null {
  const baseDay = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
  for (let offset = 0; offset < 4; offset += 1) {
    const day = addDays(baseDay, offset);
    const runs = state.day === day ? state.runsToday : 0;
    if (runs >= 2) continue;
    for (const [startMin, endMin] of dayWindows(day)) {
      const key = `${day}:${startMin}`;
      if (key === state.lastWindowKey) continue;
      const startTs = tsForMinute(day, startMin, config.behavior.timezone);
      const endTs = tsForMinute(day, endMin, config.behavior.timezone);
      if (endTs <= now + 60_000) continue;
      if (rng() < 0.3) continue;

      const earliest = Math.max(startTs, now + 60_000);
      const latest = endTs - 20 * 60_000;
      if (latest < earliest) continue;

      const start = earliest + Math.floor(rng() * (latest - earliest));
      const duration = 20 + Math.floor(rng() * 41);
      return {
        nextAt: start,
        windowEnd: Math.min(endTs, start + duration * 60_000),
        key,
      };
    }
  }
  return null;
}

export function ensureOwnSchedule(
  config: AppConfig,
  now: number,
  current: OwnTimeState,
  rng: () => number = Math.random,
): OwnTimeState {
  const state = current;
  if (!config.web.ownTimeEnabled) {
    state.nextAt = 0;
    state.windowEnd = 0;
    state.activeUntil = 0;
    return state;
  }

  const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
  if (state.day !== today) {
    state.day = today;
    state.runsToday = 0;
    // 分享配额按 shareDay 单独重置：补发可能已经先把 shareDay 推到今天，
    // 这里再清零会把刚记上的次数抹掉，导致早上多发一轮。
    if (state.shareDay !== today) {
      state.shareDay = today;
      state.shareCount = 0;
    }
  }
  if (state.activeUntil && state.activeUntil <= now) state.activeUntil = 0;
  if (state.activeUntil > now) return state;
  if (state.nextAt && state.windowEnd > now) {
    const bad = isPeak(config, state.nextAt) || isQuietHours(config, state.nextAt);
    if (!bad) return state;
    state.nextAt = 0;
    state.windowEnd = 0;
  }

  const plan = planOwnWindow(config, now, state, rng);
  if (plan) {
    state.nextAt = plan.nextAt;
    state.windowEnd = plan.windowEnd;
    state.windowKey = plan.key;
  } else {
    state.nextAt = now + 30 * 60_000;
    state.windowEnd = state.nextAt;
    state.windowKey = "retry";
  }
  state.updatedAt = now;
  return state;
}

export function markOwnStart(state: OwnTimeState, now: number, windowEnd: number): void {
  state.activeUntil = windowEnd;
  state.runsToday += 1;
  state.lastWindowKey = state.windowKey;
  state.nextAt = 0;
  state.updatedAt = now;
}

export function markOwnEnd(state: OwnTimeState, now: number, result: string): void {
  state.activeUntil = 0;
  state.lastRunAt = now;
  state.lastResult = result.replace(/\s+/g, " ").trim().slice(0, 320);
  if (state.lastResult) state.unread = (state.unread ?? 0) + 1;
  state.nextAt = 0;
  state.windowEnd = 0;
  state.windowKey = "";
  state.updatedAt = now;
}

/**
 * 网络之类的基础设施故障不该算她今天已经出过门：退回这次配额，10 分钟后再试一次。
 * 每天只补一次，避免一整天反复重试烧额度。返回是否安排了补跑。
 * @deprecated v1 的离线补跑改用 pendingCatchUp，调度器不再调用它。
 */
export function scheduleOwnRetry(state: OwnTimeState, config: AppConfig, now: number): boolean {
  const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
  if (state.retryDay === today) return false;
  state.retryDay = today;
  state.runsToday = Math.max(0, state.runsToday - 1);
  state.nextAt = now + 10 * 60_000;
  state.windowEnd = state.nextAt + 30 * 60_000;
  state.windowKey = "retry";
  state.updatedAt = now;
  return true;
}

export function ownLabel(state: OwnTimeState, now: number, timezone: string): string {
  if (state.activeUntil > now) return "在过自己的时间";
  if (state.nextAt > now) return `下次 ${formatClock(state.nextAt, timezone)}`;
  return "今天不打算上网";
}

export function resetShareDay(state: OwnTimeState, config: AppConfig, now: number): void {
  const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
  if (state.shareDay !== today) {
    state.shareDay = today;
    state.shareCount = 0;
  }
}

export function canShareNow(state: OwnTimeState, config: AppConfig, now: number): boolean {
  resetShareDay(state, config, now);
  if (state.shareCount >= config.speak.tellOwnerMaxPerDay) return false;
  return !isQuietHours(config, now);
}

export function queueShare(state: OwnTimeState, text: string, ts: number = Date.now()): void {
  const clean = text.trim();
  if (!clean) return;
  if (state.pendingShares.some((item) => item.text === clean)) return;
  state.pendingShares.push({ text: clean, ts });
  state.pendingShares = state.pendingShares.slice(-6);
}

/**
 * 取出今天还能补发的排队分享。队列里的 ts 是“允许发送的时间”（静默结束的早上），
 * 所以跨过逻辑日边界也能发；不属于今天的一律丢掉，避免把几天前的话倒出来。
 * 没有时间戳的旧记录（ts=0）同样丢掉。
 */
export function takeFreshShares(
  state: OwnTimeState,
  config: AppConfig,
  now: number,
): PendingShare[] {
  const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
  const all = state.pendingShares;
  state.pendingShares = [];
  return all.filter(
    (item) => item.ts > 0 && dayKey(item.ts, config.behavior.rotateHour, config.behavior.timezone) === today,
  );
}

/** 最近一次自己时间的结果；太久了就不往聊天/状态里带，避免“刚才”永远是昨天。 */
export function recentOwnResult(state: OwnTimeState, now: number, maxAgeMs: number = 12 * 60 * 60_000): string {
  if (!state.lastResult || !state.lastRunAt) return "";
  if (now - state.lastRunAt > maxAgeMs || state.lastRunAt > now) return "";
  return `刚才${state.lastResult.replace(/\s+/g, " ").trim().slice(0, 60)}`;
}

export function createPendingCatchUp(input: {
  key: string;
  plannedAt: number;
  windowEnd: number;
  now: number;
  attempts?: number;
  nextRetryAt?: number;
  lastErrorKind?: PendingCatchUp["lastErrorKind"];
  lastError?: string;
}): PendingCatchUp {
  const attempts = Math.max(0, Math.floor(input.attempts ?? 0));
  return {
    key: input.key,
    plannedAt: input.plannedAt,
    windowEnd: input.windowEnd,
    attempts,
    nextRetryAt: input.nextRetryAt ?? input.now + catchUpBackoff(attempts),
    lastErrorKind: input.lastErrorKind ?? "network",
    lastError: input.lastError,
    createdAt: input.now,
  };
}

export function clearPendingCatchUp(state: OwnTimeState): void {
  state.pendingCatchUp = null;
}

/** 补跑成功：按计划时刻写结果，实际时刻只用于诊断。 */
export function markCatchUpDone(
  state: OwnTimeState,
  pending: PendingCatchUp,
  summary: string,
  actualNow: number,
): void {
  state.activeUntil = 0;
  state.lastRunAt = pending.plannedAt;
  state.lastResult = summary.replace(/\s+/g, " ").trim().slice(0, 320);
  state.lastWindowKey = pending.key;
  state.unread = (state.unread ?? 0) + 1;
  state.pendingCatchUp = null;
  state.lastCatchUpAt = actualNow;
  state.catchUpCount = (state.catchUpCount ?? 0) + 1;
  state.nextAt = 0;
  state.windowEnd = 0;
  state.windowKey = "";
  state.updatedAt = actualNow;
}

export function pendingCatchUpLabel(state: OwnTimeState, timezone: string): string {
  const pending = state.pendingCatchUp;
  if (!pending) return "";
  return `${formatClock(pending.plannedAt, timezone)} 的窗口，已试 ${pending.attempts} 次`;
}

export function ownStateSnapshot(state: OwnTimeState, config: AppConfig, now: number) {
  return {
    enabled: config.web.ownTimeEnabled,
    active: state.activeUntil > now,
    nextAt: state.nextAt,
    windowEnd: state.windowEnd,
    label: ownLabel(state, now, config.behavior.timezone),
    lastResult: state.lastResult,
    unread: state.unread ?? 0,
    pending: state.pendingCatchUp
      ? {
          plannedAt: state.pendingCatchUp.plannedAt,
          windowEnd: state.pendingCatchUp.windowEnd,
          attempts: state.pendingCatchUp.attempts,
          nextRetryAt: state.pendingCatchUp.nextRetryAt,
          lastErrorKind: state.pendingCatchUp.lastErrorKind,
        }
      : null,
  };
}

export function markOwnSeen(state: OwnTimeState): void {
  state.unread = 0;
  state.updatedAt = Date.now();
}

export function nextOwnWindowLabel(config: AppConfig, now: number, state: OwnTimeState): string {
  if (!config.web.ownTimeEnabled) return "自己的时间关着";
  if (state.activeUntil > now) return "正在过自己的时间";
  if (state.nextAt > now) {
    const day = dayKey(state.nextAt, config.behavior.rotateHour, config.behavior.timezone);
    const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
    const prefix = day === today ? "今天" : day === addDays(today, 1) ? "明天" : day;
    return `${prefix} ${formatClock(state.nextAt, config.behavior.timezone)}`;
  }
  return "还没安排";
}

export function windowTimeLabel(ts: number, timezone: string): string {
  const p = zonedParts(ts, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
