import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

let granted = false;
let initialized = false;
let native = false;
let enabled = true;
let characterName = "鲸鲸";
let clickTarget = "chat";

export function setNotificationsEnabled(value: boolean): void {
  enabled = value;
}

/** 通知标题跟着角色名走；设置页改名后由状态广播刷新。 */
export function setCharacterName(name: string): void {
  const clean = name.trim();
  if (clean) characterName = clean;
}

/** 点通知时回到触发它的页面（消息→聊天，日记→日记）。 */
function openPage(page: string): void {
  const target = /^[a-z]+$/.test(page) ? page : "chat";
  window.location.hash = `#${target}`;
  void invoke("focus_main").catch(() => undefined);
}

function listenForClicks(): void {
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen("notification-clicked", () => openPage(clickTarget)))
    .catch(() => undefined);
}

/**
 * 用户点叉号时 Rust 侧只是把窗口隐藏，webview 还活着、SSE 还在跑；
 * 这种状态按“窗口已关闭”处理，不要弹任何通知。
 */
async function windowVisible(): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isVisible();
  } catch {
    // 查不到可见性时宁可安静：需求是“窗口关掉后不打扰”。
    return false;
  }
}

export async function initNotifications(): Promise<void> {
  if (!isTauri() || initialized) return;
  initialized = true;
  try {
    // macOS 上走 Rust 侧的原生通道（UNUserNotificationCenter + willPresent），
    // 这样 App 在前台也能弹横幅；插件通道在 macOS 上用的是已废弃的
    // NSUserNotificationCenter，前台时系统会把横幅吞掉。
    native = await invoke<boolean>("notify_supported").catch(() => false);
    listenForClicks();
    const notification = await import("@tauri-apps/plugin-notification");
    granted = await notification.isPermissionGranted();
    if (!granted) {
      granted = (await notification.requestPermission()) === "granted";
    }
    if (!granted && !native) return;
    await notification.onAction(() => openPage(clickTarget));
  } catch (error) {
    console.warn("通知初始化失败。", error);
  }
}

async function deliver(title: string, body: string, page = "chat"): Promise<void> {
  clickTarget = page;
  if (native) {
    try {
      await invoke("notify_native", { title, body, sound: true });
      return;
    } catch (error) {
      console.warn("原生通知失败，退回插件通道。", error);
      native = false;
    }
  }
  const notification = await import("@tauri-apps/plugin-notification");
  await notification.sendNotification({ title, body });
}

export async function notifyMessage(text: string): Promise<void> {
  if (!enabled || (!granted && !native)) return;
  const body = text.trim().slice(0, 160);
  if (!body) return;
  if (!(await windowVisible())) return;
  try {
    await deliver(characterName, body, "chat");
  } catch (error) {
    console.warn("发送通知失败。", error);
  }
}

export async function notifyDiary(): Promise<void> {
  if (!enabled || (!granted && !native)) return;
  if (!(await windowVisible())) return;
  try {
    await deliver(characterName, "她写好了今天的日记，快来看看吧", "diary");
  } catch (error) {
    console.warn("发送日记通知失败。", error);
  }
}

export async function sendTestNotification(): Promise<void> {
  if (!isTauri()) throw new Error("系统通知只在桌面应用里可用。");
  const notification = await import("@tauri-apps/plugin-notification");
  const allowed = (await notification.isPermissionGranted()) || (await notification.requestPermission()) === "granted";
  if (!allowed && !native) throw new Error("通知权限没有开；去系统设置里允许 DeepHome 通知。");
  granted = true;
  await deliver(characterName, "通知已接通。今晚也早点睡。");
}
