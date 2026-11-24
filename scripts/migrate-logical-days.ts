import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, ChatMessage, TimelineEvent } from "../src/types.js";
import { dataRoot, ensureLayout, loadConfig, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import { logicalDayKey } from "../src/schedule.js";
import { zonedTimeToTs } from "../src/time.js";
import { atomicWrite, listFiles, readJsonl, readText, removeFile } from "../src/store.js";
import { writeDayBoundary } from "../src/dayBoundary.js";

export type MigrationMode = "dry-run" | "apply" | "verify";

export interface MigrationReport {
  mode: MigrationMode;
  backupDir?: string;
  chat: { files: number; messages: number; moved: number };
  timeline: { files: number; events: number; moved: number };
  inbox: { files: number; moved: number };
  ownLogs: { files: number; moved: number };
  verified: boolean;
  errors: string[];
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function noonTs(day: string, config: AppConfig): number {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTimeToTs(year, month, date, 12, 0, config.behavior.timezone);
}

function dayOf(file: string, ext: string): string | null {
  const base = path.basename(file, ext);
  return /^\d{4}-\d{2}-\d{2}$/.test(base) ? base : null;
}

function backup(root: string, p: Paths): string {
  const dir = path.join(root, "backups", `day-migration-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [from, to] of [
    [p.chat, "chat"],
    [p.timeline, "timeline"],
    [p.memory, "memory"],
    [path.join(p.web, "own"), "web-own"],
  ] as const) {
    if (fs.existsSync(from)) fs.cpSync(from, dir + "/" + to, { recursive: true });
  }
  const usage = path.join(p.state, "usage.json");
  if (fs.existsSync(usage)) fs.copyFileSync(usage, path.join(dir, "usage.json"));
  return dir;
}

function mergeNewlines(existing: string, incoming: string): string {
  const left = existing.trimEnd();
  const right = incoming.trim();
  if (!left) return right ? right + "\n" : "";
  if (!right) return left + "\n";
  return left + "\n\n" + right + "\n";
}

export function migrateLogicalDays(root: string, mode: MigrationMode): MigrationReport {
  const p = paths(root);
  ensureLayout(p);
  const config = loadConfig(p);
  const report: MigrationReport = {
    mode,
    chat: { files: 0, messages: 0, moved: 0 },
    timeline: { files: 0, events: 0, moved: 0 },
    inbox: { files: 0, moved: 0 },
    ownLogs: { files: 0, moved: 0 },
    verified: false,
    errors: [],
  };
  if (mode === "apply") report.backupDir = backup(root, p);

  // ---------- chat ----------
  const chatSources = listFiles(p.chat, ".jsonl")
    .map((file) => ({ file, day: dayOf(file, ".jsonl") }))
    .filter((item): item is { file: string; day: string } => Boolean(item.day));
  const chatTargets = new Map<string, ChatMessage[]>();
  const migratedChat = new Set<string>();
  for (const { file, day } of chatSources) {
    const messages = readJsonl<ChatMessage>(file).filter((m) => typeof m.ts === "number");
    report.chat.files += 1;
    report.chat.messages += messages.length;
    for (const message of messages) {
      const target = logicalDayKey(config, message.ts);
      if (target !== day) {
        report.chat.moved += 1;
        migratedChat.add(file);
      }
      const bucket = chatTargets.get(target) ?? [];
      bucket.push(message);
      chatTargets.set(target, bucket);
    }
  }

  // ---------- timeline ----------
  const timelineSources = listFiles(p.timeline, ".jsonl")
    .map((file) => ({ file, day: dayOf(file, ".jsonl") }))
    .filter((item): item is { file: string; day: string } => Boolean(item.day));
  const timelineTargets = new Map<string, TimelineEvent[]>();
  const migratedTimeline = new Set<string>();
  for (const { file, day } of timelineSources) {
    const events = readJsonl<TimelineEvent>(file).filter((e) => typeof e.ts === "number");
    report.timeline.files += 1;
    report.timeline.events += events.length;
    for (const event of events) {
      const target = logicalDayKey(config, event.ts);
      if (target !== day) {
        report.timeline.moved += 1;
        migratedTimeline.add(file);
      }
      const bucket = timelineTargets.get(target) ?? [];
      bucket.push(event);
      timelineTargets.set(target, bucket);
    }
  }

  // ---------- inbox / own logs ----------
  const moveMarkdown = (dir: string, label: "inbox" | "ownLogs"): Set<string> => {
    const sources = listFiles(dir, ".md")
      .map((file) => ({ file, day: dayOf(file, ".md") }))
      .filter((item): item is { file: string; day: string } => Boolean(item.day));
    const migrated = new Set<string>();
    for (const { file, day } of sources) {
      const target = logicalDayKey(config, noonTs(day, config));
      report[label].files += 1;
      if (target === day) continue;
      report[label].moved += 1;
      migrated.add(file);
      if (mode !== "apply") continue;
      const targetFile = path.join(dir, `${target}.md`);
      const incoming = readText(file, "");
      const existing = readText(targetFile, "");
      atomicWrite(targetFile, mergeNewlines(existing, incoming));
    }
    return migrated;
  };
  const migratedInbox = moveMarkdown(p.memoryInbox, "inbox");
  const migratedOwn = moveMarkdown(path.join(p.web, "own"), "ownLogs");

  // ---------- write chat / timeline ----------
  if (mode === "apply") {
    for (const [day, messages] of chatTargets) {
      const file = path.join(p.chat, `${day}.jsonl`);
      const existing = readJsonl<ChatMessage>(file);
      const seen = new Set(existing.map((m) => m.id));
      const merged = [...existing];
      for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        merged.push(message);
      }
      merged.sort((a, b) => a.ts - b.ts);
      const normalized = merged.map((m) => ({ ...m, dayKey: logicalDayKey(config, m.ts) }));
      atomicWrite(file, normalized.map((m) => JSON.stringify(m)).join("\n") + (normalized.length ? "\n" : ""));
    }
    for (const [day, events] of timelineTargets) {
      const file = path.join(p.timeline, `${day}.jsonl`);
      const existing = readJsonl<TimelineEvent>(file);
      const seen = new Set(existing.map((e) => `${e.ts}:${e.kind}:${e.text}`));
      const merged = [...existing];
      for (const event of events) {
        const key = `${event.ts}:${event.kind}:${event.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(event);
      }
      merged.sort((a, b) => a.ts - b.ts);
      atomicWrite(file, merged.map((e) => JSON.stringify(e)).join("\n") + (merged.length ? "\n" : ""));
    }
    const targetsWritten = new Set([
      ...[...chatTargets.keys()].map((day) => path.join(p.chat, `${day}.jsonl`)),
      ...[...timelineTargets.keys()].map((day) => path.join(p.timeline, `${day}.jsonl`)),
    ]);
    for (const file of migratedChat) if (!targetsWritten.has(file)) removeFile(file);
    for (const file of migratedTimeline) if (!targetsWritten.has(file)) removeFile(file);
    for (const file of migratedInbox) removeFile(file);
    for (const file of migratedOwn) removeFile(file);
    writeDayBoundary(p, "logical", {
      rotateHour: config.behavior.rotateHour,
      note: "历史数据已迁移到作息逻辑日；旧文件备份在 backups/。",
    });
  }

  // ---------- verify ----------
  const errors: string[] = [];
  if (mode !== "dry-run") {
    for (const file of listFiles(p.chat, ".jsonl")) {
      const day = dayOf(file, ".jsonl");
      if (!day) continue;
      for (const message of readJsonl<ChatMessage>(file)) {
        if (typeof message.ts !== "number") continue;
        if (logicalDayKey(config, message.ts) !== day) {
          errors.push(`chat/${path.basename(file)}: 有消息落在 ${day} 之外的逻辑日`);
          break;
        }
      }
    }
    for (const file of listFiles(p.timeline, ".jsonl")) {
      const day = dayOf(file, ".jsonl");
      if (!day) continue;
      for (const event of readJsonl<TimelineEvent>(file)) {
        if (logicalDayKey(config, event.ts) !== day) {
          errors.push(`timeline/${path.basename(file)}: 有事件落在 ${day} 之外的逻辑日`);
          break;
        }
      }
    }
  }
  report.errors = errors;
  report.verified = errors.length === 0;
  return report;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const mode: MigrationMode = process.argv.includes("--apply")
    ? "apply"
    : process.argv.includes("--verify")
      ? "verify"
      : "dry-run";
  const report = migrateLogicalDays(dataRoot(), mode);
  console.log(JSON.stringify(report, null, 2));
  if (!report.verified || report.errors.length) process.exitCode = 1;
}
