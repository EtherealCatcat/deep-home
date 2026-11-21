import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { roomActionForOwnTime, roomIsStale, ROOM_STALE_MS } from "../src/room.js";

const now = new Date("2026-11-18T12:00:00+08:00").getTime();

describe("own-time room actions", () => {
  it("maps what she did to a room action", () => {
    expect(roomActionForOwnTime(["web_read"])).toBe("看书");
    expect(roomActionForOwnTime(["rss_read", "note_read"])).toBe("看书");
    expect(roomActionForOwnTime(["note_write"])).toBe("收拾");
    expect(roomActionForOwnTime(["recall"])).toBe("发呆");
    expect(roomActionForOwnTime([])).toBe("发呆");
  });

  it("treats a room untouched for six hours as stale", () => {
    const room = { name: "大肥鱼的家", status: "窝在床上看书", detail: "书摊在膝盖上。", updatedAt: now };
    expect(roomIsStale(room, now + ROOM_STALE_MS - 1)).toBe(false);
    expect(roomIsStale(room, now + ROOM_STALE_MS)).toBe(true);
    expect(roomIsStale({ ...room, updatedAt: 0 }, now)).toBe(true);
  });
});
