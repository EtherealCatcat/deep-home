import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import type { ChatAgent } from "../src/agent.js";
import type { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { defaultOwnTimeState, loadOwn, queueShare, saveOwn } from "../src/own.js";
import { roomAction, roomIsStale } from "../src/room.js";
import { appendTimeline, readTimeline } from "../src/timeline.js";
import { dayKey } from "../src/time.js";

const config = structuredClone(DEFAULT_CONFIG);
config.speak.tellOwnerMaxPerDay = 2;
const now = new Date("2026-11-18T09:00:00+08:00").getTime();
const roots: string[] = [];
const today = dayKey(Date.now(), config.behavior.rotateHour, config.behavior.timezone);

function setup(): { p: Paths; say: ReturnType<typeof vi.fn>; scheduler: Scheduler } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-sched-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  const say = vi.fn(async () => {});
  const agent = {
    busy: false,
    isHolding: () => false,
    say,
  } as unknown as ChatAgent;
  const scheduler = new Scheduler({
    config,
    paths: p,
    memory: {} as MemoryStore,
    persona: "",
    agent,
    emit: () => {},
    onChange: () => {},
  });
  return { p, say, scheduler };
}

type Flush = (now: number, rhythm: { phase: string }) => Promise<void>;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("scheduler sharing queue", () => {
  it("flushes a share queued during quiet hours and counts it", async () => {
    const { p, say, scheduler } = setup();
    const state = defaultOwnTimeState();
    state.shareDay = "2026-11-18";
    state.pendingShares = [];
    queueShare(state, "昨晚看到一只猫", new Date("2026-11-18T08:00:00+08:00").getTime());
    saveOwn(p, state);

    await (scheduler as unknown as { flushPendingShares: Flush }).flushPendingShares(now, { phase: "awake" });

    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("昨晚看到一只猫", true);
    const after = loadOwn(p);
    expect(after.shareCount).toBe(1);
    expect(after.pendingShares).toHaveLength(0);
    expect(readTimeline(p, today).some((event) => event.text.includes("早上才告诉他：昨晚看到一只猫"))).toBe(true);
  });

  it("does not flush while quiet", async () => {
    const { p, say, scheduler } = setup();
    const quiet = new Date("2026-11-19T00:10:00+08:00").getTime();
    const state = defaultOwnTimeState();
    queueShare(state, "现在还很安静", quiet - 5 * 60_000);
    saveOwn(p, state);

    await (scheduler as unknown as { flushPendingShares: Flush }).flushPendingShares(quiet, { phase: "awake" });

    expect(say).not.toHaveBeenCalled();
    expect(loadOwn(p).pendingShares).toHaveLength(1);
  });

  it("sends only what the daily quota still allows and drops the rest", async () => {
    const { p, say, scheduler } = setup();
    const state = defaultOwnTimeState();
    state.shareDay = "2026-11-18";
    state.shareCount = 1;
    queueShare(state, "第一条", now - 60_000);
    queueShare(state, "第二条", now - 30_000);
    saveOwn(p, state);

    await (scheduler as unknown as { flushPendingShares: Flush }).flushPendingShares(now, { phase: "awake" });

    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("第二条", true);
    expect(loadOwn(p).shareCount).toBe(2);
    expect(loadOwn(p).pendingShares).toHaveLength(0);
  });

  it("drops yesterday's stale shares instead of dumping them", async () => {
    const { p, say, scheduler } = setup();
    const state = defaultOwnTimeState();
    queueShare(state, "已经放了两天的话", now - 49 * 60 * 60_000);
    saveOwn(p, state);

    await (scheduler as unknown as { flushPendingShares: Flush }).flushPendingShares(now, { phase: "awake" });

    expect(say).not.toHaveBeenCalled();
    expect(loadOwn(p).pendingShares).toHaveLength(0);
  });
});

describe("room decay", () => {
  it("falls back to a neutral room after six quiet hours", () => {
    const { p, scheduler } = setup();
    const room = roomAction(p, "看书");
    expect(roomIsStale(room, now + 5 * 60 * 60_000)).toBe(false);
    const stale = { ...room, updatedAt: now - 7 * 60 * 60_000 };
    fs.writeFileSync(`${p.state}/room.json`, JSON.stringify(stale));

    (scheduler as unknown as { maybeDecayRoom: (now: number) => void }).maybeDecayRoom(now);

    const after = JSON.parse(fs.readFileSync(`${p.state}/room.json`, "utf8"));
    expect(after.status).toBe("在书桌前发呆");
    expect(readTimeline(p, today).some((event) => event.kind === "room" && event.text.includes("安静了一阵"))).toBe(true);
  });
});

describe("appendTimeline", () => {
  it("keeps the share text", () => {
    const { p } = setup();
    appendTimeline(p, config, { kind: "share", text: "想分享，先记着：海边的风" });
    expect(readTimeline(p, today).at(-1)?.text).toBe("想分享，先记着：海边的风");
  });
});
