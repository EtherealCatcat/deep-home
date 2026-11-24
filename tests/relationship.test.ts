import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import { dayKey, zonedTimeToTs } from "../src/time.js";
import { logicalDayKey } from "../src/schedule.js";
import {
  addMilestone,
  backfillMilestones,
  bumpRelationship,
  defaultRelationship,
  loadRelationship,
  recordFirstChat,
  updateStreak,
} from "../src/relationship.js";

const config = structuredClone(DEFAULT_CONFIG);
const roots: string[] = [];

function tempPaths(): Paths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-relationship-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  return p;
}

function today(offset = 0): string {
  const base = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function writeChat(p: Paths, day: string, text = "在"): void {
  const [year, month, date] = day.split("-").map(Number);
  const ts = zonedTimeToTs(year, month, date, 12, 0, config.behavior.timezone);
  const file = path.join(p.chat, `${logicalDayKey(config, ts)}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ id: `m-${day}`, role: "user", text, ts, dayKey: logicalDayKey(config, ts) })}\n`,
  );
}

function texts(p: Paths): string[] {
  return loadRelationship(p, config).milestones.map((m) => m.text);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("relationship milestones", () => {
  it("starts without any milestone and seeds firstMet lazily", () => {
    const p = tempPaths();
    expect(defaultRelationship(config).milestones).toEqual([]);
    expect(loadRelationship(p, config).milestones).toEqual([]);
  });

  it("records a given milestone only once", () => {
    const p = tempPaths();
    addMilestone(p, config, "第一次写日记", "2026-11-01");
    addMilestone(p, config, "第一次写日记", "2026-11-02");
    const milestones = loadRelationship(p, config).milestones;
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toEqual({ date: "2026-11-01", text: "第一次写日记" });
  });

  it("records trust and intimacy steps once when they cross 60/80", () => {
    const p = tempPaths();
    bumpRelationship(p, config, { trust: 11, intimacy: 31 });
    expect(texts(p)).toEqual(["信任到了 60", "亲密到了 60"]);
    bumpRelationship(p, config, { trust: 1, intimacy: 1 });
    expect(texts(p)).toEqual(["信任到了 60", "亲密到了 60"]);
    bumpRelationship(p, config, { trust: 20, intimacy: 20 });
    expect(texts(p)).toEqual(["信任到了 60", "亲密到了 60", "信任到了 80", "亲密到了 80"]);
  });

  it("uses the supplied date for backfilled bumps", () => {
    const p = tempPaths();
    bumpRelationship(p, config, { milestone: "第一次整理记忆", date: "2026-10-20" });
    expect(loadRelationship(p, config).milestones[0].date).toBe("2026-10-20");
  });

  it("fixes firstMet and the first-chat date from the earliest chat log", () => {
    const p = tempPaths();
    writeChat(p, "2026-11-01");
    writeChat(p, "2026-11-02");
    writeChat(p, today());
    recordFirstChat(p, config);
    const state = loadRelationship(p, config);
    expect(state.firstMet).toBe("2026-11-01");
    expect(state.milestones).toEqual([{ date: "2026-11-01", text: "第一次说话" }]);
    recordFirstChat(p, config);
    expect(loadRelationship(p, config).milestones).toHaveLength(1);
  });

  it("counts a continuous streak and stops at a gap", () => {
    const p = tempPaths();
    writeChat(p, today());
    writeChat(p, today(-1));
    expect(updateStreak(p, config).streak).toBe(2);

    const gap = tempPaths();
    writeChat(gap, today());
    writeChat(gap, today(-2));
    expect(updateStreak(gap, config).streak).toBe(1);
  });

  it("backfills old data once, with real dates", () => {
    const p = tempPaths();
    writeChat(p, "2026-10-30");
    fs.mkdirSync(path.join(p.memoryInbox, "processed"), { recursive: true });
    fs.writeFileSync(path.join(p.memoryInbox, "processed", "2026-10-31.md"), "整理过的东西\n");
    fs.writeFileSync(path.join(p.diary, "2026-11-01.md"), "# 日记\n");
    fs.mkdirSync(path.join(p.web, "own"), { recursive: true });
    fs.writeFileSync(path.join(p.web, "own", "2026-11-02.md"), "出门看了看\n");

    const first = backfillMilestones(p, config);
    expect(first.added).toBe(4);
    expect(first.relationship.firstMet).toBe("2026-10-30");
    expect(first.relationship.milestones).toEqual([
      { date: "2026-10-30", text: "第一次说话" },
      { date: "2026-10-31", text: "第一次整理记忆" },
      { date: "2026-11-01", text: "第一次写日记" },
      { date: "2026-11-02", text: "第一次自己出门" },
    ]);

    const second = backfillMilestones(p, config);
    expect(second.added).toBe(0);
    expect(second.relationship.milestones).toHaveLength(4);
  });
});
