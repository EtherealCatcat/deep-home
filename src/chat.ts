import path from "node:path";
import type { AppConfig, ChatMessage, LLMMessage, QuoteRef } from "./types.js";
import type { Paths } from "./config.js";
import { appendJsonl, atomicWrite, exists, listFiles, readJsonl, readText, removeFile, writeJson } from "./store.js";
import { addDays, dayKey, dayStartTs, formatClock } from "./time.js";

let counter = 0;

function newId(prefix: string): string {
  counter = (counter + 1) % 10_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function chatFile(p: Paths, day: string): string {
  return path.join(p.chat, `${day}.jsonl`);
}

export function appendChatMessage(
  p: Paths,
  config: AppConfig,
  input: Omit<ChatMessage, "id" | "ts" | "dayKey"> & { ts?: number },
): ChatMessage {
  const ts = input.ts ?? Date.now();
  const message: ChatMessage = {
    ...input,
    id: newId(input.role),
    ts,
    dayKey: dayKey(ts, config.behavior.rotateHour, config.behavior.timezone),
  };
  appendJsonl(chatFile(p, message.dayKey), message);
  return message;
}

export function readDayMessages(p: Paths, day: string): ChatMessage[] {
  return readJsonl<ChatMessage>(chatFile(p, day));
}

/**
 * 撤销连发：删掉某时刻之后落盘的用户消息（助手消息不动）。
 * 只扫该时刻所在逻辑日及之后的文件；返回删掉的条数。
 */
export function removeUserMessagesSince(p: Paths, config: AppConfig, since: number): number {
  const fromDay = dayKey(since, config.behavior.rotateHour, config.behavior.timezone);
  let removed = 0;
  for (const file of listFiles(p.chat, ".jsonl")) {
    const day = path.basename(file, ".jsonl");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < fromDay) continue;
    const messages = readJsonl<ChatMessage>(file);
    const kept = messages.filter(
      (message) => !(message.role === "user" && typeof message.ts === "number" && message.ts >= since),
    );
    if (kept.length === messages.length) continue;
    removed += messages.length - kept.length;
    if (kept.length === 0) {
      removeFile(file);
    } else {
      atomicWrite(file, kept.map((message) => JSON.stringify(message)).join("\n") + "\n");
    }
  }
  return removed;
}

export function recentMessages(p: Paths, config: AppConfig, limit = 40): ChatMessage[] {
  const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  const days = [addDays(today, -2), addDays(today, -1), today];
  const messages = days.flatMap((day) => readDayMessages(p, day));
  return messages.slice(-limit);
}

export function messagesBefore(p: Paths, config: AppConfig, ts: number, limit = 40): ChatMessage[] {
  const all = recentMessages(p, config, 300).filter((m) => m.ts < ts);
  return all.slice(-limit);
}

export function todayMessageCount(p: Paths, config: AppConfig): number {
  const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  return readDayMessages(p, today).filter((m) => m.role === "user").length;
}

export function todayProactiveCount(p: Paths, config: AppConfig): number {
  const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  return readDayMessages(p, today).filter((m) => m.role === "assistant" && m.meta?.proactive === true).length;
}

export function lastOwnerMessageAt(p: Paths, config: AppConfig): number {
  const messages = recentMessages(p, config, 200);
  const user = [...messages].reverse().find((m) => m.role === "user");
  return user?.ts ?? 0;
}

export function lastAssistantMessageAt(p: Paths, config: AppConfig): number {
  const messages = recentMessages(p, config, 200);
  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  return assistant?.ts ?? 0;
}

export function quoteLine(quote: QuoteRef, config?: AppConfig): string {
  const who = quote.role === "user" ? config?.ownerTitle ?? "主人" : config?.name ?? "鲸鲸";
  const time = formatClock(quote.ts, config?.behavior.timezone ?? "Asia/Shanghai");
  const raw =
    quote.kind === "image"
      ? "[图片]"
      : quote.kind === "sticker"
        ? `[表情] ${quote.text}`
        : quote.text;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  return `（引用 ${who} ${time}：${text || "……"}）`;
}

