import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import { appendChatMessage, messagesBetween } from "../src/chat.js";
import { logicalDayKey, logicalDayRange } from "../src/schedule.js";
import { zonedTimeToTs } from "../src/time.js";
import { readJsonl } from "../src/store.js";

const roots: string[] = [];

function temp(): { root: string; p: Paths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-logical-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  return { root, p };
}

function config22(): typeof DEFAULT_CONFIG {
  const config = structuredClone(DEFAULT_CONFIG);
  config.behavior.timezone = "Asia/Shanghai";
  config.life.sleepMin = 14 * 60;
  config.life.wakeMin = 22 * 60;
  config.life.weekendSleepMin = 14 * 60;
  config.life.weekendWakeMin = 22 * 60;
  return config;
}

function ts(day: string, hour: number, minute = 0): number {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTimeToTs(year, month, date, hour, minute, "Asia/Shanghai");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("business day (logical day)", () => {
  it("keeps 02:30 and 13:00 in the same wake day for a 22:00 schedule", () => {
    const config = config22();
    const early = ts("2026-11-24", 2, 30);
    const noon = ts("2026-11-24", 13, 0);
    expect(logicalDayKey(config, early)).toBe("2026-11-23");
    expect(logicalDayKey(config, noon)).toBe("2026-11-23");
    const range = logicalDayRange(config, "2026-11-23");
    expect(range.start).toBe(ts("2026-11-23", 22, 0));
    expect(range.end).toBe(ts("2026-11-24", 14, 0));
    expect(early).toBeGreaterThan(range.start);
    expect(early).toBeLessThan(range.end);
  });

  it("writes new chat and timeline messages under the logical day", () => {
    const config = config22();
    const { p } = temp();
    const message = appendChatMessage(p, config, { role: "user", kind: "text", text: "还在吗", ts: ts("2026-11-24", 2, 30) });
    expect(message.dayKey).toBe("2026-11-23");
    expect(fs.existsSync(path.join(p.chat, "2026-11-23.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(p.chat, "2026-11-24.jsonl"))).toBe(false);
  });

  it("reads a legacy 05:00 file together with new logical files, deduped by id", () => {
    const config = config22();
    const { p } = temp();
    const at = ts("2026-11-24", 13, 0);
    // 旧实现会把 13:00 写在 11-24；新逻辑日把它归到 11-23。
    const legacyFile = path.join(p.chat, "2026-11-24.jsonl");
    fs.writeFileSync(
      legacyFile,
      `${JSON.stringify({ id: "old-1", role: "user", kind: "text", text: "旧文件", ts: at, dayKey: "2026-11-24" })}\n`,
    );
    const newFile = path.join(p.chat, "2026-11-23.jsonl");
    fs.writeFileSync(
      newFile,
      `${JSON.stringify({ id: "new-1", role: "assistant", kind: "text", text: "新文件", ts: at + 60_000, dayKey: "2026-11-23" })}\n`,
    );
    const range = logicalDayRange(config, "2026-11-23");
    const messages = messagesBetween(p, config, range.start, range.end);
    expect(messages.map((m) => m.id)).toEqual(["old-1", "new-1"]);
    expect(readJsonl<{ id: string }>(legacyFile)).toHaveLength(1);
    expect(readJsonl<{ id: string }>(newFile)).toHaveLength(1);
  });
});
