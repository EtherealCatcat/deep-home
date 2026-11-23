import type { AppConfig, OwnTimeState, PendingCatchUp, PendingShare } from "./types.js";
import type { Paths } from "./config.js";
import { readJson, writeJson } from "./store.js";
import { addDays, formatClock, zonedParts } from "./time.js";
import { isQuietHours, scheduleDayKey, type Schedule } from "./schedule.js";
import { isPeak } from "./pricing.js";

/** 补跑的年龄上限；超过就丢弃，避免房间/心情/记忆的“当前值”穿帮。 */
export const CATCHUP_HORIZON_MS = 4 * 60 * 60_000;

/** 断网重试退避；实际触发还要等 60 秒的 tick。 */
export const CATCHUP_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** unknown 类失败最多再试 2 次，避免坏请求无限挂起。 */
export const CATCHUP_MAX_UNKNOWN_ATTEMPTS = 2;

export const OWN_MIN_DURATION_MIN = 20;
export const OWN_MAX_DURATION_MIN = 60;

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

export interface OwnPlan {
  nextAt: number;
  windowEnd: number;
  key: string;
}

const SLOT_GRID_MS = 5 * 60_000;

function randomDuration(rng: () => number): number {
  return OWN_MIN_DURATION_MIN + Math.floor(rng() * (OWN_MAX_DURATION_MIN - OWN_MIN_DURATION_MIN + 1));
}

function startCandidates(from: number, lastStart: number): number[] {
  const list: number[] = [];
  for (let start = Math.ceil(from / SLOT_GRID_MS) * SLOT_GRID_MS; start <= lastStart; start += SLOT_GRID_MS) {
    list.push(start);
  }
  return list;
}

/**
 * 在当天的清醒区间里排 1–2 段自己的时间。
 * 第一段必排（可以在峰时跑一次，受预算约束）；第二段 50% 概率，且不再挑峰时。
 */
export function planOwnWindow(
  config: AppConfig,
  now: number,
  state: OwnTimeState,
  schedule: Schedule,
  rng: () => number = Math.random,
): OwnPlan | null {
  if (schedule.phase === "asleep") return null;
  if (state.runsToday >= 2) return null;

  const earliestBase = Math.max(schedule.wakeAt + 30 * 60_000, now + 60_000);
  const earliest = state.runsToday === 0 ? earliestBase : Math.max(earliestBase, (state.lastRunAt || 0) + 30 * 60_000);
  const latestEnd = schedule.sleepAt - 60 * 60_000;
  if (latestEnd <= earliest) return null;

  const duration = randomDuration(rng);
  const latestStart = latestEnd - duration * 60_000;
  if (latestStart < earliest) return null;

  // 第一段必排；第二段有一半概率跳过。
  if (state.runsToday >= 1 && rng() > 0.5) return null;

  const candidates = startCandidates(earliest, latestStart);
  const offPeak = candidates.filter(
    (start) => !isPeak(config, start) && !isPeak(config, start + duration * 60_000),
  );
  let chosen: number;
  if (offPeak.length) {
    chosen = offPeak[Math.floor(rng() * offPeak.length)];
  } else if (state.runsToday === 0) {
    // 实在没有非峰空隙，第一段允许在峰时跑一次（6.2B）。
    chosen = candidates[Math.floor(rng() * candidates.length)] ?? earliest;
  } else {
    return null;
  }

  return {
    nextAt: chosen,
    windowEnd: Math.min(schedule.sleepAt, chosen + duration * 60_000),
    key: `${schedule.day}:${formatClock(chosen, config.behavior.timezone)}`,
  };
}

function clearWindow(state: OwnTimeState): void {
  state.nextAt = 0;
  state.windowEnd = 0;
  state.windowKey = "";
}

function resetDay(state: OwnTimeState, day: string): void {
  state.day = day;
  state.runsToday = 0;
  state.nextAt = 0;
  state.windowEnd = 0;
  state.windowKey = "";
  state.activeUntil = 0;
  state.retryDay = "";
  // 分享配额按 scheduleDay 单独重置：补发可能已经先把 shareDay 推到今天，
  // 这里再清零会把刚记上的次数抹掉，导致早上多发一轮。
  if (state.shareDay !== day) {
    state.shareDay = day;
    state.shareCount = 0;
  }
}

