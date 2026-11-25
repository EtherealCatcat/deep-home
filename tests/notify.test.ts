import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => true));
const isVisible = vi.hoisted(() => vi.fn(async () => true));
const sendNotification = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isVisible }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  onAction: vi.fn(async () => undefined),
  sendNotification,
}));
vi.mock("../web/src/api.js", () => ({ isTauri: () => true }));

import {
  initNotifications,
  notifyDiary,
  notifyMessage,
  setCharacterName,
  setNotificationsEnabled,
} from "../web/src/notify.js";

function nativeCalls() {
  return invoke.mock.calls.filter((call) => call[0] === "notify_native");
}

describe("notifications", () => {
  beforeAll(async () => {
    await initNotifications();
  });

  beforeEach(() => {
    invoke.mockClear();
    isVisible.mockClear();
    isVisible.mockResolvedValue(false);
    sendNotification.mockClear();
    setNotificationsEnabled(true);
    setCharacterName("鲸鲸");
  });

  it("sends a message notification titled with the character name", async () => {
    await notifyMessage("在吗");
    expect(nativeCalls()).toEqual([
      ["notify_native", { title: "鲸鲸", body: "在吗", sound: true }],
    ]);
  });

  it("follows the character name after it changes", async () => {
    setCharacterName("阿鲸");
    await notifyMessage("我回来啦");
    expect(nativeCalls()[0]?.[1]).toMatchObject({ title: "阿鲸", body: "我回来啦" });
  });

  it("notifies while the window is closed", async () => {
    await notifyMessage("在吗");
    await notifyDiary();
    expect(nativeCalls()).toHaveLength(2);
  });

  it("stays quiet while the window is visible", async () => {
    isVisible.mockResolvedValue(true);
    await notifyMessage("在吗");
    await notifyDiary();
    expect(nativeCalls()).toHaveLength(0);
  });

  it("notifies when a diary is written", async () => {
    await notifyDiary();
    expect(nativeCalls()).toEqual([
      [
        "notify_native",
        {
          title: "鲸鲸",
          body: "她写好了今天的日记，快来看看吧",
          sound: true,
        },
      ],
    ]);
  });

  it("respects the notifications toggle", async () => {
    setNotificationsEnabled(false);
    await notifyMessage("在吗");
    expect(nativeCalls()).toHaveLength(0);
  });
});
