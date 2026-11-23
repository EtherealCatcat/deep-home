import type { DeferredTask, LifeState } from "./types.js";
import type { Paths } from "./config.js";
import { readJson, writeJson } from "./store.js";

function lifeFile(p: Paths): string {
  return p.state + "/life.json";
}

function deferredFile(p: Paths): string {
  return p.state + "/deferred.json";
}

export function defaultLifeState(): LifeState {
  return {
    lastTick: 0,
    wokenAt: 0,
    lastDiary: "",
    lastConsolidate: "",
    lastSpeakAt: 0,
    speakCountDay: "",
    speakCount: 0,
    lastResumeGapAt: 0,
    diarySlotAt: 0,
    diarySlotDay: "",
    diarySlotEndAt: 0,
  };
}

export function loadLife(p: Paths): LifeState {
  return { ...defaultLifeState(), ...readJson<Partial<LifeState>>(lifeFile(p), {}) };
}

export function saveLife(p: Paths, state: LifeState): void {
  writeJson(lifeFile(p), state);
}

export function loadDeferred(p: Paths): DeferredTask[] {
  const list = readJson<DeferredTask[]>(deferredFile(p), []);
  return Array.isArray(list) ? list : [];
}

export function saveDeferred(p: Paths, list: DeferredTask[]): void {
  writeJson(deferredFile(p), list);
}

export function addDeferred(p: Paths, task: Omit<DeferredTask, "id" | "createdAt">): DeferredTask {
  const list = loadDeferred(p);
  const existing = list.find((item) => item.kind === task.kind && item.runAfter <= task.runAfter + 60_000);
  if (existing) return existing;
  const item: DeferredTask = {
    ...task,
    id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    createdAt: Date.now(),
  };
  list.push(item);
  saveDeferred(p, list);
  return item;
}

export function removeDeferred(p: Paths, id: string): void {
  saveDeferred(
    p,
    loadDeferred(p).filter((item) => item.id !== id),
  );
}
