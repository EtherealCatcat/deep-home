import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, paths as makePaths } from "../src/config.js";
import { validateLifeConfig } from "../src/schedule.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("config clamping", () => {
  it("clamps an old life schedule on load and writes it back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-config-"));
    roots.push(root);
    const p = makePaths(root);
    fs.mkdirSync(p.state, { recursive: true });
    const raw = structuredClone(DEFAULT_CONFIG);
    raw.life.sleepMin = 60;
    raw.life.wakeMin = 180;
    fs.writeFileSync(p.config, JSON.stringify(raw));

    const loaded = loadConfig(p);
    expect(loaded.life.sleepMin).toBe(60);
    expect(loaded.life.wakeMin).toBe(330);

    const onDisk = JSON.parse(fs.readFileSync(p.config, "utf8")) as typeof raw;
    expect(onDisk.life.wakeMin).toBe(330);
  });

  it("normalizes an out-of-range sleep instead of letting it pass", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-config-"));
    roots.push(root);
    const p = makePaths(root);
    fs.mkdirSync(p.state, { recursive: true });
    const raw = structuredClone(DEFAULT_CONFIG);
    raw.life.sleepMin = 1500;
    raw.life.wakeMin = 480;
    fs.writeFileSync(p.config, JSON.stringify(raw));

    const loaded = loadConfig(p);
    expect(loaded.life.sleepMin).toBe(60);
    expect(validateLifeConfig(loaded)).toHaveLength(0);
    expect(loaded.life.clampNotice).toBeTruthy();

    const again = loadConfig(p);
    expect(again.life.sleepMin).toBe(60);
    expect(validateLifeConfig(again)).toHaveLength(0);
  });

  it("falls back to the default life when all four values are unusable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-config-"));
    roots.push(root);
    const p = makePaths(root);
    fs.mkdirSync(p.state, { recursive: true });
    const raw = structuredClone(DEFAULT_CONFIG);
    raw.life.sleepMin = Number.NaN;
    raw.life.wakeMin = Number.NaN;
    raw.life.weekendSleepMin = Number.NaN;
    raw.life.weekendWakeMin = Number.NaN;
    fs.writeFileSync(p.config, JSON.stringify(raw));

    const loaded = loadConfig(p);
    expect(validateLifeConfig(loaded)).toHaveLength(0);
    expect(loaded.life.sleepMin).toBe(DEFAULT_CONFIG.life.sleepMin);
  });
});
