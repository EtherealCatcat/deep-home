import type { AppConfig, LifeState } from "./types.js";
import { addDays, minutesOfDay, nextClockTs, zonedParts, zonedTimeToTs } from "./time.js";
import { dayTypeLabel, isRestDay } from "./holidays.js";

export type Phase = "asleep" | "waking" | "awake" | "sleepy";

/** 一天至少醒 6 小时、最多 20 小时；0 表示“永远不睡”，视为非法。 */
export const MIN_AWAKE_MINUTES = 6 * 60;
export const MAX_AWAKE_MINUTES = 20 * 60;
export const OWN_EARLIEST_AFTER_WAKE_MIN = 30;
export const OWN_LATEST_BEFORE_SLEEP_MIN = 60;
export const DIARY_WINDOW_BEFORE_SLEEP_MIN = 60;
export const DIARY_LATEST_BEFORE_SLEEP_MIN = 15;
export const QUIET_BEFORE_SLEEP_MIN = 30;
export const WAKING_MINUTES = 25;
export const SLEEPY_MINUTES = 90;

export interface Schedule {
  /** 这一次醒来的日期（醒来日）；睡着时是下一次醒来的日期。 */
  day: string;
  wakeAt: number;
  sleepAt: number;
  /** 实际清醒时长（跨 DST 时与分钟数不完全相等）。 */
  awakeMs: number;
  sleepMin: number;
  wakeMin: number;
  isRest: boolean;
  dayType: string;
  phase: Phase;
  nextChangeAt: number;
  woken: boolean;
}

export interface ScheduleIssue {
  field: "sleepMin" | "wakeMin" | "weekendSleepMin" | "weekendWakeMin";
  message: string;
}

export class LifeConfigError extends Error {
  constructor(readonly issues: ScheduleIssue[]) {
    super(issues.map((issue) => issue.message).join("；"));
    this.name = "LifeConfigError";
  }
}

function clockFromMinutes(minutes: number): { hour: number; minute: number } {
  const normalized = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return { hour: Math.floor(normalized / 60), minute: normalized % 60 };
}

function tsAt(day: string, minutes: number, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const clock = clockFromMinutes(minutes);
  return zonedTimeToTs(year, month, date, clock.hour, clock.minute, timeZone);
}

function sleepMinutesFor(config: AppConfig, day: string): number {
  // 睡点看“第二天休不休”：周五晚上按工作日睡，周六晚上才按周末睡。
  return isRestDay(addDays(day, 1)) ? config.life.weekendSleepMin : config.life.sleepMin;
}

function wakeMinutesFor(config: AppConfig, day: string): number {
  return isRestDay(day) ? config.life.weekendWakeMin : config.life.wakeMin;
}

/** 醒来日 day 的清醒区间；睡点若落在醒来之前，就是第二天凌晨。 */
export function scheduleDayRange(config: AppConfig, day: string): { wakeAt: number; sleepAt: number; sleepMin: number; wakeMin: number } {
  const tz = config.behavior.timezone;
  const sleepMin = sleepMinutesFor(config, day);
  const wakeMin = wakeMinutesFor(config, day);
  const wakeAt = tsAt(day, wakeMin, tz);
  let sleepAt = tsAt(day, sleepMin, tz);
  if (sleepAt <= wakeAt) sleepAt = tsAt(addDays(day, 1), sleepMin, tz);
  return { wakeAt, sleepAt, sleepMin, wakeMin };
}

function rangeFor(config: AppConfig, day: string): { wakeAt: number; sleepAt: number; sleepMin: number; wakeMin: number } {
  return scheduleDayRange(config, day);
}

