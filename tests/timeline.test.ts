import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { ensureLayout, paths } from "../src/config.js";
import { appendTimeline, groupTimelineEvents, readTimeline, timelineSummary } from "../src/timeline.js";
import type { TimelineEvent } from "../src/types.js";

const config = structuredClone(DEFAULT_CONFIG);
const at = (minute: number) => new Date(`2026-11-18T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`).getTime();

function event(minute: number, kind: string, text: string, meta?: Record<string, unknown>): TimelineEvent {
  return { ts: at(minute), kind, text, meta };
}

describe("timeline display grouping", () => {
  it("hides diagnostic resume gaps", () => {
    const events = [event(0, "resume_gap", "电脑睡了 46 分钟"), event(5, "room", "在发呆")];
    expect(groupTimelineEvents(events, config).map((item) => item.kind)).toEqual(["room"]);
  });

  it("merges consecutive chat turns into one fixed-period summary", () => {
    const events = [
      event(0, "chat", "和主人聊了 2 字", { chars: 2 }),
      event(7, "chat", "和主人聊了 3 字", { chars: 3 }),
      event(19, "room", "泡了杯茶"),
    ];
    const result = groupTimelineEvents(events, config);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe("chat");
    expect(result[0].text).toContain("2 轮");
    expect(result[0].text).toContain("5 字");
    expect(result[1].kind).toBe("room");
  });

  it("starts a new chat summary after a long silence", () => {
    const events = [
      event(0, "chat", "和主人聊了 2 字", { chars: 2 }),
      event(10, "chat", "和主人聊了 3 字", { chars: 3 }),
      event(50, "chat", "和主人聊了 4 字", { chars: 4 }),
    ];
    const result = groupTimelineEvents(events, config);
    expect(result).toHaveLength(2);
    expect(result[0].text).toContain("2 轮");
    expect(result[1].text).toContain("1 轮");
  });

  it("normalizes a single chat event and falls back to text length", () => {
    const events = [event(0, "chat", "和主人聊了 12 字")];
    const result = groupTimelineEvents(events, config);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("和主人聊了 1 轮，约 12 字");
  });
});

describe("timeline ordering", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-timeline-"));
    roots.push(root);
    const p = paths(root);
    ensureLayout(p);
    return p;
  }

  it("sorts by timestamp when a catch-up writes an earlier moment", () => {
    const p = setup();
    appendTimeline(p, config, { kind: "room", text: "中午", ts: at(0) });
    appendTimeline(p, config, { kind: "room", text: "下午", ts: at(60) });
    appendTimeline(p, config, { kind: "room", text: "补写的早上", ts: at(-120) });

    expect(readTimeline(p, "2026-11-18").map((item) => item.text)).toEqual(["补写的早上", "中午", "下午"]);
  });

  it("only summarizes events up to the planned moment", () => {
    const p = setup();
    appendTimeline(p, config, { kind: "room", text: "九点的事", ts: at(0) });
    appendTimeline(p, config, { kind: "room", text: "十点以后", ts: at(60) });

    const summary = timelineSummary(p, config, "2026-11-18", 14, at(10));
    expect(summary).toContain("九点的事");
    expect(summary).not.toContain("十点以后");
  });
});
