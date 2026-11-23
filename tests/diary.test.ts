import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths as makePaths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import { defaultLifeState } from "../src/life.js";
import { appendChatMessage, dayTranscriptBetween } from "../src/chat.js";
import {
  diaryTarget,
  diaryTargetForDay,
  ensureDiarySlot,
  writeDiary,
  type DiaryContext,
} from "../src/diary.js";
import { defaultOwnTimeState } from "../src/own.js";
import { getSchedule } from "../src/schedule.js";

const config = structuredClone(DEFAULT_CONFIG);
const life = defaultLifeState();
const roots: string[] = [];

function ts(iso: string): number {
  return new Date(iso).getTime();
}

function tempPaths(): Paths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-diary-"));
  roots.push(root);
  const p = makePaths(root);
  ensureLayout(p);
  return p;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("diary schedule", () => {
  it("targets the current day once the pre-sleep slot is due", () => {
    const now = ts("2026-11-18T23:50:00+08:00");
    const slot = { ...life, diarySlotDay: "2026-11-18", diarySlotAt: ts("2026-11-18T23:40:00+08:00") };
    const target = diaryTarget(config, slot, now);
    expect(target?.day).toBe("2026-11-18");
    expect(target?.phase).toBe("pre-sleep");
  });

  it("does not write before the slot is due", () => {
    const now = ts("2026-11-18T23:20:00+08:00");
    const slot = { ...life, diarySlotDay: "2026-11-18", diarySlotAt: ts("2026-11-18T23:40:00+08:00") };
    expect(diaryTarget(config, slot, now)).toBeNull();
  });

  it("backfills the night before when the diary is missing", () => {
    const now = ts("2026-11-19T02:00:00+08:00");
    const target = diaryTarget(config, { ...life, lastDiary: "" }, now);
    expect(target?.day).toBe("2026-11-18");
    expect(target?.phase).toBe("backfill");
  });

  it("does not backfill a sleep that happened before the schedule change", () => {
    const now = ts("2026-11-19T02:00:00+08:00");
    const changed = { ...life, lastDiary: "", scheduleChangedAt: ts("2026-11-19T01:30:00+08:00") };
    expect(diaryTarget(config, changed, now)).toBeNull();
    expect(diaryTarget(config, { ...life, lastDiary: "" }, now)?.day).toBe("2026-11-18");
  });

  it("stops backfilling six hours after sleep", () => {
    const now = ts("2026-11-19T07:00:00+08:00");
    expect(diaryTarget(config, { ...life, lastDiary: "" }, now)).toBeNull();
  });

  it("schedules a slot inside the last hour before sleep", () => {
    const p = tempPaths();
    const now = ts("2026-11-18T12:00:00+08:00");
    const schedule = getSchedule(config, now, life);
    const state = { ...life };
    expect(ensureDiarySlot(p, config, state, defaultOwnTimeState(), schedule, now, () => 0.5)).toBe(true);
    const sleepAt = schedule.sleepAt;
    expect(state.diarySlotAt).toBeGreaterThanOrEqual(sleepAt - 60 * 60_000);
    expect(state.diarySlotAt).toBeLessThan(sleepAt - 15 * 60_000);
  });

  it("waits for a pending own-time window before scheduling", () => {
    const p = tempPaths();
    const now = ts("2026-11-18T12:00:00+08:00");
    const schedule = getSchedule(config, now, life);
    const own = defaultOwnTimeState();
    own.nextAt = schedule.sleepAt - 90 * 60_000;
    own.windowEnd = schedule.sleepAt - 60 * 60_000;
    const state = { ...life };
    expect(ensureDiarySlot(p, config, state, own, schedule, now)).toBe(false);
    expect(state.diarySlotAt).toBe(0);
  });

  it("leaves a backfill marker when the pre-sleep window is already gone", () => {
    const p = tempPaths();
    const now = ts("2026-11-19T00:20:00+08:00");
    const schedule = getSchedule(config, now, life);
    const state = { ...life };
    expect(ensureDiarySlot(p, config, state, defaultOwnTimeState(), schedule, now)).toBe(false);
    expect(state.diarySlotAt).toBe(schedule.sleepAt);
    expect(state.diarySlotDay).toBe(schedule.day);
  });

  it("marks an empty day as written without calling the model", async () => {
    const p = tempPaths();
    const target = diaryTargetForDay(config, "2026-11-18");
    const ctx: DiaryContext = {
      config,
      paths: p,
      memory: { prompt: () => "" } as unknown as DiaryContext["memory"],
      persona: "",
      emit: () => {},
      onChange: () => {},
    };
    const ok = await writeDiary(target, ctx);
    expect(ok).toBe(false);
  });
});

describe("diary interval reads", () => {
  it("reads across the legacy 05:00 boundary", () => {
    const p = tempPaths();
    const night = structuredClone(config);
    night.life.wakeMin = 20 * 60;
    night.life.sleepMin = 9 * 60;
    night.life.weekendWakeMin = 20 * 60;
    night.life.weekendSleepMin = 9 * 60;
    const wake = ts("2026-11-18T20:00:00+08:00");
    const sleep = ts("2026-11-19T09:00:00+08:00");
    appendChatMessage(p, night, { role: "user", kind: "text", text: "凌晨", ts: ts("2026-11-19T04:10:00+08:00") });
    appendChatMessage(p, night, { role: "assistant", kind: "text", text: "清晨", ts: ts("2026-11-19T06:10:00+08:00") });
    appendChatMessage(p, night, { role: "user", kind: "text", text: "睡前", ts: ts("2026-11-18T19:00:00+08:00") });
    const transcript = dayTranscriptBetween(p, night, wake, sleep);
    expect(transcript).toContain("凌晨");
    expect(transcript).toContain("清晨");
    expect(transcript).not.toContain("睡前");
  });

  it("only includes messages between wake and sleep", () => {
    const p = tempPaths();
    const wake = ts("2026-11-18T08:00:00+08:00");
    const sleep = ts("2026-11-19T00:30:00+08:00");
    appendChatMessage(p, config, { role: "user", kind: "text", text: "醒来", ts: wake + 60_000 });
    appendChatMessage(p, config, { role: "assistant", kind: "text", text: "睡前", ts: sleep - 60_000 });
    appendChatMessage(p, config, { role: "user", kind: "text", text: "第二天", ts: sleep + 60_000 });
    const transcript = dayTranscriptBetween(p, config, wake, sleep);
    expect(transcript).toContain("醒来");
    expect(transcript).toContain("睡前");
    expect(transcript).not.toContain("第二天");
  });
});
