import fs from "node:fs";
import path from "node:path";
import type { AppConfig, Relationship } from "./types.js";
import type { Paths } from "./config.js";
import { readJson, readJsonl, writeJson, listFiles } from "./store.js";
import { addDays, formatClock } from "./time.js";
import { logicalDayKey, logicalDayRange } from "./schedule.js";
import { messagesBetween } from "./chat.js";
import type { ChatMessage } from "./types.js";
import { daysSince } from "./persona.js";

/** 信任/亲密涨到这些档位时自动记一笔，文案里带数字，按 text 去重。 */
const MILESTONE_STEPS = [60, 80, 90];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function defaultRelationship(config: AppConfig): Relationship {
  const today = logicalDayKey(config, Date.now());
  return {
    firstMet: today,
    daysKnown: 1,
    trust: 50,
    intimacy: 30,
    streak: 0,
    // 不预置「第一次说话」：等第一条用户消息真正落盘时再记，日期才准确。
    milestones: [],
    updatedAt: Date.now(),
  };
}

export function loadRelationship(p: Paths, config: AppConfig): Relationship {
  const state = readJson<Relationship>(p.state + "/relationship.json", defaultRelationship(config));
  if (!state.firstMet) state.firstMet = logicalDayKey(config, Date.now());
  state.daysKnown = daysSince(state.firstMet, config);
  if (!Array.isArray(state.milestones)) state.milestones = [];
  return state;
}

export function saveRelationship(p: Paths, relationship: Relationship): void {
  writeJson(p.state + "/relationship.json", relationship);
}

export interface RelationshipBump {
  trust?: number;
  intimacy?: number;
  milestone?: string;
  /** 补录历史事件时指定日期（YYYY-MM-DD），缺省用当天。 */
  date?: string;
  reason?: string;
}

export function bumpRelationship(p: Paths, config: AppConfig, bump: RelationshipBump): Relationship {
  const state = loadRelationship(p, config);
  const next: Relationship = {
    ...state,
    milestones: state.milestones.slice(),
    trust: clamp(state.trust + (bump.trust ?? 0), 0, 100),
    intimacy: clamp(state.intimacy + (bump.intimacy ?? 0), 0, 100),
    updatedAt: Date.now(),
  };
  const date = bump.date ?? logicalDayKey(config, Date.now());
  if (bump.milestone) pushMilestone(next, bump.milestone, date);
  for (const step of MILESTONE_STEPS) {
    if (state.trust < step && next.trust >= step) pushMilestone(next, `信任到了 ${step}`, date);
    if (state.intimacy < step && next.intimacy >= step) pushMilestone(next, `亲密到了 ${step}`, date);
  }
  next.daysKnown = daysSince(next.firstMet, config);
  saveRelationship(p, next);
  return next;
}

/** 记一笔成长记号；同文案只留第一次，重复调用不会产生重复条目。 */
export function addMilestone(p: Paths, config: AppConfig, text: string, date?: string): Relationship {
  return bumpRelationship(p, config, { milestone: text, ...(date ? { date } : {}) });
}

/**
 * 首条用户消息落盘后调用：把 firstMet 校正为真正第一次聊天的日子，并记「第一次说话」。
 * 幂等；老数据里种子记号的错误日期（首次启动日）也会在这里被纠正。
 */
export function recordFirstChat(p: Paths, config: AppConfig): Relationship {
  const state = loadRelationship(p, config);
  const earliest =
    earliestChatDay(p, config) ?? logicalDayKey(config, Date.now());
  const changed = setMilestoneDate(state, "第一次说话", earliest) || state.firstMet !== earliest;
  state.firstMet = earliest;
  if (!changed) return state;
  state.daysKnown = daysSince(state.firstMet, config);
  state.updatedAt = Date.now();
  saveRelationship(p, state);
  return state;
}

export interface BackfillResult {
  added: number;
  relationship: Relationship;
}

/**
 * 按真实历史补录老数据的记号：第一次说话 / 写日记 / 整理记忆 / 自己出门。
 * 按 text 去重，重复调用不产生重复条目。
 */
