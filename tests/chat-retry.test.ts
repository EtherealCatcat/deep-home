import { describe, expect, it } from "vitest";
import { planRetry } from "../src/chat.js";
import type { ChatMessage } from "../src/types.js";

let counter = 0;
function message(role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  counter += 1;
  return {
    id: `${role}-${counter}`,
    ts: 1_700_000_000_000 + counter,
    role,
    kind: "text",
    text,
    dayKey: "2026-11-18",
    ...extra,
  };
}

describe("planRetry", () => {
  it("rejects when the last message is not a failed user message", () => {
    const history = [message("user", "在吗"), message("assistant", "在的")];
    expect(planRetry(history, 0)).toEqual({ ok: false, status: 400, error: "没有要重试的消息。" });
    expect(planRetry([], 0).ok).toBe(false);
  });

  it("reuses the user messages after the last assistant reply", () => {
    const history = [message("user", "在吗"), message("assistant", "在的"), message("user", "今天怎么样")];
    const plan = planRetry(history, 0);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("今天怎么样");
    expect(plan.firstTs).toBe(history[2].ts);
    expect(plan.count).toBe(1);
  });

  it("joins consecutive user messages and keeps the first quote", () => {
    const quote = { id: "a1", role: "assistant" as const, kind: "text" as const, text: "早", ts: 1 };
    const history = [
      message("assistant", "早"),
      message("user", "第一句", { quote }),
      message("user", "第二句"),
    ];
    const plan = planRetry(history, 0);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.text).toBe("第一句\n第二句");
    expect(plan.quote).toEqual(quote);
    expect(plan.count).toBe(2);
  });

  it("refuses stickers", () => {
    const history = [message("user", "表情", { kind: "sticker" })];
    expect(planRetry(history, 0)).toEqual({ ok: false, status: 400, error: "表情不好重试，再发一次吧。" });
  });

  it("refuses more than one image", () => {
    const history = [
      message("user", "图一", { kind: "image", meta: { file: "a.png", mime: "image/png" } }),
      message("user", "图二", { kind: "image", meta: { file: "b.png", mime: "image/png" } }),
    ];
    expect(planRetry(history, 0)).toEqual({ ok: false, status: 400, error: "一次只能重发一张图片。" });
  });

  it("keeps a single image and its metadata", () => {
    const history = [
      message("user", "看图", { kind: "image", meta: { file: "a.png", mime: "image/png" } }),
    ];
    const plan = planRetry(history, 0);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.image).toEqual({ file: "a.png", mime: "image/png" });
  });

  it("refuses messages that fell out of the retained history", () => {
    const history = [message("user", "很久以前")];
    expect(planRetry(history, history[0].ts + 1)).toEqual({
      ok: false,
      status: 400,
      error: "这段已经翻篇了，重新说吧。",
    });
  });
});
