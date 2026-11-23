import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig, paths as makePaths } from "../src/config.js";

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
});
