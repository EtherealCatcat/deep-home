import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildNow, buildSystem } from "../src/persona.js";
import { defaultRelationship } from "../src/relationship.js";

const config = structuredClone(DEFAULT_CONFIG);
const now = new Date("2026-11-18T12:00:00+08:00").getTime();
const room = { name: "大肥鱼的家", status: "窝在床上看书", detail: "书摊在膝盖上。", updatedAt: now };

function input(activity?: string) {
  return {
    config,
    kind: "chat" as const,
    now,
    rhythm: "醒着",
    mood: { base: 60, dims: {}, updatedAt: now, history: [] },
    room,
    todaySummary: "",
    reminders: [],
    relationship: defaultRelationship(config),
    lastOwnerAt: 0,
    todayMessages: 0,
    proactiveToday: 0,
    recalls: [],
    justRemembered: [],
    stickers: [],
    activity,
  };
}

describe("chat prompt", () => {
  it("carries her latest own-time activity into the moment block", () => {
    expect(buildNow(input("刚才看了一篇关于海的文章"))).toContain("【手头】刚才看了一篇关于海的文章");
    expect(buildNow(input())).not.toContain("【手头】");
  });

  it("tells her to let the room follow what she does", () => {
    expect(buildSystem({ config, kind: "own", memory: "", relationship: defaultRelationship(config), yesterdaySummary: "", room, persona: "" })).toContain("用 room_do 让房间跟着变");
  });
});
