import path from "node:path";
import type { AppConfig, TimelineEvent } from "./types.js";
import type { Paths } from "./config.js";
import { appendJsonl, listFiles, readJsonl } from "./store.js";
import { addDays, dayKey, formatClock, weekdayCN } from "./time.js";

export function timelineFile(p: Paths, day: string): string {
  return path.join(p.timeline, `${day}.jsonl`);
}

export function appendTimeline(p: Paths, config: AppConfig, event: Omit<TimelineEvent, "ts"> & { ts?: number }): void {
  const ts = event.ts ?? Date.now();
  appendJsonl(timelineFile(p, dayKey(ts, config.behavior.rotateHour, config.behavior.timezone)), {
    ...event,
    ts,
  });
}

export function readTimeline(p: Paths, day: string): TimelineEvent[] {
  // 补跑会按计划时刻把事件写进已有文件，按 ts 排一下才知道先后。
  return readJsonl<TimelineEvent>(timelineFile(p, day)).sort((a, b) => a.ts - b.ts);
}

const HIDDEN_KINDS = new Set(["resume_gap"]);
const CHAT_GROUP_GAP = 30 * 60_000;

function chatChars(events: TimelineEvent[]): number {
  return events.reduce((sum, event) => {
    const fromMeta = event.meta?.chars;
    if (typeof fromMeta === "number" && Number.isFinite(fromMeta)) {
      return sum + Math.max(0, fromMeta);
    }
    const match = /(\d+)\s*字/.exec(event.text);
    return sum + (match ? Number(match[1]) : 0);
  }, 0);
}

export function groupTimelineEvents(events: TimelineEvent[], config: AppConfig): TimelineEvent[] {
  const result: TimelineEvent[] = [];
  let group: TimelineEvent[] = [];

  const flush = () => {
    if (!group.length) return;
    const turns = group.length;
    const chars = chatChars(group);
    const last = group[group.length - 1];
    const text = `和${config.ownerTitle}聊了 ${turns} 轮${chars > 0 ? `，约 ${chars} 字` : ""}`;
    result.push({ ts: last.ts, kind: "chat", text });
    group = [];
  };

  for (const event of events) {
    if (HIDDEN_KINDS.has(event.kind)) continue;
    if (event.kind === "chat") {
      if (group.length && event.ts - group[group.length - 1].ts > CHAT_GROUP_GAP) flush();
      group.push(event);
      continue;
    }
    flush();
    result.push(event);
  }
  flush();
  return result;
}

export function readTimelineForDisplay(p: Paths, config: AppConfig, day: string): TimelineEvent[] {
  return groupTimelineEvents(readTimeline(p, day), config);
}

const LABELS: Record<string, string> = {
  chat: "聊天",
  tell: "主动说话",
  read: "读东西",
  note: "笔记",
  room: "房间",
  mood: "心情",
  remind: "提醒",
  sleep: "睡着",
  wake: "醒来",
  diary: "日记",
  speak: "想你",
  web: "上网",
  bili: "刷视频",
  own: "自己的时间",
  resume_gap: "电脑睡了",
  memory: "记忆",
};

export function timelineSummary(
  p: Paths,
  config: AppConfig,
  day: string,
  limit = 14,
  before = Number.POSITIVE_INFINITY,
): string {
  const events = readTimelineForDisplay(p, config, day).filter((event) => event.ts <= before);
  if (!events.length) return "今天还没发生什么。";
  const lines = events.slice(-limit).map((event) => {
    const label = LABELS[event.kind] ?? event.kind;
    return `${formatClock(event.ts, config.behavior.timezone)} ${label}：${event.text}`;
  });
  return lines.join("\n");
}

export function timelineForPrompt(p: Paths, config: AppConfig, day: string): string {
  const events = readTimelineForDisplay(p, config, day);
  if (!events.length) return "（今天还很安静。）";
  return events
    .slice(-24)
    .map((event) => `${formatClock(event.ts, config.behavior.timezone)} ${event.text}`)
    .join("\n");
}

/** 某段时间里的事件；跨旧逻辑日读取，再按 ts 过滤排序。 */
export function readTimelineBetween(
  p: Paths,
  config: AppConfig,
  startTs: number,
  endTs: number,
): TimelineEvent[] {
  const first = dayKey(startTs, config.behavior.rotateHour, config.behavior.timezone);
  const last = dayKey(endTs, config.behavior.rotateHour, config.behavior.timezone);
  const events: TimelineEvent[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    events.push(...readTimeline(p, day));
  }
  return events
    .filter((event) => event.ts >= startTs && event.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
}

export function timelineForPromptBetween(
  p: Paths,
  config: AppConfig,
  startTs: number,
  endTs: number,
): string {
  const events = groupTimelineEvents(readTimelineBetween(p, config, startTs, endTs), config);
  if (!events.length) return "（今天还很安静。）";
  return events
    .slice(-24)
    .map((event) => `${formatClock(event.ts, config.behavior.timezone)} ${event.text}`)
    .join("\n");
}

export function timelineDays(p: Paths, limit = 30): string[] {
  return listFiles(p.timeline, ".jsonl")
    .map((file) => path.basename(file, ".jsonl"))
    .sort()
    .reverse()
    .slice(0, limit);
}

export function dayHeading(day: string, config: AppConfig): string {
  return `${day} ${weekdayCN(day)}`;
}
