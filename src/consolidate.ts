import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.js";
import type { Paths } from "./config.js";
import type { MemoryStore } from "./memory.js";
import type { ServerEvent } from "./events.js";
import { BACKGROUND_ATTEMPTS, BACKGROUND_TIMEOUT_MS, callLLM, parseJSON } from "./llm.js";
import { isPeak } from "./pricing.js";
import { recordUsage } from "./usage.js";
import { loadLife, saveLife } from "./life.js";
import { bumpRelationship } from "./relationship.js";
import { appendTimeline } from "./timeline.js";
import { dayKey, weekdayCN } from "./time.js";
import { listFiles, readText, ensureDir } from "./store.js";
import { readDiary } from "./diaryStore.js";

export interface ConsolidateContext {
  config: AppConfig;
  paths: Paths;
  memory: MemoryStore;
  emit: (event: ServerEvent) => void;
  onChange: () => void;
}

interface ConsolidateResult {
  owner?: string;
  me?: string;
  we?: string;
  topics?: { title?: string; summary?: string }[];
  relationship?: { trust?: number; intimacy?: number; note?: string };
}

export function hasInbox(paths: Paths): boolean {
  return listFiles(paths.memoryInbox, ".md").length > 0;
}

export async function consolidateMemory(day: string, ctx: ConsolidateContext): Promise<boolean> {
  const { config, paths, memory, emit, onChange } = ctx;
  const inboxFiles = listFiles(paths.memoryInbox, ".md");
  if (!inboxFiles.length) return false;

  const inbox = inboxFiles.map((file) => readText(file)).join("\n\n").slice(0, 5000);
  const core = memory.readCore();
  const topics = memory.topicTitles();
  const diary = readDiary(paths, day).slice(0, 2500);

  const system = [
    "你是记忆整理器。你的任务是把「关于主人」「关于我自己」「我们之间」三份长期记忆整理干净，不是聊天。",
    "只输出 JSON：{\"owner\":\"...\",\"me\":\"...\",\"we\":\"...\",\"topics\":[{\"title\":\"...\",\"summary\":\"...\"}],\"relationship\":{\"trust\":0.5,\"intimacy\":0.5,\"note\":\"...\"}}。",
    "规则：保留仍然有效的事实；合并重复；删掉过期和互相矛盾的旧条目；每条尽量带日期；不确定的标「待确认」；不要编造没有出现过的信息。",
    "三份记忆加起来不超过 6000 字。owner 用「## 基本信息 / 喜好 / 雷区 / 重要日期 / 正在发生的事 / 答应过的事」小节；me 用「## 我喜欢 / 我不喜欢 / 我的习惯 / 最近在想」；we 用「## 一起经历过 / 约定」。",
    "topics 只列这次需要新增或更新的话题，每条 summary 一句话。relationship.trust / intimacy 是这次要加的分（-2 到 2），note 是一句关系变化。",
  ].join("\n");

  const user = [
    `今天是 ${day}，${weekdayCN(day)}。`,
    `## 现有 memory/owner.md\n${core.owner.slice(0, 3000)}`,
    `## 现有 memory/me.md\n${core.me.slice(0, 2500)}`,
    `## 现有 memory/we.md\n${core.we.slice(0, 1500)}`,
    `## 现有话题\n${topics.length ? topics.join("、") : "（没有）"}`,
    `## 今天新记下的\n${inbox}`,
    diary ? `## 今天的日记\n${diary}` : "",
  ].join("\n\n");

  try {
    const result = await callLLM(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        maxTokens: 3600,
        model: config.model.sideModel,
        temperature: 0.2,
        json: true,
        attempts: BACKGROUND_ATTEMPTS,
        timeoutMs: BACKGROUND_TIMEOUT_MS,
      },
    );
    recordUsage(paths, config, {
      model: result.model,
      provider: config.model.provider,
      promptTokens: result.usage.prompt_tokens,
      completionTokens: result.usage.completion_tokens,
      cacheHitTokens: result.usage.prompt_cache_hit_tokens,
      cacheMissTokens: result.usage.prompt_cache_miss_tokens,
      peak: isPeak(config, Date.now()),
      kind: "consolidate",
    });

    const parsed = parseJSON<ConsolidateResult>(result.content);
    if (!parsed) {
      emit({ type: "error", message: "记忆整理没成功，旧记忆先留着。" });
      return false;
    }

    const nextOwner = cleanMemory(parsed.owner, 3000);
    const nextMe = cleanMemory(parsed.me, 2200);
    const nextWe = cleanMemory(parsed.we, 1200);
    if (nextOwner) memory.writeCore("owner", nextOwner);
    if (nextMe) memory.writeCore("me", nextMe);
    if (nextWe) memory.writeCore("we", nextWe);

    for (const topic of parsed.topics ?? []) {
      const title = String(topic.title ?? "").trim().slice(0, 20);
      const summary = String(topic.summary ?? "").trim().slice(0, 200);
      if (title && summary) memory.appendTopic(title, summary, day);
    }

    const trust = Number(parsed.relationship?.trust ?? 0);
    const intimacy = Number(parsed.relationship?.intimacy ?? 0);
    if (Number.isFinite(trust) || Number.isFinite(intimacy)) {
      bumpRelationship(paths, config, {
        trust: clamp(trust, -2, 2),
        intimacy: clamp(intimacy, -2, 2),
        milestone: "第一次整理记忆",
        reason: parsed.relationship?.note,
      });
    }

    archiveInbox(paths, inboxFiles);
    const life = loadLife(paths);
    life.lastConsolidate = day;
    saveLife(paths, life);
    appendTimeline(paths, config, { kind: "memory", text: "整理了自己的记忆", meta: { day } });
    emit({ type: "timeline", event: { ts: Date.now(), kind: "memory", text: "整理了自己的记忆" } });
    onChange();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "记忆整理失败。";
    emit({ type: "error", message });
    return false;
  }
}

function cleanMemory(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]+>/g, "")
    .replace(/\r/g, "")
    .trim();
  if (text.length < 20) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function archiveInbox(paths: Paths, files: string[]): void {
  const dir = path.join(paths.memoryInbox, "processed");
  ensureDir(dir);
  for (const file of files) {
    try {
      fs.renameSync(file, path.join(dir, path.basename(file)));
    } catch {
      // If archiving fails, leave the inbox in place; next night will retry.
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

export function dayAfter(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function todayKey(config: AppConfig): string {
  return dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
}
