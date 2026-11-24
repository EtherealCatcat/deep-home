import path from "node:path";
import type { AppConfig } from "./types.js";
import type { Paths } from "./config.js";
import { backupFile, ensureDir, listFiles, readText, writeText } from "./store.js";
import { formatClock } from "./time.js";
import { logicalDayKey } from "./schedule.js";

const OWNER_SEED = `# 关于主人

## 基本信息
- 还不知道该怎么称呼他。等他自己说。

## 喜好
- （待发现）

## 雷区
- （待发现）

## 重要日期
- （待发现）

## 正在发生的事
- （待发现）

## 答应过的事
- （待发现）
`;

const ME_SEED = `# 关于我自己

## 我喜欢
- 海、雨声、橘子汽水、旧唱片。

## 我不喜欢
- 突然的巨响，被人当成工具。

## 我的习惯
- 困了会嘴硬；下雨天会把窗开一条缝。

## 最近在想
- 还没想好。
`;

const WE_SEED = `# 我们之间

- （还没有值得写下来的事。）
`;

export type CoreName = "owner" | "me" | "we";

export class MemoryStore {
  constructor(
    private readonly p: Paths,
    private readonly config: AppConfig,
  ) {}

  setConfig(config: AppConfig): void {
    (this as unknown as { config: AppConfig }).config = config;
  }

  ensure(): void {
    ensureDir(this.p.memory);
    ensureDir(this.p.memoryInbox);
    ensureDir(this.p.topics);
    const files: [string, string][] = [
      [this.ownerFile, OWNER_SEED],
      [this.meFile, ME_SEED],
      [this.weFile, WE_SEED],
    ];
    for (const [file, seed] of files) {
      if (!readText(file)) writeText(file, seed);
    }
  }

  get ownerFile(): string {
    return path.join(this.p.memory, "owner.md");
  }
  get meFile(): string {
    return path.join(this.p.memory, "me.md");
  }
  get weFile(): string {
    return path.join(this.p.memory, "we.md");
  }

  readCore(): { owner: string; me: string; we: string } {
    this.ensure();
    return {
      owner: readText(this.ownerFile, OWNER_SEED),
      me: readText(this.meFile, ME_SEED),
      we: readText(this.weFile, WE_SEED),
    };
  }

  writeCore(name: CoreName, content: string): void {
    const file = name === "owner" ? this.ownerFile : name === "me" ? this.meFile : this.weFile;
    backupFile(this.p, file, name);
    writeText(file, content.trim() + "\n");
  }

  topicTitles(): string[] {
    return listFiles(this.p.topics, ".md")
      .map((f) => path.basename(f, ".md"))
      .sort();
  }

  topicFile(title: string): string {
    return path.join(this.p.topics, `${title.replace(/[\\/:*?"<>|]/g, "-")}.md`);
  }

  appendTopic(title: string, text: string, date = logicalDayKey(this.config, Date.now())): void {
    const file = this.topicFile(title);
    const existing = readText(file);
    const heading = `## ${date} · ${title}`;
    const entry = `- ${text.trim()}`;
    if (!existing) {
      writeText(file, `# ${title}\n\n${heading}\n\n${entry}\n`);
      return;
    }
    if (existing.includes(heading)) {
      writeText(file, existing.replace(heading, `${heading}\n\n${entry}`));
    } else {
      writeText(file, `${existing.trim()}\n\n${heading}\n\n${entry}\n`);
    }
  }

  appendInbox(text: string, about: "owner" | "me" | "we" | "topic" = "owner", topic?: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (about === "topic" && topic) {
      this.appendTopic(topic, clean);
      return;
    }
    const day = logicalDayKey(this.config, Date.now());
    const file = path.join(this.p.memoryInbox, `${day}.md`);
    const existing = readText(file);
    const line = `- [${formatClock(Date.now(), this.config.behavior.timezone)}] （${about}）${clean}`;
    if (!existing) {
      writeText(file, `# ${day}\n\n${line}\n`);
    } else {
      writeText(file, `${existing.trimEnd()}\n${line}\n`);
    }
  }

