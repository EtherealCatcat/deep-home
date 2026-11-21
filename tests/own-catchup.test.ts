import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import type { ChatAgent } from "../src/agent.js";
import type { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import {
  CATCHUP_BACKOFF_MS,
  CATCHUP_HORIZON_MS,
  catchUpBackoff,
  createPendingCatchUp,
  defaultOwnTimeState,
  isInfraFailure,
  loadOwn,
  saveOwn,
} from "../src/own.js";
import { readTimeline } from "../src/timeline.js";
import { probeProviderReachable } from "../src/llm.js";
import { localNetworkAvailable } from "../src/network.js";

vi.mock("../src/llm.js", () => ({ probeProviderReachable: vi.fn() }));
vi.mock("../src/network.js", () => ({ localNetworkAvailable: vi.fn(() => true) }));
const probe = vi.mocked(probeProviderReachable);
const networkUp = vi.mocked(localNetworkAvailable);

const config = structuredClone(DEFAULT_CONFIG);
config.model.apiKey = "sk-test";
config.speak.tellOwnerMaxPerDay = 2;
const DAY = "2026-11-18";
const NOW = new Date(`${DAY}T13:00:00+08:00`).getTime();
const PLANNED = new Date(`${DAY}T12:20:00+08:00`).getTime();
const WINDOW_END = new Date(`${DAY}T13:05:00+08:00`).getTime();
const KEY = `${DAY}:730`;
const roots: string[] = [];

interface Harness {
  p: Paths;
  scheduler: Scheduler;
  runOwnTime: ReturnType<typeof vi.fn>;
  say: ReturnType<typeof vi.fn>;
}

function setup(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-catchup-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  const runOwnTime = vi.fn(async () => ({ ok: true, summary: "看了一篇关于海的文章", shares: [] }));
  const say = vi.fn(async () => {});
  const agent = {
    busy: false,
    isHolding: () => false,
    runOwnTime,
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
  return { p, scheduler, runOwnTime, say };
}

function seedWindow(p: Paths, input: { nextAt: number; windowEnd: number; key: string; runsToday?: number }): void {
  const state = defaultOwnTimeState();
  state.day = DAY;
  state.runsToday = input.runsToday ?? 1;
  state.nextAt = input.nextAt;
  state.windowEnd = input.windowEnd;
  state.windowKey = input.key;
  saveOwn(p, state);
}

const callOwn = (scheduler: Scheduler, now: number): Promise<void> =>
  (scheduler as unknown as { maybeOwnTime: (n: number, r: { phase: string }) => Promise<void> }).maybeOwnTime(now, { phase: "awake" });

const callCatchUp = (scheduler: Scheduler, now: number): Promise<void> =>
  (scheduler as unknown as { maybeCatchUp: (n: number) => Promise<void> }).maybeCatchUp(now);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  probe.mockReset();
  networkUp.mockReset();
  networkUp.mockReturnValue(true);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("catch-up helpers", () => {
  it("backs off with an upper bound", () => {
    expect(catchUpBackoff(0)).toBe(CATCHUP_BACKOFF_MS[0]);
    expect(catchUpBackoff(1)).toBe(CATCHUP_BACKOFF_MS[1]);
    expect(catchUpBackoff(99)).toBe(CATCHUP_BACKOFF_MS.at(-1));
    expect(CATCHUP_HORIZON_MS).toBe(4 * 60 * 60_000);
  });

  it("treats only infrastructure failures as catch-up worthy", () => {
    for (const kind of ["network", "timeout", "rate", "server"]) {
      expect(isInfraFailure(kind)).toBe(true);
    }
    for (const kind of ["auth", "unknown", "aborted", undefined]) {
      expect(isInfraFailure(kind)).toBe(false);
    }
  });
});

describe("maybeOwnTime offline", () => {
  it("keeps a pending window instead of burning the day when the probe fails", async () => {
    const { p, scheduler, runOwnTime } = setup();
    seedWindow(p, { nextAt: PLANNED, windowEnd: WINDOW_END, key: KEY });
    probe.mockResolvedValue({ reachable: false, kind: "unreachable" });

    await callOwn(scheduler, NOW);

    const own = loadOwn(p);
    expect(own.pendingCatchUp?.key).toBe(KEY);
    expect(own.pendingCatchUp?.plannedAt).toBe(PLANNED);
    expect(own.pendingCatchUp?.attempts).toBe(0);
    expect(own.runsToday).toBe(1);
    expect(own.unread).toBe(0);
    expect(runOwnTime).not.toHaveBeenCalled();
    expect(readTimeline(p, DAY).some((event) => event.text.includes("没去成"))).toBe(false);
  });

  it("skips the window when the provider fails but the machine is still online", async () => {
    const { p, scheduler, runOwnTime } = setup();
    seedWindow(p, { nextAt: PLANNED, windowEnd: WINDOW_END, key: KEY });
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    runOwnTime.mockResolvedValue({ ok: false, summary: "", shares: [], error: "网络没连上。", errorKind: "network" });

    await callOwn(scheduler, NOW);

    const own = loadOwn(p);
    expect(own.pendingCatchUp).toBeNull();
    expect(own.lastWindowKey).toBe(KEY);
    expect(own.runsToday).toBe(1);
    expect(own.unread).toBe(0);
    expect(own.lastResult).toBe("");
    expect(readTimeline(p, DAY).some((event) => event.text.includes("没去成"))).toBe(false);
  });

  it("creates a pending window when the network drops mid-run", async () => {
    const { p, scheduler, runOwnTime } = setup();
    seedWindow(p, { nextAt: PLANNED, windowEnd: WINDOW_END, key: KEY });
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    networkUp.mockReturnValueOnce(true).mockReturnValue(false);
    runOwnTime.mockResolvedValue({ ok: false, summary: "", shares: [], error: "网络没连上。", errorKind: "network" });

    await callOwn(scheduler, NOW);

    const own = loadOwn(p);
    expect(own.pendingCatchUp?.key).toBe(KEY);
    expect(own.pendingCatchUp?.attempts).toBe(1);
    expect(own.runsToday).toBe(1);
    expect(own.unread).toBe(0);
  });

  it("lets the newest window replace an older pending one", async () => {
    const { p, scheduler } = setup();
    seedWindow(p, { nextAt: new Date(`${DAY}T18:30:00+08:00`).getTime(), windowEnd: new Date(`${DAY}T19:30:00+08:00`).getTime(), key: `${DAY}:1100` });
    const own = loadOwn(p);
    own.pendingCatchUp = createPendingCatchUp({
      key: `${DAY}:730`,
      plannedAt: PLANNED,
      windowEnd: WINDOW_END,
      now: NOW - 2 * 60 * 60_000,
    });
    saveOwn(p, own);
    probe.mockResolvedValue({ reachable: false, kind: "unreachable" });

    await callOwn(scheduler, new Date(`${DAY}T18:30:00+08:00`).getTime());

    const after = loadOwn(p);
    expect(after.pendingCatchUp?.key).toBe(`${DAY}:1100`);
    expect(after.lastWindowKey).toBe(`${DAY}:1100`);
  });
});

describe("maybeCatchUp", () => {
  it("delivers silently at the planned time and counts the run", async () => {
    const { p, scheduler, runOwnTime, say } = setup();
    const state = defaultOwnTimeState();
    state.day = DAY;
    state.runsToday = 1;
    state.shareDay = DAY;
    state.pendingCatchUp = createPendingCatchUp({
      key: KEY,
      plannedAt: PLANNED,
      windowEnd: WINDOW_END,
      now: NOW - 2 * 60 * 60_000,
      attempts: 1,
      nextRetryAt: NOW - 1_000,
    });
    saveOwn(p, state);
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    runOwnTime.mockResolvedValue({ ok: true, summary: "看了一篇关于海的文章", shares: ["海很蓝"] });

    await callCatchUp(scheduler, NOW);

    const own = loadOwn(p);
    expect(own.pendingCatchUp).toBeNull();
    expect(own.lastRunAt).toBe(PLANNED);
    expect(own.lastResult).toContain("海");
    expect(own.unread).toBe(1);
    expect(own.catchUpCount).toBe(1);
    expect(own.runsToday).toBe(2);
    expect(runOwnTime).toHaveBeenCalledWith(PLANNED, WINDOW_END, { catchUp: true });
    expect(say).toHaveBeenCalledWith("海很蓝", true, PLANNED, { silent: true, catchUp: true });
    const share = readTimeline(p, DAY).find((event) => event.text.includes("海很蓝"));
    expect(share?.ts).toBe(PLANNED);
    expect(share?.meta?.catchUp).toBe(true);
  });

  it("waits for the backoff instead of calling the model again", async () => {
    const { p, scheduler, runOwnTime } = setup();
    const state = defaultOwnTimeState();
    state.day = DAY;
    state.pendingCatchUp = createPendingCatchUp({
      key: KEY,
      plannedAt: PLANNED,
      windowEnd: WINDOW_END,
      now: NOW - 5 * 60_000,
      attempts: 2,
      nextRetryAt: NOW + 60_000,
    });
    saveOwn(p, state);

    await callCatchUp(scheduler, NOW);

    expect(runOwnTime).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(loadOwn(p).pendingCatchUp).not.toBeNull();
  });

  it("drops a window from a previous logical day", async () => {
    const { p, scheduler, runOwnTime } = setup();
    const state = defaultOwnTimeState();
    state.pendingCatchUp = createPendingCatchUp({
      key: `${DAY}:730`,
      plannedAt: new Date("2026-11-17T20:40:00+08:00").getTime(),
      windowEnd: new Date("2026-11-17T21:20:00+08:00").getTime(),
      now: NOW - 20 * 60 * 60_000,
    });
    saveOwn(p, state);

    await callCatchUp(scheduler, NOW);

    expect(loadOwn(p).pendingCatchUp).toBeNull();
    expect(runOwnTime).not.toHaveBeenCalled();
  });

  it("drops a window that is older than the four-hour horizon", async () => {
    const { p, scheduler, runOwnTime } = setup();
    const state = defaultOwnTimeState();
    state.pendingCatchUp = createPendingCatchUp({
      key: KEY,
      plannedAt: new Date(`${DAY}T06:00:00+08:00`).getTime(),
      windowEnd: new Date(`${DAY}T07:00:00+08:00`).getTime(),
      now: NOW - 6 * 60 * 60_000,
    });
    saveOwn(p, state);

    await callCatchUp(scheduler, NOW);

    expect(loadOwn(p).pendingCatchUp).toBeNull();
    expect(runOwnTime).not.toHaveBeenCalled();
  });

  it("defers a catch-up that falls into peak hours", async () => {
    const { p, scheduler, runOwnTime } = setup();
    const peakNow = new Date(`${DAY}T10:00:00+08:00`).getTime();
    const state = defaultOwnTimeState();
    state.day = DAY;
    state.pendingCatchUp = createPendingCatchUp({
      key: `${DAY}:570`,
      plannedAt: new Date(`${DAY}T09:30:00+08:00`).getTime(),
      windowEnd: new Date(`${DAY}T10:30:00+08:00`).getTime(),
      now: peakNow - 5 * 60_000,
      nextRetryAt: peakNow - 1_000,
    });
    saveOwn(p, state);

    await callCatchUp(scheduler, peakNow);

    const own = loadOwn(p);
    expect(own.pendingCatchUp).not.toBeNull();
    expect(own.pendingCatchUp?.nextRetryAt ?? 0).toBeGreaterThan(peakNow);
    expect(runOwnTime).not.toHaveBeenCalled();
  });
});
