import path from "node:path";
import type { Paths } from "./config.js";
import { readJson, writeJson } from "./store.js";

export type DayBoundaryMode = "legacy" | "dual" | "logical";

export interface DayBoundary {
  mode: DayBoundaryMode;
  updatedAt: number;
  rotateHour?: number;
  note?: string;
}

const LEGACY: DayBoundary = { mode: "legacy", updatedAt: 0 };

export function readDayBoundary(p: Paths): DayBoundary {
  const raw = readJson<DayBoundary>(path.join(p.state, "day-boundary.json"), LEGACY);
  const mode: DayBoundaryMode =
    raw.mode === "dual" || raw.mode === "logical" || raw.mode === "legacy" ? raw.mode : "legacy";
  return { ...raw, mode, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
}

export function writeDayBoundary(p: Paths, mode: DayBoundaryMode, extra: Partial<DayBoundary> = {}): DayBoundary {
  const next: DayBoundary = { mode, updatedAt: Date.now(), ...extra };
  writeJson(path.join(p.state, "day-boundary.json"), next);
  return next;
}
