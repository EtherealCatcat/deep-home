import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, ensureLayout, paths } from "../src/config.js";
import { appendChatMessage, quoteLine, readDayMessages, removeUserMessagesSince, toLLMHistory } from "../src/chat.js";
import type { ChatMessage } from "../src/types.js";

const config = structuredClone(DEFAULT_CONFIG);
const quote = {
  id: "u1",
  role: "user" as const,
  kind: "text" as const,
  text: "今天有点累",
  ts: new Date("2026-11-18T09:30:00+08:00").getTime(),
};

describe("quoted messages", () => {
  it("renders a quote line with the owner title and time", () => {
    const line = quoteLine(quote, config);
    expect(line).toContain("（引用 主人");
    expect(line).toContain("09:30");
    expect(line).toContain("今天有点累");
  });

  it("renders image and sticker references compactly", () => {
    const imageQuote = { ...quote, kind: "image" as const, text: "看看这个" };
    expect(quoteLine(imageQuote, config)).toContain("[图片]");
    const messages: ChatMessage[] = [
      {
        id: "i1",
        ts: quote.ts,
        role: "user",
        kind: "image",
        text: "看看这个",
        meta: { file: "inbox-1.png" },
        dayKey: "2026-11-18",
      },
      {
        id: "s1",
        ts: quote.ts + 1000,
        role: "assistant",
        kind: "sticker",
        text: "不服气",
        meta: { file: "001-不服气.webp", desc: "斜眼看你，表示无语" },
        dayKey: "2026-11-18",
      },
    ];
    const history = toLLMHistory(messages, 10, config);
    expect(history[0].content).toContain("[图片：看看这个]");
    expect(history[1].content).toContain("[表情:不服气（斜眼看你，表示无语）]");
  });

  it("prepends quote lines to LLM history", () => {
    const messages: ChatMessage[] = [
      {
        id: "u1",
        ts: quote.ts,
        role: "user",
        kind: "text",
        text: "今天有点累",
        dayKey: "2026-11-18",
      },
      {
        id: "a1",
        ts: quote.ts + 1000,
        role: "assistant",
        kind: "text",
        text: "那先歇一会儿。",
        dayKey: "2026-11-18",
        quote,
      },
    ];
    const history = toLLMHistory(messages, 10, config);
    expect(history[1].content).toContain("（引用 主人 09:30：今天有点累）");
    expect(history[1].content).toContain("那先歇一会儿。");
  });
});

describe("cancelling a burst", () => {
  const config = structuredClone(DEFAULT_CONFIG);

  it("removes user messages since the burst start and keeps the earlier ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-chat-"));
    try {
      const p = paths(root);
      ensureLayout(p);
      const start = new Date("2026-11-18T10:00:00+08:00").getTime();
      appendChatMessage(p, config, { role: "user", kind: "text", text: "开始之前", ts: start - 2_000 });
      appendChatMessage(p, config, { role: "assistant", kind: "text", text: "嗯。", ts: start - 1_000 });
      appendChatMessage(p, config, { role: "user", kind: "text", text: "连发一", ts: start + 10 });
      appendChatMessage(p, config, { role: "user", kind: "text", text: "连发二", ts: start + 20 });

      expect(removeUserMessagesSince(p, config, start)).toBe(2);
      expect(readDayMessages(p, "2026-11-18").map((message) => message.text)).toEqual(["开始之前", "嗯。"]);
      expect(removeUserMessagesSince(p, config, start)).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops the day file when every message was cancelled", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-chat-"));
    try {
      const p = paths(root);
      ensureLayout(p);
      const start = new Date("2026-11-18T10:00:00+08:00").getTime();
      appendChatMessage(p, config, { role: "user", kind: "text", text: "唯一一条", ts: start + 10 });

      expect(removeUserMessagesSince(p, config, start)).toBe(1);
      expect(readDayMessages(p, "2026-11-18")).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("silent catch-up messages", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the planned timestamp and the silent meta", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deephome-chat-"));
    roots.push(root);
    const p = paths(root);
    ensureLayout(p);
    const planned = new Date("2026-11-18T12:20:00+08:00").getTime();

    appendChatMessage(p, config, {
      role: "assistant",
      kind: "proactive",
      text: "昨晚看到一只猫",
      ts: planned,
      meta: { proactive: true, silent: true, catchUp: true },
    });

    const [saved] = readDayMessages(p, "2026-11-18");
    expect(saved.ts).toBe(planned);
    expect(saved.dayKey).toBe("2026-11-18");
    expect(saved.meta?.silent).toBe(true);
    expect(saved.meta?.catchUp).toBe(true);
  });
});
