import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import type { ChatAgent } from "../src/agent.js";
import type { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { createPendingCatchUp, defaultOwnTimeState, loadOwn, saveOwn } from "../src/own.js";
import { saveReminders, loadReminders } from "../src/care.js";
import { readTimeline } from "../src/timeline.js";
import { noteProviderFailure, resetProviderHealth } from "../src/provider.js";
import { probeProviderReachable } from "../src/llm.js";
import { localNetworkAvailable } from "../src/network.js";
import type { Reminder } from "../src/types.js";

vi.mock("../src/llm.js", () => ({ probeProviderReachable: vi.fn() }));
vi.mock("../src/network.js", () => ({ localNetworkAvailable: vi.fn(() => true) }));
const probe = vi.mocked(probeProviderReachable);
const networkUp = vi.mocked(localNetworkAvailable);

const config = structuredClone(DEFAULT_CONFIG);
config.model.apiKey = "sk-test";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-provider-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  const runOwnTime = vi.fn(async () => ({ ok: true, summary: "看了会儿书", shares: [] }));
  const say = vi.fn(async () => {});
  const agent = {
    busy: false,
    isHolding: () => false,
    runOwnTime,
    say,
    enqueue: vi.fn(),
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

function seedWindow(p: Paths): void {
  const state = defaultOwnTimeState();
  state.day = DAY;
  state.runsToday = 1;
  state.nextAt = PLANNED;
  state.windowEnd = WINDOW_END;
  state.windowKey = KEY;
  saveOwn(p, state);
}

function takeDown(): void {
  for (let index = 0; index < 3; index += 1) {
    noteProviderFailure({ kind: "server", status: 503, message: "服务挂了", at: NOW, attempts: 1 });
  }
}

const callOwn = (scheduler: Scheduler): Promise<void> =>
  (scheduler as unknown as { maybeOwnTime: (n: number, r: { phase: string }) => Promise<void> }).maybeOwnTime(NOW, {
    phase: "awake",
  });

const callCatchUp = (scheduler: Scheduler): Promise<void> =>
  (scheduler as unknown as { maybeCatchUp: (n: number) => Promise<void> }).maybeCatchUp(NOW);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetProviderHealth();
  probe.mockReset();
  probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
  networkUp.mockReset();
  networkUp.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  resetProviderHealth();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("scheduler provider health", () => {
  it("skips a due own-time window without leaving a catch-up or a sad timeline", async () => {
    const { p, scheduler, runOwnTime } = setup();
    takeDown();
    seedWindow(p);

    await callOwn(scheduler);

    const own = loadOwn(p);
    expect(own.pendingCatchUp).toBeNull();
    expect(own.lastWindowKey).toBe(KEY);
    expect(own.runsToday).toBe(1);
    expect(runOwnTime).not.toHaveBeenCalled();
    expect(readTimeline(p, DAY).some((event) => event.text.includes("没去成"))).toBe(false);
  });

  it("keeps reminders pending while the provider is down", async () => {
    const { p, scheduler, say } = setup();
    takeDown();
    const reminder: Reminder = {
      id: "r1",
      text: "喝水",
      dueAt: NOW - 60_000,
      kind: "owner",
      status: "pending",
      createdAt: NOW - 120_000,
    };
    saveReminders(p, [reminder]);

    await scheduler.tick();

    expect(loadReminders(p)[0].status).toBe("pending");
    expect(say).not.toHaveBeenCalled();
  });

  it("still treats a local network outage as a user-side catch-up", async () => {
    const { p, scheduler } = setup();
    seedWindow(p);
    networkUp.mockReturnValue(false);

    await callOwn(scheduler);

    const own = loadOwn(p);
    expect(own.pendingCatchUp?.key).toBe(KEY);
    expect(own.pendingCatchUp?.attempts).toBe(0);
  });

  it("holds a pending catch-up until the rate limit passes", async () => {
    const { p, scheduler, runOwnTime } = setup();
    const state = defaultOwnTimeState();
    state.day = DAY;
    state.pendingCatchUp = createPendingCatchUp({
      key: KEY,
      plannedAt: PLANNED,
      windowEnd: WINDOW_END,
      now: NOW - 60_000,
      attempts: 1,
      nextRetryAt: NOW - 1_000,
    });
    saveOwn(p, state);
    noteProviderFailure({ kind: "rate", status: 429, retryAfterMs: 300_000, message: "限流", at: NOW, attempts: 1 });

    await callCatchUp(scheduler);

    const own = loadOwn(p);
    expect(own.pendingCatchUp?.key).toBe(KEY);
    expect(own.pendingCatchUp?.nextRetryAt).toBeGreaterThanOrEqual(NOW + 300_000);
    expect(runOwnTime).not.toHaveBeenCalled();
  });
});
