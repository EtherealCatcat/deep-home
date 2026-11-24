import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { migrateLogicalDays } from "../scripts/migrate-logical-days.js";
import { readDayBoundary } from "../src/dayBoundary.js";
import { readJsonl } from "../src/store.js";
import { zonedTimeToTs } from "../src/time.js";
import { ensureLayout, paths } from "../src/config.js";

const roots: string[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-migrate-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  const config = structuredClone(DEFAULT_CONFIG);
  config.behavior.timezone = "Asia/Shanghai";
  fs.writeFileSync(p.config, JSON.stringify(config, null, 2));
  return root;
}

function ts(day: string, hour: number): number {
  const [year, month, date] = day.split("-").map(Number);
  return zonedTimeToTs(year, month, date, hour, 0, "Asia/Shanghai");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("migrate logical days", () => {
  it("dry-runs, applies and stays idempotent", () => {
    const root = temp();
    const p = paths(root);
    fs.writeFileSync(
      path.join(p.chat, "2026-11-23.jsonl"),
      [
        JSON.stringify({ id: "a", role: "user", kind: "text", text: "凌晨", ts: ts("2026-11-24", 1), dayKey: "2026-11-23" }),
        JSON.stringify({ id: "b", role: "assistant", kind: "text", text: "下午", ts: ts("2026-11-24", 13), dayKey: "2026-11-24" }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(p.timeline, "2026-11-23.jsonl"),
      `${JSON.stringify({ kind: "chat", text: "聊了 1 轮", ts: ts("2026-11-24", 1) })}\n`,
    );

    const dry = migrateLogicalDays(root, "dry-run");
    expect(dry.chat.moved).toBe(2);
    expect(dry.timeline.moved).toBe(1);
    expect(fs.existsSync(path.join(p.chat, "2026-11-24.jsonl"))).toBe(false);
    expect(readDayBoundary(p).mode).toBe("legacy");

    const first = migrateLogicalDays(root, "apply");
    expect(first.verified).toBe(true);
    expect(first.backupDir && fs.existsSync(first.backupDir)).toBe(true);
    expect(readDayBoundary(p).mode).toBe("logical");
    const migrated = readJsonl<{ id: string; ts: number }>(path.join(p.chat, "2026-11-24.jsonl"));
    expect(migrated.map((m) => m.id)).toEqual(["a", "b"]);
    expect(fs.existsSync(path.join(p.chat, "2026-11-23.jsonl"))).toBe(false);
    expect(readJsonl(path.join(p.timeline, "2026-11-24.jsonl"))).toHaveLength(1);

    const second = migrateLogicalDays(root, "apply");
    expect(second.chat.moved).toBe(0);
    expect(second.verified).toBe(true);
    expect(readJsonl(path.join(p.chat, "2026-11-24.jsonl"))).toHaveLength(2);

    const verify = migrateLogicalDays(root, "verify");
    expect(verify.verified).toBe(true);
    expect(verify.errors).toEqual([]);
  });

  it("keeps already-logical files in place", () => {
    const root = temp();
    const p = paths(root);
    fs.writeFileSync(
      path.join(p.chat, "2026-11-24.jsonl"),
      `${JSON.stringify({ id: "x", role: "user", kind: "text", text: "在", ts: ts("2026-11-24", 13), dayKey: "2026-11-24" })}\n`,
    );
    const report = migrateLogicalDays(root, "apply");
    expect(report.chat.moved).toBe(0);
    expect(report.verified).toBe(true);
  });
});