export function toLLMHistory(messages: ChatMessage[], max: number, config?: AppConfig): LLMMessage[] {
  const visible = messages
    .filter((m) => m.kind === "text" || m.kind === "sticker" || m.kind === "image")
    .slice(-max)
    .map<LLMMessage>((m) => {
      const stickerDesc = typeof m.meta?.desc === "string" ? m.meta.desc : "";
      const body =
        m.kind === "sticker"
          ? `[表情:${m.text}${stickerDesc ? `（${stickerDesc}）` : ""}]`
          : m.kind === "image"
            ? `[图片${m.text && m.text !== "（发来一张图片）" ? `：${m.text}` : ""}]`
            : m.text;
      return {
        role: m.role,
        content: m.quote ? `${quoteLine(m.quote, config)}\n${body}` : body,
      };
    });
  return visible;
}

export function yesterdayDigest(p: Paths, config: AppConfig): string {
  const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  const yesterday = addDays(today, -1);
  const diary = readText(path.join(p.diary, `${yesterday}.md`));
  if (diary.trim()) {
    return diary.trim().slice(0, 1600);
  }
  const messages = readDayMessages(p, yesterday).filter((m) => m.kind === "text");
  if (!messages.length) return "";
  return messages
    .slice(-24)
    .map((m) => `${m.role === "user" ? config.ownerTitle : config.name}：${m.text.replace(/\s+/g, " ").slice(0, 80)}`)
    .join("\n")
    .slice(0, 1600);
}

export function dayTranscriptForDiary(p: Paths, config: AppConfig, day: string, limit = 120): string {
  const messages = readDayMessages(p, day).filter((m) => m.kind === "text");
  return messages
    .slice(-limit)
    .map((m) => `[${formatClock(m.ts, config.behavior.timezone)}] ${m.role === "user" ? config.ownerTitle : config.name}：${m.text.replace(/\s+/g, " ")}`)
    .join("\n");
}

export function todayRange(config: AppConfig): { start: number; end: number } {
  const key = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  const start = dayStartTs(key, config.behavior.rotateHour, config.behavior.timezone);
  return { start, end: start + 86_400_000 };
}

/** Lightweight session metadata; the visible transcript lives in chat/*.jsonl. */
export interface SessionMeta {
  id: string;
  day: string;
  createdAt: number;
  messages: number;
  summary?: string;
}

export function ensureSession(p: Paths, config: AppConfig): SessionMeta {
  const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  const file = path.join(p.sessions, `chat-${today}.json`);
  const meta: SessionMeta = {
    id: `chat-${today}`,
    day: today,
    createdAt: Date.now(),
    messages: readDayMessages(p, today).length,
    summary: yesterdayDigest(p, config),
  };
  if (!exists(file)) writeJson(file, meta);
  return meta;
}

export type RetryPlan =
  | {
      ok: true;
      text: string;
      firstTs: number;
      quote?: QuoteRef;
      image?: { file: string; mime: string };
      count: number;
    }
  | { ok: false; status: number; error: string };

/**
 * 手动重试：取最后一条助手消息之后的用户消息，合成一轮。
 * 只读规划，不落盘——调用方只 enqueue，不 appendChatMessage。
 */
export function planRetry(history: ChatMessage[], historyStart: number): RetryPlan {
  let lastAssistant = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  const tail = history.slice(lastAssistant + 1).filter((message) => message.role === "user");
  if (!tail.length) return { ok: false, status: 400, error: "没有要重试的消息。" };
  if (tail.some((message) => message.kind === "sticker")) {
    return { ok: false, status: 400, error: "表情不好重试，再发一次吧。" };
  }
  if (tail.filter((message) => message.kind === "image").length > 1) {
    return { ok: false, status: 400, error: "一次只能重发一张图片。" };
  }
  const first = tail[0];
  if (first.ts < historyStart) {
    return { ok: false, status: 400, error: "这段已经翻篇了，重新说吧。" };
  }
  const meta = first.meta ?? {};
  const image =
    typeof meta.file === "string" && typeof meta.mime === "string"
      ? { file: meta.file, mime: meta.mime }
      : undefined;
  return {
    ok: true,
    text: tail.map((message) => message.text).join("\n"),
    firstTs: first.ts,
    quote: first.quote,
    image,
    count: tail.length,
  };
}