  recentInbox(limit = 8): string[] {
    const files = listFiles(this.p.memoryInbox, ".md").slice(-3);
    const lines: string[] = [];
    for (const file of files) {
      for (const line of readText(file).split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) lines.push(trimmed.slice(2));
      }
    }
    return lines.slice(-limit);
  }

  prompt(): string {
    const core = this.readCore();
    const total = core.owner.length + core.me.length + core.we.length;
    const cap = 6000;
    let owner = core.owner;
    let me = core.me;
    let we = core.we;
    if (total > cap) {
      const share = Math.floor(cap / 3);
      owner = clip(owner, Math.max(1200, share + 400));
      me = clip(me, Math.max(900, share - 200));
      we = clip(we, Math.max(600, cap - owner.length - me.length));
    }
    const topics = this.topicTitles();
    const topicLine = topics.length ? topics.map((t) => `- ${t}`).join("\n") : "- （还没有）";
    return [
      `### 关于${this.config.ownerTitle}\n${owner.trim()}`,
      `### 关于我自己\n${me.trim()}`,
      `### 我们之间\n${we.trim()}`,
      `### 话题（只记得标题，细节要用 recall 查）\n${topicLine}`,
    ].join("\n\n");
  }

  recall(query: string, limit = 3): string[] {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const candidates: { text: string; source: string; score: number }[] = [];
    const pushFile = (file: string, source: string, recency = 0) => {
      const raw = readText(file);
      if (!raw) return;
      for (const line of raw.split("\n")) {
        const text = line.replace(/^[-*]\s+/, "").trim();
        if (!text || text.startsWith("#") || text.startsWith("（待")) continue;
        const score = scoreLine(text, tokens, query) + recency;
        if (score > 0) candidates.push({ text, source, score });
      }
    };
    const core = this.readCore();
    pushFile(this.ownerFile, `关于${this.config.ownerTitle}`);
    pushFile(this.meFile, "关于我");
    pushFile(this.weFile, "我们");
    for (const topic of this.topicTitles()) pushFile(this.topicFile(topic), `话题·${topic}`);

    const diaryFiles = listFiles(this.p.diary, ".md").slice(-60);
    for (const file of diaryFiles) {
      const raw = readText(file);
      const date = path.basename(file, ".md");
      const recent = date >= logicalDayKey(this.config, Date.now() - 7 * 86_400_000) ? 0.6 : 0;
      for (const para of raw.split(/\n{2,}/)) {
        const text = para.replace(/^#+\s*/gm, "").trim();
        if (!text) continue;
        const score = scoreLine(text, tokens, query) + recent;
        if (score > 0) candidates.push({ text, source: `日记 ${date}`, score });
      }
    }
    for (const line of this.recentInbox(30)) {
      const score = scoreLine(line, tokens, query);
      if (score > 0) candidates.push({ text: line, source: "刚记住", score });
    }

    const seen = new Set<string>();
    return candidates
      .sort((a, b) => b.score - a.score)
      .filter((c) => {
        const key = c.text.slice(0, 50);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((c) => `[${c.source}] ${c.text.slice(0, 300)}`);
  }

  forget(query: string): number {
    const tokens = tokenize(query);
    if (!tokens.length) return 0;
    let removed = 0;
    const removedLines: string[] = [];
    const process = (file: string, label: string) => {
      const raw = readText(file);
      if (!raw) return;
      const kept: string[] = [];
      for (const line of raw.split("\n")) {
        const text = line.replace(/^[-*]\s+/, "").trim();
        if (text && !text.startsWith("#") && scoreLine(text, tokens, query) >= 2) {
          removed += 1;
          removedLines.push(`[${label}] ${text}`);
        } else {
          kept.push(line);
        }
      }
      if (kept.join("\n") !== raw) {
        backupFile(this.p, file, path.basename(file, ".md"));
        writeText(file, kept.join("\n").trimEnd() + "\n");
      }
    };
    process(this.ownerFile, "owner");
    process(this.meFile, "me");
    process(this.weFile, "we");
    for (const topic of this.topicTitles()) process(this.topicFile(topic), `topic:${topic}`);
    for (const file of listFiles(this.p.memoryInbox, ".md")) process(file, `inbox:${path.basename(file, ".md")}`);
    if (removedLines.length) {
      const archive = path.join(this.p.memory, "forgotten.md");
      writeText(archive, `${readText(archive).trimEnd()}\n\n## ${new Date().toISOString()}\n${removedLines.map((l) => `- ${l}`).join("\n")}\n`);
    }
    return removed;
  }

  snapshot(): { owner: string; me: string; we: string; topics: { title: string; content: string }[]; inbox: string[] } {
    return {
      ...this.readCore(),
      topics: this.topicTitles().map((title) => ({ title, content: readText(this.topicFile(title)) })),
      inbox: this.recentInbox(12),
    };
  }
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 8);
  return `${text.slice(0, head)}\n……\n${text.slice(-tail)}`;
}

export function tokenize(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, " ").trim();
  if (!normalized) return [];
  const tokens = new Set<string>();
  for (const chunk of normalized.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2) tokens.add(chunk);
      continue;
    }
    const han = [...chunk].filter((ch) => /\p{Script=Han}/u.test(ch));
    if (han.length === 1) tokens.add(han[0]);
    for (let i = 0; i < han.length - 1; i++) tokens.add(han[i] + han[i + 1]);
  }
  return [...tokens].slice(0, 40);
}

function scoreLine(text: string, tokens: string[], query: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += token.length >= 2 ? 2 : 1;
  }
  if (query.length >= 2 && lower.includes(query.toLowerCase())) score += 5;
  if (/重要|答应|喜欢|不喜欢|雷区|害怕|生日|纪念/.test(text)) score += 0.5;
  score -= Math.min(1.5, text.length / 500);
  return score;
}
