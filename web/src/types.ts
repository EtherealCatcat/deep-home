export type Page =
  | "chat"
  | "today"
  | "memory"
  | "diary"
  | "persona"
  | "growth"
  | "settings"
  | "debug";

export interface Price {
  hit: number;
  miss: number;
  output: number;
}

export interface ModelPrices {
  key: string;
  label: string;
  offPeak: Price;
  peak: Price;
}

export interface PeakWindow {
  start: number;
  end: number;
}

export interface PeakInfo {
  enabled: boolean;
  isPeak: boolean;
  label: string;
  nextChangeAt: number;
  nextIsPeak: boolean;
  peakWindow: string;
}

export interface CostPolicy {
  peakEnabled: boolean;
  isPeak: boolean;
  peakLabel: string;
  nextChangeAt: number;
  maxOutputTokens: number;
  historyMessages: number;
  maxToolSteps: number;
  allowProactive: boolean;
  allowSideCalls: boolean;
  allowDiary: boolean;
  allowConsolidation: boolean;
  allowOwnTime: boolean;
  allowWeb: boolean;
  budgetState: "ok" | "tight" | "exhausted";
  budgetLeftCny: number;
  reason: string;
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

export type Phase = "asleep" | "waking" | "awake" | "sleepy";

export type ProviderState = "ok" | "down" | "auth" | "rate" | "config";

export interface ProviderFailure {
  kind: "network" | "timeout" | "auth" | "rate" | "server" | "config" | "unknown" | "probe";
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
  kind: "network" | "timeout" | "auth" | "rate" | "server" | "config" | "unknown";
  at: number;
  retryable: boolean;
}

export interface Status {
  name: string;
  ownerTitle: string;
  setupRequired: boolean;
  busy: boolean;
  burst: boolean;
  burstCount: number;
  unread: number;
  serverTime: number;
  mood: MoodState;
  moodLabel: string;
  rhythm: {
    phase: Phase;
    label: string;
    status: string;
    sleepAt: number;
    wakeAt: number;
    nextChangeAt: number;
    woken: boolean;
    day: string;
    dayType: string;
  };
  room: RoomState;
  relationship: Relationship;
  pricing: CostPolicy;
  usage: UsageDay;
  todayMessages: number;
  proactiveToday: number;
  lastOwnerAt: number;
  lastMessageAt: number;
  activity: string;
  provider: ProviderSnapshot;
  lastChatError?: ChatError;
  own: {
    enabled: boolean;
    active: boolean;
    nextAt: number;
    windowEnd: number;
    label: string;
    lastResult: string;
    unread: number;
  };
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

export type ServerEvent =
  | { type: "status"; status: Status }
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; on: boolean }
  | { type: "read"; at: number }
  | { type: "mood"; mood: MoodState }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string; kind?: string; retryable?: boolean; at?: number }
  | { type: "done"; turnId: string }
  | { type: "diary"; day: string }
  | { type: "burst_cancel"; from: number };

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

export interface DiaryMeta {
  day: string;
  title: string;
  preview: string;
}

export interface MemorySnapshot {
  owner: string;
  me: string;
  we: string;
  topics: { title: string; content: string }[];
  inbox: string[];
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

export interface Sticker {
  name: string;
  emoji?: string;
  file?: string;
  desc?: string;
  scene?: string;
  addedAt: number;
}

export interface AvatarInfo {
  custom: boolean;
  url: string;
  updatedAt: number;
  mime?: string;
}

export interface AppConfig {
  name: string;
  ownerTitle: string;
  setupPending: boolean;
  model: ModelConfig;
  behavior: {
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
  };
  life: {
    sleepMin: number;
    wakeMin: number;
    weekendSleepMin: number;
    weekendWakeMin: number;
    whenAsleep: "wake" | "sleepy" | "morning";
    diaryEnabled: boolean;
  };
  speak: {
    enabled: boolean;
    intervalMin: number;
    chance: number;
    minSilenceMin: number;
    quietStart: number;
    quietEnd: number;
    maxPerDay: number;
    tellOwnerMaxPerDay: number;
  };
  mood: { enabled: boolean; base: number; halfLifeHours: number };
  cost: { dailyBudgetCny: number; peakPolicy: boolean; peakWindows: PeakWindow[] };
  web: { enabled: boolean; ownTimeEnabled: boolean; rssFeeds: string[] };
  ui: { port: number; notificationsEnabled: boolean };
}

export interface SettingsPayload {
  config: AppConfig;
  root: string;
  pricing: PeakInfo;
  prices: Record<string, ModelPrices>;
  modelOptions: { value: string; label: string }[];
}

export type ConsolidateCode =
  | "ok"
  | "no-inbox"
  | "no-diary"
  | "model-error"
  | "parse-error"
  | "busy";

export interface ConsolidateOutcome {
  ok: boolean;
  code: ConsolidateCode;
  detail?: string;
}

export interface ConsolidateFailureState {
  at: number;
  code: ConsolidateCode;
  detail?: string;
}

export interface DebugPayload {
  version: string;
  status: Status;
  life: Record<string, unknown>;
  own: Record<string, unknown>;
  deferred: unknown[];
  memory: {
    inboxCount: number;
    lastConsolidate: string | null;
    lastError: ConsolidateFailureState | null;
  };
  usage: UsageDay;
  timeline: TimelineEvent[];
  lastTurn: {
    at: number;
    system: string;
    nowBlock: string;
    history: unknown[];
    raw: string;
    toolCalls: unknown[];
    bubbles: unknown[];
    silent: boolean;
  } | null;
  lastLlmError: {
    kind: "network" | "timeout" | "auth" | "rate" | "server" | "config" | "unknown";
    message: string;
    code: string;
    status: number;
    attempts: number;
    at: number;
    model: string;
  } | null;
  provider: ProviderSnapshot;
  config: AppConfig;
}