function naturalDay(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * 一条时间轴：醒来日 D 的 wakeAt → sleepAt（通常跨到 D+1 凌晨）。
 * 睡着时 day 是「下一次醒来」的那一天，这样 run 配额和日记都按醒来日算。
 */
export function getSchedule(config: AppConfig, now = Date.now(), life?: LifeState): Schedule {
  const tz = config.behavior.timezone;
  const base = naturalDay(now, tz);
  const days: string[] = [];
  for (let offset = -2; offset <= 2; offset += 1) days.push(addDays(base, offset));

  let found: { day: string; wakeAt: number; sleepAt: number; sleepMin: number; wakeMin: number } | null = null;
  for (const day of days) {
    const range = rangeFor(config, day);
    if (now >= range.wakeAt && now < range.sleepAt) {
      found = { day, ...range };
      break;
    }
  }

  if (found) {
    const awakeMs = found.sleepAt - found.wakeAt;
    let phase: Phase = "awake";
    let nextChangeAt = found.sleepAt;
    if (now < found.wakeAt + WAKING_MINUTES * 60_000) {
      phase = "waking";
      nextChangeAt = found.wakeAt + WAKING_MINUTES * 60_000;
    } else if (found.sleepAt - now <= SLEEPY_MINUTES * 60_000) {
      phase = "sleepy";
      nextChangeAt = found.sleepAt;
    }
    return {
      day: found.day,
      wakeAt: found.wakeAt,
      sleepAt: found.sleepAt,
      awakeMs,
      sleepMin: found.sleepMin,
      wakeMin: found.wakeMin,
      isRest: isRestDay(found.day),
      dayType: dayTypeLabel(found.day),
      phase,
      nextChangeAt,
      woken: Boolean(life && life.wokenAt > 0 && now - life.wokenAt < WAKING_MINUTES * 60_000),
    };
  }

  // 不在任何清醒区间：睡着。找下一次醒来和刚过去的入睡点。
  let next: { day: string; wakeAt: number; sleepAt: number; sleepMin: number; wakeMin: number } | null = null;
  let previousSleepAt = 0;
  for (const day of days) {
    const range = rangeFor(config, day);
    if (range.wakeAt > now && (!next || range.wakeAt < next.wakeAt)) {
      next = { day, ...range };
    }
    if (range.sleepAt <= now && range.sleepAt > previousSleepAt) previousSleepAt = range.sleepAt;
  }
  const nextWake = next ?? { day: addDays(base, 1), ...rangeFor(config, addDays(base, 1)) };
  return {
    day: nextWake.day,
    wakeAt: nextWake.wakeAt,
    sleepAt: nextWake.sleepAt,
    awakeMs: nextWake.sleepAt - nextWake.wakeAt,
    sleepMin: nextWake.sleepMin,
    wakeMin: nextWake.wakeMin,
    isRest: isRestDay(nextWake.day),
    dayType: dayTypeLabel(nextWake.day),
    phase: "asleep",
    nextChangeAt: nextWake.wakeAt,
    woken: Boolean(life && life.wokenAt > 0 && now - life.wokenAt < WAKING_MINUTES * 60_000),
  };
}

/** 醒来日（不是 05:00 逻辑日）。配额、自己的时间、说话次数都按它算。 */
export function scheduleDayKey(config: AppConfig, ts = Date.now()): string {
  return getSchedule(config, ts).day;
}

/** after 之后的下一次醒来时刻。 */
export function nextWakeAt(config: AppConfig, after = Date.now()): number {
  const tz = config.behavior.timezone;
  const base = naturalDay(after, tz);
  for (let offset = -1; offset <= 2; offset += 1) {
    const range = rangeFor(config, addDays(base, offset));
    if (range.wakeAt > after) return range.wakeAt;
  }
  return after + 8 * 60 * 60_000;
}

function awakeMinutes(sleepMin: number, wakeMin: number): number {
  // 从醒点到下一次睡点有多少分钟；睡醒相同表示 24 小时不睡，交给调用方判非法。
  const minutes = ((Math.floor(sleepMin) - Math.floor(wakeMin)) % 1440 + 1440) % 1440;
  return minutes;
}

function awakeIssue(label: string, sleepMin: number, wakeMin: number): ScheduleIssue | null {
  const minutes = awakeMinutes(sleepMin, wakeMin);
  if (minutes === 0) {
    return { field: "wakeMin", message: `${label}的睡点和醒点相同，等于 24 小时不睡。` };
  }
  if (minutes < MIN_AWAKE_MINUTES) {
    return { field: "wakeMin", message: `${label}只醒 ${Math.round((minutes / 60) * 10) / 10} 小时，至少要醒 6 小时。` };
  }
  if (minutes > MAX_AWAKE_MINUTES) {
    return { field: "wakeMin", message: `${label}要醒 ${Math.round((minutes / 60) * 10) / 10} 小时，最多 20 小时。` };
  }
  return null;
}

const COMBOS: { label: string; sleep: "sleepMin" | "weekendSleepMin"; wake: "wakeMin" | "weekendWakeMin" }[] = [
  { label: "工作日", sleep: "sleepMin", wake: "wakeMin" },
  { label: "周五晚到周六", sleep: "sleepMin", wake: "weekendWakeMin" },
  { label: "周六晚到周日", sleep: "weekendSleepMin", wake: "weekendWakeMin" },
  { label: "周日晚到周一", sleep: "weekendSleepMin", wake: "wakeMin" },
];

export function validateLifeConfig(config: AppConfig): ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  for (const combo of COMBOS) {
    const sleep = Number(config.life[combo.sleep]);
    const wake = Number(config.life[combo.wake]);
    if (!Number.isFinite(sleep) || !Number.isFinite(wake) || sleep < 0 || sleep > 1439 || wake < 0 || wake > 1439) {
      issues.push({ field: combo.wake, message: `${combo.label}的作息时间不在 0:00–23:59 之间。` });
      continue;
    }
    const issue = awakeIssue(combo.label, sleep, wake);
    if (issue) issues.push({ field: combo.wake, message: issue.message });
  }
  return issues;
}

