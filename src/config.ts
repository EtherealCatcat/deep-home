import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";
import { clampLifeConfig, validateLifeConfig } from "./schedule.js";

export interface Paths {
  root: string;
  config: string;
  persona: string;
  memory: string;
  memoryInbox: string;
  topics: string;
  diary: string;
  timeline: string;
  chat: string;
  sessions: string;
  state: string;
  web: string;
  stickers: string;
  backups: string;
  logs: string;
  media: string;
}

/** 现行数据目录；`~/.chatbridge` 只在迁移期兜底，下个版本删掉。 */
const HOME_DIR = ".deephome";
const LEGACY_HOME_DIR = ".chatbridge";

export function dataRoot(): string {
  const custom = process.env.DEEPHOME_HOME ?? process.env.CHATBRIDGE_HOME;
  if (custom && custom.trim()) return path.resolve(custom);
  const home = os.homedir();
  const preferred = path.join(home, HOME_DIR);
  const legacy = path.join(home, LEGACY_HOME_DIR);
  if (!fs.existsSync(preferred) && fs.existsSync(legacy)) {
    console.warn(
      `[deephome] 仍在读旧数据目录 ${legacy}；迁移请先退出应用，再执行：mv ~/.chatbridge ~/.deephome`,
    );
    return legacy;
  }
  return preferred;
}

export function paths(root = dataRoot()): Paths {
  return {
    root,
    config: path.join(root, "config.json"),
    persona: path.join(root, "persona.md"),
    memory: path.join(root, "memory"),
    memoryInbox: path.join(root, "memory", "inbox"),
    topics: path.join(root, "memory", "topics"),
    diary: path.join(root, "diary"),
    timeline: path.join(root, "timeline"),
    chat: path.join(root, "chat", "main"),
    sessions: path.join(root, "sessions"),
    state: path.join(root, "state"),
    web: path.join(root, "web"),
    stickers: path.join(root, "stickers"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    media: path.join(root, "media"),
  };
}

export function ensureLayout(p: Paths): void {
  for (const dir of [
    p.root,
    p.memory,
    p.memoryInbox,
    p.topics,
    p.diary,
    p.timeline,
    p.chat,
    p.sessions,
    p.state,
    p.web,
    p.stickers,
    p.backups,
    p.logs,
    p.media,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const DEFAULT_CONFIG: AppConfig = {
  name: "鲸鲸",
  ownerTitle: "主人",
  setupPending: false,
  model: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-flash",
    sideModel: "deepseek-flash",
    temperature: 1.1,
    thinking: false,
  },
  behavior: {
    rotateHour: 5,
    historyMessages: 40,
    historyPeakMessages: 16,
    maxOutputTokens: 800,
    maxOutputTokensPeak: 320,
    maxToolSteps: 6,
    maxToolStepsPeak: 2,
    burstMs: 2200,
    typingCps: 5,
    maxBubbles: 5,
    timezone: "Asia/Shanghai",
  },
  life: {
    sleepMin: 30,
    wakeMin: 8 * 60,
    weekendSleepMin: 90,
    weekendWakeMin: 9 * 60 + 30,
    whenAsleep: "sleepy",
    diaryEnabled: true,
  },
  speak: {
    enabled: true,
    quietMode: "sleep",
    intervalMin: 45,
    chance: 0.3,
    minSilenceMin: 75,
    quietStart: 23 * 60,
    quietEnd: 8 * 60,
    maxPerDay: 5,
    tellOwnerMaxPerDay: 2,
  },
  mood: {
    enabled: true,
    base: 65,
    halfLifeHours: 8,
  },
  cost: {
    dailyBudgetCny: 5,
    peakPolicy: true,
    peakWindows: [
      { start: 9 * 60, end: 12 * 60 },
      { start: 14 * 60, end: 18 * 60 },
    ],
  },
  web: {
    enabled: true,
    ownTimeEnabled: true,
    rssFeeds: ["https://sspai.com/feed", "https://hnrss.org/frontpage"],
  },
  ui: { port: 7788, notificationsEnabled: true },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = deepMerge(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

export function loadConfig(p: Paths): AppConfig {
  ensureLayout(p);
  let raw: unknown = {};
  if (fs.existsSync(p.config)) {
    try {
      raw = JSON.parse(fs.readFileSync(p.config, "utf8"));
    } catch {
      raw = {};
    }
  }
  let config = deepMerge(DEFAULT_CONFIG, raw);
  const clamped = clampLifeConfig(config);
  config = clamped.config;
  let changed = clamped.changed;
  const remaining = validateLifeConfig(config);
  if (remaining.length) {
    config.life = structuredClone(DEFAULT_CONFIG.life);
    changed = true;
    config.life.clampNotice = "旧作息时间无法修正，已回退到默认作息。";
    config.life.clampNoticeAt = Date.now();
    console.warn("[deephome] 作息时间无法修正，已回退到默认作息。");
  } else if (changed) {
    config.life.clampNotice = "旧作息时间不合法，已自动修正到最近的可用值。";
    config.life.clampNoticeAt = Date.now();
    console.warn(
      "[deephome] 作息时间不合法，已自动修正：" +
        config.life.sleepMin +
        " / " +
        config.life.wakeMin +
        " / " +
        config.life.weekendSleepMin +
        " / " +
        config.life.weekendWakeMin,
    );
  }
  if (!config.model.apiKey) {
    config.model.apiKey =
      process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.DEEPHOME_API_KEY ??
      process.env.CHATBRIDGE_API_KEY ??
      "";
  }
  if (!fs.existsSync(p.config) || changed) saveConfig(p, config);
  return config;
}

export function saveConfig(p: Paths, config: AppConfig): void {
  const tmp = `${p.config}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p.config);
  try {
    fs.chmodSync(p.config, 0o600);
  } catch {
    // best effort on filesystems without chmod
  }
}

export function maskConfig(config: AppConfig): AppConfig {
  const cloned = structuredClone(config);
  if (cloned.model.apiKey) {
    cloned.model.apiKey = cloned.model.apiKey.length > 8 ? "••••••••" + cloned.model.apiKey.slice(-4) : "••••••••";
  }
  return cloned;
}
