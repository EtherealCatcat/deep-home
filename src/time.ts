const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function zonedParts(ts: number, timeZone = "Asia/Shanghai"): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function dateKeyOfParts(p: Pick<ZonedParts, "year" | "month" | "day">): string {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function dayKey(ts = Date.now(), rotateHour = 5, timeZone = "Asia/Shanghai"): string {
  return dateKeyOfParts(zonedParts(ts - rotateHour * 3_600_000, timeZone));
}

export function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function weekdayOf(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

export function isWeekendKey(key: string): boolean {
  const w = weekdayOf(key);
  return w === 0 || w === 6;
}

/** Convert a wall-clock time in a time zone into a unix timestamp. */
export function zonedTimeToTs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = "Asia/Shanghai",
): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = desired - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function dayStartTs(day: string, rotateHour = 5, timeZone = "Asia/Shanghai"): number {
  const [y, m, d] = day.split("-").map(Number);
  return zonedTimeToTs(y, m, d, rotateHour, 0, timeZone);
}

export function minutesOfDay(ts = Date.now(), timeZone = "Asia/Shanghai"): number {
  const p = zonedParts(ts, timeZone);
  return p.hour * 60 + p.minute;
}

export function formatClock(ts = Date.now(), timeZone = "Asia/Shanghai"): string {
  const p = zonedParts(ts, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function formatDateTime(ts = Date.now(), timeZone = "Asia/Shanghai"): string {
  const p = zonedParts(ts, timeZone);
  return `${dateKeyOfParts(p)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"];

export function weekdayCN(day: string): string {
  return `周${WEEKDAY_CN[weekdayOf(day)]}`;
}

export function periodLabel(minutes: number): string {
  if (minutes < 5 * 60) return "凌晨";
  if (minutes < 8 * 60) return "清早";
  if (minutes < 11 * 60) return "上午";
  if (minutes < 13 * 60) return "中午";
  if (minutes < 17 * 60) return "下午";
  if (minutes < 19 * 60) return "傍晚";
  if (minutes < 23 * 60) return "晚上";
  return "深夜";
}

export function parseClock(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** 下一个 "HH:MM" 或当天分钟数（如 480）的时间戳；已经过了就是明天。 */
export function nextClockTs(now: number, clock: string | number, timeZone = "Asia/Shanghai"): number {
  const parsed =
    typeof clock === "number"
      ? clock >= 0 && clock < 24 * 60
        ? { hour: Math.floor(clock / 60), minute: clock % 60 }
        : null
      : parseClock(clock);
  if (!parsed) return now;
  const p = zonedParts(now, timeZone);
  const todayTs = zonedTimeToTs(p.year, p.month, p.day, parsed.hour, parsed.minute, timeZone);
  if (todayTs > now) return todayTs;
  const [year, month, day] = addDays(dateKeyOfParts(p), 1).split("-").map(Number);
  return zonedTimeToTs(year, month, day, parsed.hour, parsed.minute, timeZone);
}

export function humanGap(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟前` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export function humanDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}
