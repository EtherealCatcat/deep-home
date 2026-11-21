import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import type { MemoryStore } from "../src/memory.js";
import type { ToolContext } from "../src/tools.js";
import { runTool } from "../src/tools.js";

const config = structuredClone(DEFAULT_CONFIG);
const roots: string[] = [];

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-tools-"));
  roots.push(root);
  const p = paths(root);
  ensureLayout(p);
  return {
    config,
    paths: p,
    scene: "own",
    memory: {} as MemoryStore,
    now: Date.now(),
    outbox: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("tell_owner", () => {
  it("reports the real outcome from the agent", async () => {
    const tellOwner = vi.fn(() => "（先记着，早上再说。）");
    const ctx = context({ tellOwner });
    const result = await runTool(ctx, "tell_owner", JSON.stringify({ text: "今天看到一只猫" }));
    expect(tellOwner).toHaveBeenCalledWith("今天看到一只猫");
    expect(result).toBe("（先记着，早上再说。）");
    expect(ctx.outbox).toHaveLength(0);
  });

  it("falls back to the plain outbox when there is no callback", async () => {
    const ctx = context();
    const result = await runTool(ctx, "tell_owner", JSON.stringify({ text: "今天看到一只猫" }));
    expect(result).toBe("（说给他听了。）");
    expect(ctx.outbox).toEqual([{ kind: "text", text: "今天看到一只猫" }]);
  });
});
