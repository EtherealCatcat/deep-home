import path from "node:path";
import type { AppConfig } from "./types.js";
import type { Paths } from "./config.js";
import { backupFile, ensureDir, listFiles, readText, writeText } from "./store.js";
import { addDays } from "./time.js";
import { logicalDayKey } from "./schedule.js";

export function diaryFile(p: Paths, day: string): string {
  return path.join(p.diary, `${day}.md`);
}

export function readDiary(p: Paths, day: string): string {
  return readText(diaryFile(p, day), "");
}

export function saveDiary(p: Paths, config: AppConfig, day: string, content: string): string {
  ensureDir(p.diary);
  const file = diaryFile(p, day);
  if (readText(file, "").trim()) backupFile(p, file, `diary-${day}`);
  writeText(file, content.trim() + "\n");
  return file;
}

export function listDiaries(p: Paths, limit = 60): { day: string; title: string; preview: string }[] {
  return listFiles(p.diary, ".md")
    .map((file) => {
      const day = path.basename(file, ".md");
      const text = readText(file, "");
      const title = text.split("\n").find((line) => line.trim().startsWith("#"))?.replace(/^#+\s*/, "").trim() || "无题";
      return { day, title, preview: text.replace(/^#.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 120) };
    })
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, limit);
}

export function yesterdayKey(config: AppConfig, now = Date.now()): string {
  return addDays(logicalDayKey(config, now), -1);
}
