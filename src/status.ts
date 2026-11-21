import type { AppConfig } from "./types.js";
import type { Paths } from "./config.js";
import { loadMood, decay, moodLabel } from "./mood.js";
import { getRhythm } from "./rhythm.js";
import { loadRoom } from "./room.js";
import { loadRelationship } from "./relationship.js";
import { loadLife } from "./life.js";
import { costPolicy } from "./pricing.js";
import { todayUsage } from "./usage.js";
import { lastAssistantMessageAt, lastOwnerMessageAt, todayMessageCount, todayProactiveCount } from "./chat.js";
import type { StatusSnapshot } from "./events.js";
import { loadOwn, ownStateSnapshot, recentOwnResult } from "./own.js";
import { providerSnapshot, type ChatError } from "./provider.js";

export function buildStatus(input: {
  config: AppConfig;
  paths: Paths;
  busy: boolean;
  burst: boolean;
  burstCount: number;
  unread: number;
  lastChatError?: ChatError | null;
}): StatusSnapshot {
  const { config, paths, busy, burst, burstCount, unread, lastChatError } = input;
  const now = Date.now();
  const life = loadLife(paths);
  const rhythm = getRhythm(config, life, now);
  const mood = decay(loadMood(paths, config), config, now);
  const room = loadRoom(paths);
  const relationship = loadRelationship(paths, config);
  const usage = todayUsage(paths, config);
  const ownState = loadOwn(paths);
  const own = ownStateSnapshot(ownState, config, now);
  return {
    name: config.name.trim() || "某鱼",
    ownerTitle: config.ownerTitle.trim() || "主人",
    setupRequired: Boolean(config.setupPending),
    busy,
    burst,
    burstCount,
    unread,
    serverTime: now,
    mood,
    moodLabel: moodLabel(mood),
    rhythm: {
      phase: rhythm.phase,
      label: rhythm.label,
      status: rhythm.status,
      sleepAt: rhythm.sleepAt,
      wakeAt: rhythm.wakeAt,
      nextChangeAt: rhythm.nextChangeAt,
      woken: rhythm.woken,
      day: rhythm.day,
      dayType: rhythm.dayType,
    },
    room,
    relationship,
    pricing: costPolicy(config, usage, now),
    usage,
    todayMessages: todayMessageCount(paths, config),
    proactiveToday: todayProactiveCount(paths, config),
    lastOwnerAt: lastOwnerMessageAt(paths, config),
    lastMessageAt: lastAssistantMessageAt(paths, config),
    activity: own.active ? own.label : recentOwnResult(ownState, now) || room.status,
    provider: providerSnapshot(),
    lastChatError: lastChatError ?? undefined,
    own,
  };
}
