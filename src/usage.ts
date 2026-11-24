import type { AppConfig, UsageDay } from "./types.js";
import type { Paths } from "./config.js";
import { addDays } from "./time.js";
import { logicalDayKey } from "./schedule.js";
import { estimateCost } from "./pricing.js";
import { readJson, writeJson } from "./store.js";

type UsageMap = Record<string, UsageDay>;

function emptyDay(date: string): UsageDay {
  return {
    date,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costCny: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    peakCostCny: 0,
    offPeakCostCny: 0,
  };
}

function loadMap(p: Paths): UsageMap {
  return readJson<UsageMap>(p.state + "/usage.json", {});
}

export function usageForDay(p: Paths, config: AppConfig, day = logicalDayKey(config, Date.now())): UsageDay {
  const map = loadMap(p);
  return map[day] ?? emptyDay(day);
}

export interface RecordUsageInput {
  model: string;
  provider: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  peak: boolean;
  kind: string;
  at?: number;
}

export function recordUsage(p: Paths, config: AppConfig, input: RecordUsageInput): UsageDay {
  const at = input.at ?? Date.now();
  const day = logicalDayKey(config, at);
  const map = loadMap(p);
  const entry = map[day] ?? emptyDay(day);
  const estimate = estimateCost(
    {
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      cacheHitTokens: input.cacheHitTokens,
      cacheMissTokens: input.cacheMissTokens,
    },
    input.model,
    input.peak,
  );
  entry.calls += 1;
  entry.promptTokens += estimate.promptTokens;
  entry.completionTokens += estimate.completionTokens;
  entry.cacheHitTokens += estimate.cacheHitTokens;
  entry.cacheMissTokens += estimate.cacheMissTokens;
  entry.costCny = Math.round((entry.costCny + estimate.costCny) * 1_000_000) / 1_000_000;
  if (input.peak) {
    entry.peakCalls += 1;
    entry.peakCostCny = Math.round((entry.peakCostCny + estimate.costCny) * 1_000_000) / 1_000_000;
  } else {
    entry.offPeakCalls += 1;
    entry.offPeakCostCny = Math.round((entry.offPeakCostCny + estimate.costCny) * 1_000_000) / 1_000_000;
  }
  map[day] = entry;

  const cutoff = addDays(day, -400);
  for (const key of Object.keys(map)) {
    if (key < cutoff) delete map[key];
  }
  writeJson(p.state + "/usage.json", map);
  return entry;
}

export function usageSnapshot(p: Paths, config: AppConfig): UsageDay[] {
  const map = loadMap(p);
  const today = logicalDayKey(config, Date.now());
  const days: UsageDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(today, -i);
    days.push(map[key] ?? emptyDay(key));
  }
  return days;
}

export function todayUsage(p: Paths, config: AppConfig): UsageDay {
  return usageForDay(p, config);
}
