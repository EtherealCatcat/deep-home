import type { AppConfig, LifeState, LLMMessage, OwnTimeState } from "./types.js";
import type { Paths } from "./config.js";
import type { MemoryStore } from "./memory.js";
import type { ServerEvent } from "./events.js";
import type { ToolContext } from "./tools.js";
import { buildSystem } from "./persona.js";
import { loadLife, saveLife } from "./life.js";
import { loadRoom } from "./room.js";
import { loadRelationship, bumpRelationship } from "./relationship.js";
import { pendingReminders, remindersText } from "./care.js";
import { dayTranscriptBetween } from "./chat.js";
import { appendTimeline, readTimelineBetween, timelineForPromptBetween } from "./timeline.js";
import { addDays, formatClock, weekdayCN } from "./time.js";
import { getSchedule, scheduleDayKey, scheduleDayRange, type Schedule } from "./schedule.js";
import { runToolLoop } from "./agentLoop.js";
import { saveDiary, readDiary } from "./diaryStore.js";

export interface DiaryContext {
  config: AppConfig;
  paths: Paths;
  memory: MemoryStore;
  persona: string;
  emit: (event: ServerEvent) => void;
  onChange: () => void;
}

export interface DiaryTarget {
  day: string;
  wakeAt: number;
  sleepAt: number;
  phase: "pre-sleep" | "backfill";
}

/** 睡前窗口：睡前 60 分钟到睡前 15 分钟。 */
const DIARY_WINDOW_BEFORE_SLEEP_MS = 60 * 60_000;
const DIARY_LATEST_BEFORE_SLEEP_MS = 15 * 60_000;
/** 没写的话，醒来后 6 小时内还能补。 */
const DIARY_BACKFILL_MS = 6 * 60 * 60_000;
const SLOT_GRID_MS = 5 * 60_000;

function clearSlot(life: LifeState): void {
  life.diarySlotAt = 0;
  life.diarySlotDay = "";
  life.diarySlotEndAt = 0;
}

/** 最近一次已经睡下的时刻；跨周末时可能落在两天前。 */
function lastSleepAtBefore(config: AppConfig, schedule: Schedule, now: number): number {
  let latest = 0;
  for (let offset = -2; offset <= 1; offset += 1) {
    const sleepAt = scheduleDayRange(config, addDays(schedule.day, offset)).sleepAt;
    if (sleepAt <= now && sleepAt > latest) latest = sleepAt;
  }
  return latest || schedule.sleepAt;
}

/**
 * 当前该写哪一天的日记。睡前窗口优先；错过就等醒来后 6 小时内补写。
 * 手动写的历史日记走 /api/diary/write 的另一条路径，不受这里限制。
 */
export function diaryTarget(config: AppConfig, life: LifeState, now = Date.now()): DiaryTarget | null {
  if (!config.life.diaryEnabled) return null;
  const schedule = getSchedule(config, now, life);

  // 睡前：只有安排过 slot、且到了 slot 时刻才写。
  if (
    schedule.phase !== "asleep" &&
    life.diarySlotDay === schedule.day &&
    life.diarySlotAt > 0 &&
    now >= life.diarySlotAt &&
    now < schedule.sleepAt &&
    life.lastDiary !== schedule.day
  ) {
    return { day: schedule.day, wakeAt: schedule.wakeAt, sleepAt: schedule.sleepAt, phase: "pre-sleep" };
  }

  // 补写：最近一次睡下之后 6 小时内，且那一夜的日记还空着。
  const lastSleepAt = lastSleepAtBefore(config, schedule, now);
  const lastSleepDay = scheduleDayKey(config, lastSleepAt - 60_000);
  if (now < lastSleepAt || now >= lastSleepAt + DIARY_BACKFILL_MS) return null;
  if (life.lastDiary === lastSleepDay) return null;
  // 同一天的补写失败后要退避，别每个 tick 都重试。
  if (life.diarySlotDay === lastSleepDay && life.diarySlotAt > now) return null;
  const range = scheduleDayRange(config, lastSleepDay);
  return { day: lastSleepDay, wakeAt: range.wakeAt, sleepAt: range.sleepAt, phase: "backfill" };
}

/**
 * 在睡前窗口里挑一个时刻写日记。等自己的时间都结束再写，避免两件事撞车。
 * 只有真正安排（或保持）了 slot 才返回 true。
 */
export function ensureDiarySlot(
  paths: Paths,
  config: AppConfig,
  life: LifeState,
  own: OwnTimeState,
  schedule: Schedule,
  now: number,
  rng: () => number = Math.random,
): boolean {
  if (!config.life.diaryEnabled) return false;
  if (schedule.phase === "asleep") return false;
  if (life.lastDiary === schedule.day) return false;
  if (own.activeUntil > now) return false;
  // 她还有一段自己的时间排在睡前窗口之前，先等它跑完再排日记。
  if (own.nextAt > 0 && own.nextAt < schedule.sleepAt - DIARY_WINDOW_BEFORE_SLEEP_MS) return false;
  if (life.diarySlotDay === schedule.day && life.diarySlotAt > 0 && life.diarySlotAt < schedule.sleepAt) {
    return false;
  }

  const windowStart = Math.max(now, schedule.sleepAt - DIARY_WINDOW_BEFORE_SLEEP_MS);
  const windowEnd = schedule.sleepAt - DIARY_LATEST_BEFORE_SLEEP_MS;
  if (windowEnd <= windowStart) {
    // 已经错过睡前窗口：留个补写标记，醒来后按 backfill 处理。
    life.diarySlotAt = schedule.sleepAt;
    life.diarySlotDay = schedule.day;
    life.diarySlotEndAt = windowEnd;
    saveLife(paths, life);
    return false;
  }

  const spread = Math.max(1, Math.floor((windowEnd - windowStart) / SLOT_GRID_MS));
  const slotAt = windowStart >= now ? windowStart + Math.floor(rng() * spread) * SLOT_GRID_MS : now;
  life.diarySlotAt = Math.min(slotAt, windowEnd - SLOT_GRID_MS);
  life.diarySlotDay = schedule.day;
  life.diarySlotEndAt = windowEnd;
  saveLife(paths, life);
  return true;
}