export function backfillMilestones(p: Paths, config: AppConfig): BackfillResult {
  const state = loadRelationship(p, config);
  const before = state.milestones.length;
  let dirty = false;

  const chatDay = earliestChatDay(p, config);
  if (chatDay) {
    if (state.firstMet !== chatDay) {
      state.firstMet = chatDay;
      dirty = true;
    }
    if (setMilestoneDate(state, "第一次说话", chatDay)) dirty = true;
  }
  const diaryDay = earliestFileDay(p.diary, ".md");
  if (diaryDay && pushMilestone(state, "第一次写日记", diaryDay)) dirty = true;
  const consolidatedDay = earliestFileDay(path.join(p.memoryInbox, "processed"), ".md");
  if (consolidatedDay && pushMilestone(state, "第一次整理记忆", consolidatedDay)) dirty = true;
  const ownDay = earliestFileDay(path.join(p.web, "own"), ".md");
  if (ownDay && pushMilestone(state, "第一次自己出门", ownDay)) dirty = true;

  const orderBefore = milestoneOrder(state);
  state.milestones.sort((a, b) => a.date.localeCompare(b.date));
  if (milestoneOrder(state) !== orderBefore) dirty = true;

  if (dirty) {
    state.daysKnown = daysSince(state.firstMet, config);
    state.updatedAt = Date.now();
    saveRelationship(p, state);
  }
  return { added: state.milestones.length - before, relationship: state };
}

export function updateStreak(p: Paths, config: AppConfig): Relationship {
  const state = loadRelationship(p, config);
  const today = logicalDayKey(config, Date.now());
  // 连续说话天数：从今天往回数，日子连续且当天有聊天记录。
  let cursor = today;
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const range = logicalDayRange(config, cursor);
    const has = messagesBetween(p, config, range.start, range.end).length > 0;
    if (has) {
      streak += 1;
      cursor = addDays(cursor, -1);
    } else if (i === 0) {
      // 今天还没说话，不算断，继续看昨天
      cursor = addDays(cursor, -1);
    } else {
      break;
    }
  }
  const next = { ...state, streak, daysKnown: daysSince(state.firstMet, config), updatedAt: Date.now() };
  saveRelationship(p, next);
  return next;
}

function safeHasMessages(file: string): boolean {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** 同文案只留第一次；返回是否真的新增了一条。 */
function pushMilestone(state: Relationship, text: string, date: string): boolean {
  if (state.milestones.some((m) => m.text === text)) return false;
  state.milestones.push({ date, text });
  return true;
}

/** 已有同文案时把日期改到真实日期（用于纠正老数据的「第一次说话」）。 */
function setMilestoneDate(state: Relationship, text: string, date: string): boolean {
  const found = state.milestones.find((m) => m.text === text);
  if (!found) {
    state.milestones.push({ date, text });
    return true;
  }
  if (found.date === date) return false;
  found.date = date;
  return true;
}

/** 最早一个有内容的聊天日；按消息时间换算成当前的逻辑日。 */
function earliestChatDay(p: Paths, config: AppConfig): string | null {
  let earliest: number | null = null;
  for (const file of listFiles(p.chat, ".jsonl")) {
    for (const message of readJsonl<ChatMessage>(file)) {
      if (typeof message.ts !== "number") continue;
      if (earliest === null || message.ts < earliest) earliest = message.ts;
    }
  }
  return earliest === null ? null : logicalDayKey(config, earliest);
}

/** 某个目录里最早一个有内容的日期文件（日记/整理结果/自己出门的日志）。 */
function earliestFileDay(dir: string, ext: string): string | null {
  for (const file of listFiles(dir, ext)) {
    const day = dayOfFile(file, ext);
    if (!day) continue;
    try {
      if (fs.readFileSync(file, "utf8").trim()) return day;
    } catch {
      // 读不了就当没有
    }
  }
  return null;
}

function dayOfFile(file: string, ext: string): string | null {
  const base = path.basename(file, ext);
  return DAY_RE.test(base) ? base : null;
}

function milestoneOrder(state: Relationship): string {
  return state.milestones.map((m) => `${m.date}:${m.text}`).join("|");
}

export function relationshipDescription(relationship: Relationship, ownerTitle: string): string {
  const milestones = relationship.milestones
    .slice(-4)
    .map((m) => `${m.date} ${m.text}`)
    .join("；");
  return `认识第 ${relationship.daysKnown ?? 1} 天。信任 ${Math.round(relationship.trust)}/100，亲密 ${Math.round(relationship.intimacy)}/100。${milestones ? `记得：${milestones}。` : ""}`;
}

export function relationshipGrowth(relationship: Relationship): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  out.push({ label: "认识", text: `第 ${relationship.daysKnown ?? 1} 天` });
  out.push({ label: "连续说话", text: `${relationship.streak} 天` });
  out.push({ label: "信任", text: `${Math.round(relationship.trust)} / 100` });
  out.push({ label: "亲密", text: `${Math.round(relationship.intimacy)} / 100` });
  return out;
}

export function stamp(): string {
  return formatClock();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
