import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, paths as makePaths } from "../src/config.js";
import {
  canShareNow,
  defaultOwnTimeState,
  ensureOwnSchedule,
  loadOwn,
  markOwnEnd,
  markOwnStart,
  planOwnWindow,
  queueShare,
  recentOwnResult,
  rollbackOwnStart,
  saveOwn,
  takeFreshShares,
} from "../src/own.js";
import { getSchedule } from "../src/schedule.js";
import { defaultLifeState } from "../src/life.js";

const config = structuredClone(DEFAULT_CONFIG);
const now = new Date("2026-11-18T12:00:00+08:00").getTime();
const rng = () => 0.9;
const schedule = () => getSchedule(config, now, defaultLifeState());

describe("own time windows", () => {
  it("plans a slot inside the awake window", () => {
    const plan = planOwnWindow(config, now, defaultOwnTimeState(), schedule(), rng);
    expect(plan).not.toBeNull();
    expect(plan!.nextAt).toBeGreaterThan(now);
    expect(plan!.windowEnd).toBeGreaterThan(plan!.nextAt);
    const sleepAt = schedule().sleepAt;
    expect(plan!.windowEnd).toBeLessThanOrEqual(sleepAt - 60 * 60_000);
  });

  it("keeps an existing future slot stable", () => {
    const first = ensureOwnSchedule(config, now, defaultOwnTimeState(), schedule(), rng);
    const second = ensureOwnSchedule(config, now + 60_000, first, schedule(), rng);
    expect(second.nextAt).toBe(first.nextAt);
  });

  it("marks start and end and records a result", () => {
    const state = defaultOwnTimeState();
    state.windowKey = "2026-11-18:790";
    markOwnStart(state, now, now + 30 * 60_000);
    expect(state.activeUntil).toBeGreaterThan(now);
    expect(state.runsToday).toBe(1);
    markOwnEnd(state, now + 30 * 60_000, "  看了一篇\n关于海的文章  ");
    expect(state.activeUntil).toBe(0);
    expect(state.lastResult).toBe("看了一篇 关于海的文章");
  });

  it("limits shares per day and dedupes queued shares", () => {
    const state = defaultOwnTimeState();
    expect(canShareNow(state, config, now)).toBe(true);
    state.shareCount = config.speak.tellOwnerMaxPerDay;
    expect(canShareNow(state, config, now)).toBe(false);
    queueShare(state, "看到一只猫", now);
    queueShare(state, "看到一只猫", now + 5_000);
    queueShare(state, "窗外的风很凉", now + 6_000);
    expect(state.pendingShares).toEqual([
      { text: "看到一只猫", ts: now },
      { text: "窗外的风很凉", ts: now + 6_000 },
    ]);
    expect(takeFreshShares(state, config, now + 60_000).map((item) => item.text)).toEqual([
      "看到一只猫",
      "窗外的风很凉",
    ]);
    expect(state.pendingShares).toHaveLength(0);
  });

  it("drops shares that waited more than a day", () => {
    const state = defaultOwnTimeState();
    queueShare(state, "昨天的旧话", now - 25 * 60 * 60_000);
    queueShare(state, "今早的话", now - 6 * 60 * 60_000);
    const fresh = takeFreshShares(state, config, now);
    expect(fresh.map((item) => item.text)).toEqual(["今早的话"]);
    expect(state.pendingShares).toHaveLength(0);
  });

  it("reads the old string[] queue as expired entries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-own-"));
    const p = makePaths(root);
    fs.mkdirSync(p.state, { recursive: true });
    fs.writeFileSync(`${p.state}/own.json`, JSON.stringify({ ...defaultOwnTimeState(), pendingShares: ["旧话"] }));
    const loaded = loadOwn(p);
    expect(loaded.pendingShares).toEqual([{ text: "旧话", ts: 0 }]);
    expect(takeFreshShares(loaded, config, now)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("only remembers a recent own-time result", () => {
    const state = defaultOwnTimeState();
    state.lastRunAt = now - 2 * 60 * 60_000;
    state.lastResult = "看了一篇关于海的文章";
    expect(recentOwnResult(state, now)).toBe("刚才看了一篇关于海的文章");
    state.lastRunAt = now - 13 * 60 * 60_000;
    expect(recentOwnResult(state, now)).toBe("");
  });

  it("keeps today's share count when the day rolls over after a flush", () => {
    const state = defaultOwnTimeState();
    state.day = "2026-11-17";
    state.shareDay = "2026-11-18";
    state.shareCount = 1;
    const next = ensureOwnSchedule(config, now, state, schedule());
    expect(next.shareCount).toBe(1);
  });

  it("plans a night-owl window inside the awake range", () => {
    const night = structuredClone(config);
    night.life.wakeMin = 20 * 60;
    night.life.sleepMin = 8 * 60;
    night.life.weekendWakeMin = 20 * 60;
    night.life.weekendSleepMin = 8 * 60;
    const at = new Date("2026-11-18T23:00:00+08:00").getTime();
    const sched = getSchedule(night, at, defaultLifeState());
    const plan = planOwnWindow(night, at, defaultOwnTimeState(), sched, rng);
    expect(plan).not.toBeNull();
    expect(plan!.nextAt).toBeGreaterThanOrEqual(sched.wakeAt + 30 * 60_000);
    expect(plan!.windowEnd).toBeLessThanOrEqual(sched.sleepAt - 60 * 60_000);
  });

  it("does not plan a window while asleep", () => {
    const sleeping = getSchedule(config, new Date("2026-11-18T02:00:00+08:00").getTime(), defaultLifeState());
    expect(sleeping.phase).toBe("asleep");
    expect(planOwnWindow(config, now, defaultOwnTimeState(), sleeping, rng)).toBeNull();
  });

  it("resets the day counters and plans again after waking", () => {
    const state = defaultOwnTimeState();
    state.day = "2026-11-17";
    state.runsToday = 2;
    state.nextAt = now - 60_000;
    state.windowEnd = now - 30_000;
    state.windowKey = "2026-11-17:700";
    const next = ensureOwnSchedule(config, now, state, schedule(), rng);
    expect(next.day).toBe("2026-11-18");
    expect(next.runsToday).toBe(0);
    expect(next.nextAt).toBeGreaterThan(now);
  });

  it("keeps a planned window that starts in the last sleepy hours", () => {
    const state = defaultOwnTimeState();
    state.day = schedule().day;
    const sleepAt = schedule().sleepAt;
    const start = sleepAt - 90 * 60_000;
    state.nextAt = start;
    state.windowEnd = start + 30 * 60_000;
    state.windowKey = `${schedule().day}:${start}`;
    state.runsToday = 1;
    const next = ensureOwnSchedule(config, start + 5 * 60_000, state, schedule(), rng);
    expect(next.nextAt).toBe(start);
    expect(next.windowKey).toBe(state.windowKey);
  });

  it("rolls back an own-time start that never really ran", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-own-rollback-"));
    const p = makePaths(root);
    fs.mkdirSync(p.state, { recursive: true });
    const state = defaultOwnTimeState();
    state.runsToday = 1;
    state.activeUntil = now + 30 * 60_000;
    saveOwn(p, state);
    const rolled = rollbackOwnStart(p, "test");
    expect(rolled.runsToday).toBe(0);
    expect(rolled.activeUntil).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
