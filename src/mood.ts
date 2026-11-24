import type { AppConfig, MoodState } from "./types.js";
import type { Paths } from "./config.js";
import { readJson, writeJson } from "./store.js";
import { logicalDayKey } from "./schedule.js";

export const MOOD_DIMS = [
  "happy",
  "calm",
  "sweet",
  "miss",
  "shy",
  "worry",
  "sad",
  "jealous",
  "angry",
  "bored",
  "heartache",
] as const;

export type MoodDim = (typeof MOOD_DIMS)[number];

const FAST_DIMS = new Set<MoodDim>(["happy", "shy", "sad", "angry", "heartache"]);
const HALF_LIFE_MS = 120 * 60_000;
const FAST_HALF_LIFE_MS = 45 * 60_000;

export function defaultMood(config: AppConfig): MoodState {
  const dims: Record<string, number> = {};
  for (const dim of MOOD_DIMS) dims[dim] = 0;
  return { base: config.mood.base, dims, updatedAt: Date.now(), history: [] };
}

export function loadMood(p: Paths, config: AppConfig): MoodState {
  const file = p.state + "/mood.json";
  const state = readJson<MoodState>(file, defaultMood(config));
  if (!state.dims) state.dims = defaultMood(config).dims;
  for (const dim of MOOD_DIMS) if (typeof state.dims[dim] !== "number") state.dims[dim] = 0;
  if (!Number.isFinite(state.base)) state.base = config.mood.base;
  if (!Array.isArray(state.history)) state.history = [];
  return decay(state, config, Date.now());
}

export function decay(state: MoodState, config: AppConfig, now = Date.now()): MoodState {
  const elapsed = Math.max(0, now - state.updatedAt);
  if (elapsed < 30_000) return state;
  const baseHalf = Math.max(0.5, config.mood.halfLifeHours) * 3_600_000;
  const baseFactor = Math.pow(0.5, elapsed / baseHalf);
  const next: MoodState = {
    ...state,
    base: 50 + (state.base - 50) * baseFactor,
    dims: { ...state.dims },
    updatedAt: now,
  };
  for (const dim of MOOD_DIMS) {
    const half = FAST_DIMS.has(dim) ? FAST_HALF_LIFE_MS : HALF_LIFE_MS;
    next.dims[dim] = state.dims[dim] * Math.pow(0.5, elapsed / half);
  }
  return next;
}

export interface MoodChange {
  delta?: number;
  dims?: Record<string, number>;
  reason?: string;
  source?: string;
}

export function applyMood(state: MoodState, change: MoodChange, config: AppConfig, now = Date.now()): MoodState {
  const decayed = decay(state, config, now);
  const factor = change.source === "chat" ? 0.5 : 1;
  const delta = clamp(change.delta ?? 0, -15, 15) * factor;
  const dims = { ...decayed.dims };
  for (const [key, value] of Object.entries(change.dims ?? {})) {
    if (!(MOOD_DIMS as readonly string[]).includes(key)) continue;
    dims[key] = clamp((dims[key] ?? 0) + clamp(value, -30, 30) * factor, 0, 100);
  }
  const base = clamp(decayed.base + delta, 0, 100);
  const next: MoodState = {
    ...decayed,
    base,
    dims,
    updatedAt: now,
    history: [
      ...decayed.history,
      {
        ts: now,
        base: Math.round(base * 10) / 10,
        dims: { ...dims },
        reason: (change.reason ?? "聊了几句").slice(0, 80),
        source: change.source ?? "chat",
      },
    ].slice(-60),
  };
  return next;
}

export function saveMood(p: Paths, mood: MoodState): void {
  writeJson(p.state + "/mood.json", mood);
}

export function moodSnapshot(p: Paths, config: AppConfig): MoodState {
  return loadMood(p, config);
}

export function moodLabel(mood: MoodState): string {
  if (mood.base >= 78) return "心情很好";
  if (mood.base >= 62) return "心情不错";
  if (mood.base >= 48) return "还算平静";
  if (mood.base >= 34) return "有点低落";
  return "很难过";
}

export function dominantDims(mood: MoodState, limit = 3): { key: string; value: number }[] {
  return Object.entries(mood.dims)
    .filter(([, value]) => value >= 8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, value]) => ({ key, value }));
}

export function heuristicMood(text: string): MoodChange {
  const positive = ["喜欢", "开心", "好耶", "谢谢", "可爱", "厉害", "抱抱", "想你", "爱你", "哈哈"];
  const negative = ["难过", "累", "烦", "生气", "讨厌", "失望", "哭", "疼", "难受", "压力"];
  const miss = ["想你", "好久不见", "在吗", "怎么不理", "等你"];
  let score = 0;
  for (const word of positive) if (text.includes(word)) score += 2;
  for (const word of negative) if (text.includes(word)) score -= 2;
  for (const word of miss) if (text.includes(word)) score += 3;
  const dims: Record<string, number> = {};
  if (score > 0) {
    dims.happy = Math.min(20, score * 3);
    if (text.includes("想你") || text.includes("抱抱")) dims.sweet = 12;
  } else if (score < 0) {
    dims.sad = Math.min(20, -score * 3);
    if (text.includes("累") || text.includes("压力")) dims.heartache = 12;
  } else {
    dims.calm = 4;
  }
  return { delta: clamp(score, -6, 6), dims, reason: "从话里感觉到的", source: "heuristic" };
}

export function moodDeltaFromJson(raw: unknown): MoodChange | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const delta = typeof obj.delta === "number" ? obj.delta : Number(obj.delta);
  if (!Number.isFinite(delta)) return null;
  const dims: Record<string, number> = {};
  if (obj.dims && typeof obj.dims === "object") {
    for (const [key, value] of Object.entries(obj.dims as Record<string, unknown>)) {
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n)) dims[key] = n;
    }
  }
  return {
    delta: clamp(delta, -15, 15),
    dims,
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 80) : "聊了几句",
    source: "chat",
  };
}

export function isPeakMoodDay(config: AppConfig): string {
  return logicalDayKey(config, Date.now());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
