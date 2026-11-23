import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  MIN_AWAKE_MINUTES,
  clampLifeConfig,
  getSchedule,
  isQuietHours,
  nextWakeAt,
  quietEndsAt,
  scheduleDayKey,
  scheduleDayRange,
  validateLifeConfig,
} from "../src/schedule.js";
import { addDays } from "../src/time.js";

const config = structuredClone(DEFAULT_CONFIG);

function ts(iso: string): number {
  return new Date(iso).getTime();
}

describe("schedule", () => {
  it("builds a wake-to-sleep range on the wake day", () => {
    const range = scheduleDayRange(config, "2026-11-18");
    expect(range.wakeAt).toBe(ts("2026-11-18T08:00:00+08:00"));
    expect(range.sleepAt).toBe(ts("2026-11-19T00:30:00+08:00"));
  });

  it("uses the weekend wake time on rest days and early sleep on the night before", () => {
    const saturday = scheduleDayRange(config, "2026-11-21");
    expect(saturday.wakeAt).toBe(ts("2026-11-21T09:30:00+08:00"));
    expect(saturday.sleepAt).toBe(ts("2026-11-22T01:30:00+08:00"));

    const sunday = scheduleDayRange(config, "2026-11-22");
    expect(sunday.sleepAt).toBe(ts("2026-11-23T00:30:00+08:00"));
  });

  it("reports awake, waking, sleepy and asleep phases", () => {
    expect(getSchedule(config, ts("2026-11-18T00:40:00+08:00")).phase).toBe("asleep");
    expect(getSchedule(config, ts("2026-11-18T08:10:00+08:00")).phase).toBe("waking");
    expect(getSchedule(config, ts("2026-11-18T10:00:00+08:00")).phase).toBe("awake");
    expect(getSchedule(config, ts("2026-11-18T23:50:00+08:00")).phase).toBe("sleepy");
  });

  it("maps timestamps before the waking time to the upcoming day", () => {
    expect(scheduleDayKey(config, ts("2026-11-18T02:00:00+08:00"))).toBe("2026-11-18");
    expect(scheduleDayKey(config, ts("2026-11-18T10:00:00+08:00"))).toBe("2026-11-18");
    expect(nextWakeAt(config, ts("2026-11-18T02:00:00+08:00"))).toBe(ts("2026-11-18T08:00:00+08:00"));
  });

  it("rejects life schedules with less than 6 hours awake", () => {
    const bad = structuredClone(config);
    bad.life.sleepMin = 60;
    bad.life.wakeMin = 120;
    const issues = validateLifeConfig(bad);
    expect(issues.length).toBeGreaterThan(0);
    expect(MIN_AWAKE_MINUTES).toBe(360);
  });

  it("treats equal sleep and wake as a 24 hour day", () => {
    const bad = structuredClone(config);
    bad.life.sleepMin = 480;
    bad.life.wakeMin = 480;
    expect(validateLifeConfig(bad).length).toBeGreaterThan(0);
  });

  it("clamps only the wake time, keeping the sleep anchor", () => {
    const bad = structuredClone(config);
    bad.life.sleepMin = 60;
    bad.life.wakeMin = 180;
    const { changed, config: fixed } = clampLifeConfig(bad);
    expect(changed).toBe(true);
    expect(fixed.life.sleepMin).toBe(60);
    expect(fixed.life.wakeMin).toBe(330);
    expect(validateLifeConfig(fixed)).toHaveLength(0);
  });

  it("uses the sleep-based quiet window by default", () => {
    expect(config.speak.quietMode).toBe("sleep");
    expect(isQuietHours(config, ts("2026-11-19T00:10:00+08:00"))).toBe(true);
    expect(isQuietHours(config, ts("2026-11-18T12:00:00+08:00"))).toBe(false);
    const end = quietEndsAt(config, ts("2026-11-19T00:10:00+08:00"));
    expect(end).toBe(nextWakeAt(config, ts("2026-11-19T00:30:00+08:00")));
    expect(end).toBe(ts("2026-11-19T08:00:00+08:00"));

    // 睡着以后，安静结束是当天早上，而不是下一晚之后。
    expect(quietEndsAt(config, ts("2026-11-19T02:00:00+08:00"))).toBe(ts("2026-11-19T08:00:00+08:00"));
  });

  it("keeps the manual quiet window working when selected", () => {
    const manual = structuredClone(config);
    manual.speak.quietMode = "manual";
    manual.speak.quietStart = 22 * 60;
    manual.speak.quietEnd = 7 * 60;
    expect(isQuietHours(manual, ts("2026-11-18T23:00:00+08:00"))).toBe(true);
    expect(isQuietHours(manual, ts("2026-11-18T12:00:00+08:00"))).toBe(false);
    expect(quietEndsAt(manual, ts("2026-11-18T23:00:00+08:00"))).toBe(ts("2026-11-19T07:00:00+08:00"));
  });

  it("does not depend on the legacy rotate hour for the schedule day", () => {
    const late = structuredClone(config);
    late.behavior.rotateHour = 3;
    expect(scheduleDayKey(late, ts("2026-11-18T02:00:00+08:00"))).toBe("2026-11-18");
    expect(scheduleDayKey(late, ts("2026-11-18T02:00:00+08:00"))).not.toBe(addDays("2026-11-18", -1));
  });
});