export function assertLifeConfig(config: AppConfig): void {
  const issues = validateLifeConfig(config);
  if (issues.length) throw new LifeConfigError(issues);
}

function circularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1440;
  return Math.min(diff, 1440 - diff);
}

function nearestValidWake(current: number, sleeps: number[]): number {
  let best = current;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let minute = 0; minute < 1440; minute += 1) {
    const minutes = awakeMinutes(sleeps[0], minute);
    if (minutes < MIN_AWAKE_MINUTES || minutes > MAX_AWAKE_MINUTES) continue;
    if (sleeps.some((sleep) => {
      const value = awakeMinutes(sleep, minute);
      return value < MIN_AWAKE_MINUTES || value > MAX_AWAKE_MINUTES;
    })) continue;
    const distance = circularDistance(current, minute);
    if (distance < bestDistance) {
      best = minute;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 保留睡点，只把醒点挪到最近的合法值。只动确实越界的那一组醒点，
 * 未受影响的作息原样保留。
 */
export function clampLifeConfig(config: AppConfig): { changed: boolean; config: AppConfig } {
  const next = structuredClone(config);
  let changed = false;
  const wakeFields: { field: "wakeMin" | "weekendWakeMin"; sleeps: ("sleepMin" | "weekendSleepMin")[] }[] = [
    { field: "wakeMin", sleeps: ["sleepMin", "weekendSleepMin"] },
    { field: "weekendWakeMin", sleeps: ["sleepMin", "weekendSleepMin"] },
  ];
  for (const item of wakeFields) {
    const current = Number(next.life[item.field]);
    if (!Number.isFinite(current)) continue;
    const sleeps = item.sleeps.map((key) => Number(next.life[key]));
    if (sleeps.some((value) => !Number.isFinite(value))) continue;
    const compatible = sleeps.every((sleep) => {
      const minutes = awakeMinutes(sleep, current);
      return minutes >= MIN_AWAKE_MINUTES && minutes <= MAX_AWAKE_MINUTES;
    });
    if (compatible) continue;
    const fixed = nearestValidWake(current, sleeps);
    if (fixed !== current) {
      next.life[item.field] = fixed;
      changed = true;
    }
  }
  return { changed, config: next };
}

function inClockWindow(now: number, timeZone: string, start: number, end: number): boolean {
  if (start === end) return false;
  const minutes = minutesOfDay(now, timeZone);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * quiet 默认跟着作息：睡着或睡前 30 分钟都算安静。
 * 切到 manual 才用旧的 quietStart/quietEnd 钟点，方便用户自己调。
 */
export function isQuietHours(config: AppConfig, now = Date.now()): boolean {
  if (config.speak.quietMode === "manual") {
    return inClockWindow(now, config.behavior.timezone, config.speak.quietStart, config.speak.quietEnd);
  }
  const schedule = getSchedule(config, now);
  if (schedule.phase === "asleep") return true;
  return now >= schedule.sleepAt - QUIET_BEFORE_SLEEP_MIN * 60_000;
}

/** 安静结束的时刻；睡点模式落到下一次醒来，手动模式落到 quietEnd。 */
export function quietEndsAt(config: AppConfig, now = Date.now()): number {
  if (!isQuietHours(config, now)) return now;
  if (config.speak.quietMode === "manual") {
    return nextClockTs(now, config.speak.quietEnd, config.behavior.timezone);
  }
  const schedule = getSchedule(config, now);
  // 睡着时 schedule.sleepAt 指向「今晚」的睡点，安静结束其实是下一次醒来。
  if (schedule.phase === "asleep") return schedule.wakeAt;
  return nextWakeAt(config, schedule.sleepAt);
}