/**
 * 把状态推进到“现在该有的样子”：换日、清过期、必要时排下一段。
 * 已排的窗口只要还在 [醒来, 睡前 1 小时) 且不撞安静时段就保留，不再因为峰时被清掉。
 */
export function ensureOwnSchedule(
  config: AppConfig,
  now: number,
  current: OwnTimeState,
  schedule: Schedule,
  rng: () => number = Math.random,
): OwnTimeState {
  const state = current;
  if (!config.web.ownTimeEnabled) {
    clearWindow(state);
    state.activeUntil = 0;
    state.updatedAt = now;
    return state;
  }

  if (state.day !== schedule.day) resetDay(state, schedule.day);

  if (schedule.phase === "asleep" || now < schedule.wakeAt || now >= schedule.sleepAt) {
    if (state.activeUntil <= now) state.activeUntil = 0;
    if (state.nextAt || state.windowEnd) clearWindow(state);
    state.updatedAt = now;
    return state;
  }

  if (state.activeUntil > now) return state;

  const latestNext = schedule.sleepAt - 60 * 60_000;
  const planned = state.nextAt > 0 && state.windowEnd > now && state.nextAt >= schedule.wakeAt && state.nextAt <= latestNext;
  if (planned && !isQuietHours(config, state.nextAt)) {
    state.updatedAt = now;
    return state;
  }
  clearWindow(state);

  if (state.runsToday >= 2) {
    state.updatedAt = now;
    return state;
  }

  const plan = planOwnWindow(config, now, state, schedule, rng);
  if (plan) {
    state.nextAt = plan.nextAt;
    state.windowEnd = plan.windowEnd;
    state.windowKey = plan.key;
  }
  state.updatedAt = now;
  return state;
}

/**
 * 保存新作息后立即把 own 状态收敛到新时间轴：
 * 正在进行的这段不打断；没在进行的，清掉旧计划并按新作息重排。
 * 配额（runsToday/shareCount）不重置，跨醒来日才由 resetDay 处理。
 */
export function reconcileOwnAfterScheduleChange(
  p: Paths,
  config: AppConfig,
  now: number,
  schedule: Schedule,
): OwnTimeState {
  const state = loadOwn(p);
  if (state.activeUntil > now) {
    state.updatedAt = now;
    saveOwn(p, state);
    return state;
  }
  clearWindow(state);
  state.updatedAt = now;
  const next = ensureOwnSchedule(config, now, state, schedule);
  saveOwn(p, next);
  return next;
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

/** 一次没能真正出门的尝试：把配额退回来，清掉 active 痕迹。 */
export function rollbackOwnStart(p: Paths, reason: string): OwnTimeState {
  const state = loadOwn(p);
  state.activeUntil = 0;
  state.runsToday = Math.max(0, state.runsToday - 1);
  state.updatedAt = Date.now();
  if (reason) console.warn(`[own] rollback: ${reason}`);
  saveOwn(p, state);
  return state;
}

export function ownLabel(state: OwnTimeState, now: number, timezone: string): string {
  if (state.activeUntil > now) return "在过自己的时间";
  if (state.nextAt > now) return `下次 ${formatClock(state.nextAt, timezone)}`;
  return "今天不打算上网";
}

export function resetShareDay(state: OwnTimeState, config: AppConfig, now: number): void {
  const today = scheduleDayKey(config, now);
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
 * 取出今天还能补发的排队分享。队列里的 ts 是“允许发送的时间”（安静结束的早上），
 * 所以跨过旧逻辑日边界也能发；不属于今天的一律丢掉，避免把几天前的话倒出来。
 * 没有时间戳的旧记录（ts=0）同样丢掉。
 */
export function takeFreshShares(
  state: OwnTimeState,
  config: AppConfig,
  now: number,
): PendingShare[] {
  const today = scheduleDayKey(config, now);
  const all = state.pendingShares;
  state.pendingShares = [];
  return all.filter((item) => item.ts > 0 && scheduleDayKey(config, item.ts) === today);
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
    const day = scheduleDayKey(config, state.nextAt);
    const today = scheduleDayKey(config, now);
    const prefix = day === today ? "今天" : day === addDays(today, 1) ? "明天" : day;
    return `${prefix} ${formatClock(state.nextAt, config.behavior.timezone)}`;
  }
  return "还没安排";
}

export function windowTimeLabel(ts: number, timezone: string): string {
  const p = zonedParts(ts, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
