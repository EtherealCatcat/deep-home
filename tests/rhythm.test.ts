import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { defaultLifeState } from "../src/life.js";
import { getRhythm, isQuietHours } from "../src/rhythm.js";

const config = structuredClone(DEFAULT_CONFIG);

describe("rhythm", () => {
  it("is asleep after the workday sleep time", () => {
    const now = new Date("2026-11-18T02:00:00+08:00").getTime();
    const rhythm = getRhythm(config, defaultLifeState(), now);
    expect(rhythm.phase).toBe("asleep");
  });

  it("is awake in the late morning", () => {
    const now = new Date("2026-11-18T10:00:00+08:00").getTime();
    const rhythm = getRhythm(config, defaultLifeState(), now);
    expect(rhythm.phase).toBe("awake");
  });

  it("keeps quiet from 30 minutes before sleep until waking", () => {
    expect(isQuietHours(config, new Date("2026-11-19T00:10:00+08:00").getTime())).toBe(true);
    expect(isQuietHours(config, new Date("2026-11-18T12:00:00+08:00").getTime())).toBe(false);
  });

  it("honours manual quiet hours when configured", () => {
    const manual = structuredClone(config);
    manual.speak.quietMode = "manual";
    manual.speak.quietStart = 23 * 60;
    manual.speak.quietEnd = 8 * 60;
    expect(isQuietHours(manual, new Date("2026-11-18T23:30:00+08:00").getTime())).toBe(true);
    expect(isQuietHours(manual, new Date("2026-11-18T12:00:00+08:00").getTime())).toBe(false);
  });
});
