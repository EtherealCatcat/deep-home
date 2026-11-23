export type SceneKind = "chat" | "own" | "diary";

export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type LLMContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LLMMessage {
  role: Role;
  content: string | LLMContentPart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface LLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface LLMResult {
  content: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
  model: string;
  finishReason: string;
}

export interface ModelConfig {
  provider: "deepseek" | "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  sideModel: string;
  temperature: number;
  thinking: boolean;
}

export interface BehaviorConfig {
  rotateHour: number;
  historyMessages: number;
  historyPeakMessages: number;
  maxOutputTokens: number;
  maxOutputTokensPeak: number;
  maxToolSteps: number;
  maxToolStepsPeak: number;
  burstMs: number;
  typingCps: number;
  maxBubbles: number;
  timezone: string;
}

export interface LifeConfig {
  sleepMin: number;
  wakeMin: number;
  weekendSleepMin: number;
  weekendWakeMin: number;
  whenAsleep: "wake" | "sleepy" | "morning";
  diaryEnabled: boolean;
}

export type QuietMode = "sleep" | "manual";

export interface SpeakConfig {
  enabled: boolean;
  /** sleep：跟着作息安静；manual：用 quietStart/quietEnd 钟点。 */
  quietMode: QuietMode;
  intervalMin: number;
  chance: number;
  minSilenceMin: number;
  quietStart: number;
  quietEnd: number;
  maxPerDay: number;
  tellOwnerMaxPerDay: number;
}

export interface MoodConfig {
  enabled: boolean;
  base: number;
  halfLifeHours: number;
}

export interface PeakWindow {
  /** 本地时间，分钟数，0–1439；start > end 表示跨午夜。 */
  start: number;
  end: number;
}

export interface CostConfig {
  dailyBudgetCny: number;
  /** 峰谷计费与降载总开关。 */
  peakPolicy: boolean;
  peakWindows: PeakWindow[];
}

export interface WebConfig {
  enabled: boolean;
  ownTimeEnabled: boolean;
  rssFeeds: string[];
}

export interface AppConfig {
  name: string;
  ownerTitle: string;
  /** 全新安装且尚未保存称呼时为 true；名字用「某鱼」占位。 */
  setupPending: boolean;
  model: ModelConfig;
  behavior: BehaviorConfig;
  life: LifeConfig;
  speak: SpeakConfig;
  mood: MoodConfig;
  cost: CostConfig;
  web: WebConfig;
  ui: { port: number; notificationsEnabled: boolean };
}

export interface QuoteRef {
  id: string;
  role: "user" | "assistant";
  kind: ChatMessage["kind"];
  text: string;
  ts: number;
}

export interface ChatMessage {
  id: string;
  ts: number;
  role: "user" | "assistant";
  kind: "text" | "sticker" | "image" | "monologue" | "silent" | "proactive";
  text: string;
  dayKey: string;
  meta?: Record<string, unknown>;
  quote?: QuoteRef;
}

export interface PendingShare {
  text: string;
  ts: number;
}

export type CatchUpErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "rate"
  | "server"
  | "unknown"
  | "aborted";

/** 断网错过的一次自己的时间；只保留最近一个窗口。 */
export interface PendingCatchUp {
  /** 原窗口 key，形如 "2026-11-21:790"。 */
  key: string;
  /** 原计划开始时刻；叙事、落盘、聊天时间都用它。 */
  plannedAt: number;
  /** 原计划结束时刻。 */
  windowEnd: number;
  /** 已尝试次数（不含最初那次正常窗口的尝试）。 */
  attempts: number;
  /** 下一次允许尝试的实际时间。 */
  nextRetryAt: number;
  lastErrorKind?: CatchUpErrorKind;
  lastError?: string;
  createdAt: number;
}

export interface OwnTimeState {
  nextAt: number;
  windowEnd: number;
  windowKey: string;
  activeUntil: number;
  day: string;
  runsToday: number;
  lastWindowKey: string;
  lastRunAt: number;
  lastResult: string;
  unread: number;
  shareDay: string;
  shareCount: number;
  pendingShares: PendingShare[];
  /** 当天失败后用掉的那次补跑（旧字段，v1 仅保留兼容）。 */
  retryDay?: string;
  /** 唯一一个待补跑的窗口；null / 缺省表示没有。 */
  pendingCatchUp?: PendingCatchUp | null;
  /** 最近一次补跑成功的实际时间，Debug 用。 */
  lastCatchUpAt?: number;
  /** 累计补跑成功次数，Debug 用。 */
  catchUpCount?: number;
  updatedAt: number;
}

export interface TimelineEvent {
  ts: number;
  kind: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: number;
  kind: "owner" | "care";
  status: "pending" | "done" | "cancelled";
  createdAt: number;
  doneAt?: number;
}

export interface MoodState {
  base: number;
  dims: Record<string, number>;
  updatedAt: number;
  history: {
    ts: number;
    base: number;
    dims: Record<string, number>;
    reason: string;
    source: string;
  }[];
}

export interface Relationship {
  firstMet: string;
  daysKnown?: number;
  trust: number;
  intimacy: number;
  streak: number;
  milestones: { date: string; text: string }[];
  updatedAt: number;
}

export interface RoomState {
  name: string;
  status: string;
  detail: string;
  updatedAt: number;
}

export interface LifeState {
  lastTick: number;
  wokenAt: number;
  lastDiary: string;
  lastConsolidate: string;
  lastSpeakAt: number;
  speakCountDay: string;
  speakCount: number;
  lastResumeGapAt: number;
  /** 今天安排写日记的时刻；0 表示还没排。 */
  diarySlotAt: number;
  /** 排的是哪一天（醒来日）。 */
  diarySlotDay: string;
  /** 这个 slot 的有效期；过了就按补写处理。 */
  diarySlotEndAt: number;
}

export interface DeferredTask {
  id: string;
  kind: "diary" | "consolidate" | "own" | "mood";
  runAfter: number;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface UsageDay {
  date: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costCny: number;
  peakCalls: number;
  offPeakCalls: number;
  peakCostCny: number;
  offPeakCostCny: number;
}

export interface Sticker {
  name: string;
  emoji?: string;
  file?: string;
  desc?: string;
  scene?: string;
  addedAt: number;
}

export interface ChatTurnResult {
  bubbles: {
    kind: "text" | "sticker" | "image" | "monologue" | "silent";
    text: string;
    quote?: QuoteRef;
  }[];
  silent: boolean;
  raw: string;
  toolCalls: { name: string; args: unknown }[];
}
