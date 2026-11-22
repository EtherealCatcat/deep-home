import type {
  AppConfig,
  AvatarInfo,
  ChatMessage,
  ConsolidateOutcome,
  DebugPayload,
  DiaryMeta,
  MemorySnapshot,
  Relationship,
  Reminder,
  SettingsPayload,
  Sticker,
  Status,
  TimelineEvent,
} from "./types";

export let API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ||
  "http://127.0.0.1:7788";

export function setApiBase(base: string): void {
  API_BASE = base.replace(/\/$/, "");
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 把服务端返回的相对资源路径解析成当前运行时可用的地址。 */
export function assetUrl(url: string): string {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/.test(url)) return url;
  if (url.startsWith("/api/")) return `${API_BASE}${url}`;
  // /avatar.png 这类前端打包资源仍按页面相对路径解析。
  return url;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>("/api/status"),
  avatar: () => request<AvatarInfo>("/api/avatar/info"),
  uploadAvatar: (dataUrl: string) =>
    request<{ ok: boolean; avatar: AvatarInfo }>("/api/avatar", {
      method: "POST",
      body: JSON.stringify({ dataUrl }),
    }),
  resetAvatar: () => request<{ ok: boolean; avatar: AvatarInfo }>("/api/avatar", { method: "DELETE" }),
  messages: (limit = 120) => request<{ messages: ChatMessage[] }>(`/api/messages?limit=${limit}`),
  send: (text: string, quoteId?: string, image?: string) =>
    request<{ ok: boolean; message: ChatMessage }>("/api/messages", {
      method: "POST",
      body: JSON.stringify({ text, quoteId, image }),
    }),
  sendSticker: (sticker: string, quoteId?: string) =>
    request<{ ok: boolean; message: ChatMessage }>("/api/messages", {
      method: "POST",
      body: JSON.stringify({ sticker, quoteId }),
    }),
  stickers: () => request<{ stickers: Sticker[] }>("/api/stickers"),
  read: () => request<{ ok: boolean }>("/api/read", { method: "POST" }),
  ownSeen: () => request<{ ok: boolean }>("/api/own/seen", { method: "POST" }),
  stop: () => request<{ ok: boolean }>("/api/stop", { method: "POST" }),
  burst: () => request<{ active: boolean; count: number }>("/api/burst"),
  setBurst: (active: boolean) =>
    request<{ ok: boolean; active: boolean; count: number }>("/api/burst", {
      method: "POST",
      body: JSON.stringify({ active }),
    }),
  cancelBurst: () =>
    request<{ ok: boolean; cancelled: number; active: boolean; count: number }>("/api/burst/cancel", {
      method: "POST",
    }),
  newSession: () => request<{ ok: boolean }>("/api/new", { method: "POST" }),
  memory: () => request<MemorySnapshot>("/api/memory"),
  saveMemory: (name: string, content: string) =>
    request<{ ok: boolean }>("/api/memory", {
      method: "PUT",
      body: JSON.stringify({ name, content }),
    }),
  persona: () => request<{ persona: string; defaultPersona: string }>("/api/persona"),
  savePersona: (content: string) =>
    request<{ ok: boolean }>("/api/persona", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  diaries: () => request<{ diaries: DiaryMeta[] }>("/api/diary"),
  diary: (day: string) => request<{ day: string; content: string }>(`/api/diary/${day}`),
  writeDiary: () => request<{ ok: boolean; error?: string }>("/api/diary/write", { method: "POST" }),
  timeline: (day?: string) =>
    request<{ day: string; events: TimelineEvent[]; heading: string }>(
      `/api/timeline${day ? `?day=${encodeURIComponent(day)}` : ""}`,
    ),
  relationship: () =>
    request<{
      relationship: Relationship;
      daysKnown: number;
      description: string;
      growth: { label: string; text: string }[];
    }>("/api/relationship"),
  reminders: () => request<{ reminders: Reminder[] }>("/api/reminders"),
  addReminder: (text: string, due: string, kind: "owner" | "care" = "owner") =>
    request<{ ok: boolean; reminder: Reminder }>("/api/reminders", {
      method: "POST",
      body: JSON.stringify({ text, due, kind }),
    }),
  doneReminder: (id: string) =>
    request<{ ok: boolean }>(`/api/reminders/${id}/done`, { method: "POST" }),
  cancelReminder: (id: string) =>
    request<{ ok: boolean }>(`/api/reminders/${id}`, { method: "DELETE" }),
  settings: () => request<SettingsPayload>("/api/settings"),
  saveSettings: (config: Partial<AppConfig>) =>
    request<{ ok: boolean; config: AppConfig; note?: string }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),
  testModel: (config: Partial<AppConfig>) =>
    request<{
      ok: boolean;
      text?: string;
      model?: string;
      error?: string;
      kind?: string;
      code?: string;
    }>("/api/test-model", {
      method: "POST",
      body: JSON.stringify({ config }),
    }),
  retry: () => request<{ ok: boolean; count: number }>("/api/retry", { method: "POST" }),
  debug: () => request<DebugPayload>("/api/debug"),
  consolidate: () => request<ConsolidateOutcome>("/api/debug/consolidate", { method: "POST" }),
  backfillMilestones: () =>
    request<{ ok: boolean; added: number }>("/api/relationship/backfill", { method: "POST" }),
  reaction: (text: string) =>
    request<{ ok: boolean }>("/api/reaction", { method: "POST", body: JSON.stringify({ text }) }),
};

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    new Date(year, month - 1, date).getDay()
  ];
  return `${month} 月 ${date} 日 · ${weekday}`;
}

export function relativeTime(ts: number): string {
  if (!ts) return "还没有";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function minToClock(min: number): string {
  const value = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function clockToMin(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}
