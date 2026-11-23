import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { Paths } from "../src/config.js";
import type { ChatAgent } from "../src/agent.js";
import type { MemoryStore } from "../src/memory.js";
import { Scheduler } from "../src/scheduler.js";
import { defaultOwnTimeState, loadOwn, saveOwn } from "../src/own.js";
import { getSchedule } from "../src/schedule.js";
import { defaultLifeState } from "../src/life.js";
import { probeProviderReachable } from "../src/llm.js";
import { localNetworkAvailable } from "../src/network.js";
import type { CostPolicy } from "../src/pricing.js";
import { costPolicy } from "../src/pricing.js";

vi.mock("../src/llm.js", () => ({ probeProviderReachable: vi.fn() }));
vi.mock("../src/network.js", () => ({ localNetworkAvailable: vi.fn(() => true) }));
vi.mock("../src/pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pricing.js")>();
  return { ...actual, costPolicy: vi.fn(actual.costPolicy) };
});

const mockPolicy = vi.mocked(costPolicy);
const probe = vi.mocked(probeProviderReachable);
const networkUp = vi.mocked(localNetworkAvailable);

const config = structuredClone(DEFAULT_CONFIG);
config.model.apiKey = "sk-test";
const NOW = new Date("2026-11-18T13:00:00+08:00").getTime();
const roots: string[] = [];

function policy(overrides: Partial<CostPolicy>): CostPolicy {
  return {
    peakEnabled: true,
    isPeak: true,
    peakLabel: "高峰",
    nextChangeAt: NOW + 60 * 60_000,
    maxOutputTokens: 800,
    historyMessages: 40,
    maxToolSteps: 4,
    allowProactive: false,
    allowSideCalls: false,
    allowDiary: false,
    allowConsolidation: false,
    allowOwnTime: false,
    allowWeb: false,
    budgetState: "ok",
    budgetLeftCny: 5,
    reason: "test",
    ...overrides,
  };
}

function setup(): { p: Paths; scheduler: Scheduler; runOwnTime: ReturnType<typeof vi.fn> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-peak-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  const runOwnTime = vi.fn(async () => ({ ok: true, summary: "看了会儿书", shares: [] }));
  const agent = {
    busy: false,
    isHolding: () => false,
    runOwnTime,
    say: vi.fn(async () => {}),
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
  const schedule = getSchedule(config, NOW, defaultLifeState());
  const state = defaultOwnTimeState();
  state.day = schedule.day;
  state.nextAt = NOW;
  state.windowEnd = NOW + 30 * 60_000;
  state.windowKey = `${schedule.day}:test`;
  saveOwn(p, state);
  return { p, scheduler, runOwnTime };
}

const runOwn = (scheduler: Scheduler): Promise<void> =>
  (scheduler as unknown as { maybeOwnTime: (n: number, r: { phase: string }) => Promise<void> }).maybeOwnTime(NOW, {
    phase: "awake",
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("peak-hour own time", () => {
  it("lets the first window run once during peak when budget allows", async () => {
    mockPolicy.mockReturnValue(policy({ isPeak: true, budgetState: "ok" }));
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    networkUp.mockReturnValue(true);
    const { p, scheduler, runOwnTime } = setup();

    await runOwn(scheduler);

    expect(runOwnTime).toHaveBeenCalledTimes(1);
    expect(loadOwn(p).runsToday).toBe(1);
  });

  it("does not let the second window use the same exception", async () => {
    mockPolicy.mockReturnValue(policy({ isPeak: true, budgetState: "ok" }));
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    networkUp.mockReturnValue(true);
    const { p, scheduler, runOwnTime } = setup();
    const state = loadOwn(p);
    state.runsToday = 1;
    saveOwn(p, state);

    await runOwn(scheduler);

    expect(runOwnTime).not.toHaveBeenCalled();
  });

  it("blocks the first window when the budget is exhausted", async () => {
    mockPolicy.mockReturnValue(policy({ isPeak: true, budgetState: "exhausted" }));
    probe.mockResolvedValue({ reachable: true, status: 200, kind: "ok" });
    networkUp.mockReturnValue(true);
    const { scheduler, runOwnTime } = setup();

    await runOwn(scheduler);

    expect(runOwnTime).not.toHaveBeenCalled();
  });
});