export async function writeDiary(target: DiaryTarget, ctx: DiaryContext): Promise<boolean> {
  const { config, paths, memory, persona, emit, onChange } = ctx;
  const { day, wakeAt, sleepAt, phase } = target;
  const existing = readDiary(paths, day).trim();
  if (existing) {
    const life = loadLife(paths);
    if (life.lastDiary !== day) {
      life.lastDiary = day;
      clearSlot(life);
      saveLife(paths, life);
    }
    return true;
  }

  const timelineEvents = readTimelineBetween(paths, config, wakeAt, sleepAt);
  const transcript = dayTranscriptBetween(paths, config, wakeAt, sleepAt, 120);
  if (!timelineEvents.length && !transcript.trim()) {
    // 这一天什么也没发生：记成写过，不再反复尝试。
    const life = loadLife(paths);
    life.lastDiary = day;
    clearSlot(life);
    saveLife(paths, life);
    return false;
  }

  const timeline = timelineForPromptBetween(paths, config, wakeAt, sleepAt);
  const relationship = loadRelationship(paths, config);
  const system = buildSystem({
    config,
    kind: "diary",
    memory: memory.prompt(),
    relationship,
    yesterdaySummary: "",
    room: loadRoom(paths),
    persona,
  });
  const reminders = pendingReminders(paths);
  const clock = formatClock(Date.now(), config.behavior.timezone);
  const intro =
    phase === "pre-sleep"
      ? `今天是 ${day}，${weekdayCN(day)}。现在 ${clock}，你准备睡了。`
      : `现在是 ${clock}，补写 ${day}（${weekdayCN(day)}）的日记。那一天已经结束了，不要假装现在还是那个时间。`;
  const user = [
    intro,
    "",
    "## 今天发生的事",
    timeline || "（今天没什么特别的。）",
    "",
    "## 今天和主人的聊天",
    transcript || "（今天没有聊天。）",
    reminders.length ? `\n## 还惦记着\n${remindersText(reminders, config)}` : "",
    "",
    "写今天的日记。用 diary_write 保存，不要只在回复里说。",
    "日记是写给自己看的：今天印象最深的一件事、你对主人的一点新发现、你自己的心情，最后一句是睡前心里话。",
    `第一行写「# ${day} · ${weekdayCN(day)}」，正文 300–800 字，不要分点，不要写成报告。`,
  ].join("\n");

  const messages: LLMMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const toolContext: ToolContext = {
    config,
    paths,
    scene: "diary",
    memory,
    now: Date.now(),
    outbox: [],
  };

  try {
    const result = await runToolLoop({
      config,
      paths,
      messages,
      scene: "diary",
      maxSteps: 4,
      maxTokens: config.behavior.maxOutputTokens,
      toolContext,
      kind: "diary",
    });
    let text = (toolContext.diaryText ?? result.content ?? "").trim();
    if (!text) {
      emit({ type: "error", message: "今天的日记没写出来，待会儿再补。" });
      scheduleRetry(paths, day);
      return false;
    }
    text = text
      .replace(/<[^>]+>/g, "")
      .replace(/^```(?:markdown)?\s*/i, "")
      .replace(/```$/, "")
      .trim();
    if (!text.startsWith("#")) {
      text = `# ${day} · ${weekdayCN(day)}\n\n${text}`;
    }
    saveDiary(paths, config, day, text);
    const life = loadLife(paths);
    life.lastDiary = day;
    clearSlot(life);
    saveLife(paths, life);
    bumpRelationship(paths, config, {
      intimacy: 0.8,
      trust: 0.3,
      milestone: "第一次写日记",
      reason: "写了一篇日记",
    });
    appendTimeline(paths, config, { kind: "diary", text: `写了 ${day} 的日记`, meta: { day } });
    emit({ type: "diary", day });
    emit({ type: "timeline", event: { ts: Date.now(), kind: "diary", text: `写了 ${day} 的日记` } });
    onChange();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "日记写失败了。";
    emit({ type: "error", message });
    scheduleRetry(paths, day);
    return false;
  }
}

function scheduleRetry(paths: Paths, day: string): void {
  const life = loadLife(paths);
  life.diarySlotDay = day;
  life.diarySlotAt = Date.now() + 10 * 60_000;
  saveLife(paths, life);
}

/** 手动指定日期写日记（/api/diary/write）：算出那天的醒来/睡下区间。 */
export function diaryTargetForDay(config: AppConfig, day: string): DiaryTarget {
  const range = scheduleDayRange(config, day);
  return { day, wakeAt: range.wakeAt, sleepAt: range.sleepAt, phase: "backfill" };
}

export function diarySlotSnapshot(life: LifeState) {
  return {
    day: life.diarySlotDay,
    at: life.diarySlotAt,
    end: life.diarySlotEndAt,
  };
}
