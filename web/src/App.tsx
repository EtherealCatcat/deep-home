import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { API_BASE, api, assetUrl, isTauri } from "./api";
import { initNotifications, notifyDiary, notifyMessage, setCharacterName, setNotificationsEnabled } from "./notify";
import { AvatarContext, DEFAULT_AVATAR } from "./avatar";
import type { ChatMessage, Page, ServerEvent, Status } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { TodayView } from "./components/TodayView";
import { MemoryView } from "./components/MemoryView";
import { DiaryView } from "./components/DiaryView";
import { PersonaView } from "./components/PersonaView";
import { GrowthView } from "./components/GrowthView";
import { SettingsView } from "./components/SettingsView";
import { DebugView } from "./components/DebugView";

type ToastKind = "info" | "error";

const pages: Page[] = ["chat", "today", "memory", "diary", "persona", "growth", "settings", "debug"];

function pageFromHash(): Page {
  const value = window.location.hash.replace(/^#/, "") as Page;
  return pages.includes(value) ? value : "chat";
}

export default function App() {
  const [page, setPageState] = useState<Page>(pageFromHash);
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [avatar, setAvatar] = useState(DEFAULT_AVATAR);
  const [avatarCustom, setAvatarCustom] = useState(false);
  const [connected, setConnected] = useState(false);
  const [timelineTick, setTimelineTick] = useState(0);
  const [toast, setToast] = useState<{ text: string; kind: ToastKind } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const pageRef = useRef<Page>(page);
  const burstRef = useRef(false);
  const lastNotifyAt = useRef(0);
  const lastErrorToast = useRef("");

  pageRef.current = page;
  burstRef.current = status?.burst ?? false;

  const setPage = useCallback((next: Page) => {
    setPageState(next);
    if (window.location.hash !== `#${next}`) {
      window.history.replaceState(null, "", `#${next}`);
    }
  }, []);

  const showToast = useCallback((text: string, kind: ToastKind = "info") => {
    setToast({ text, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev : [...prev, message].slice(-240)));
  }, []);

  const markRead = useCallback(async () => {
    try {
      await api.read();
      setReadAt(Date.now());
      setStatus((prev) => (prev ? { ...prev, unread: 0 } : prev));
    } catch {
      // 已读失败不影响聊天。
    }
  }, []);

  useEffect(() => {
    void api
      .avatar()
      .then((info) => {
        setAvatar(assetUrl(info.url));
        setAvatarCustom(info.custom);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void api
      .settings()
      .then(({ config }) => {
        setCharacterName(config.name);
        setNotificationsEnabled(config.ui.notificationsEnabled);
        if (config.ui.notificationsEnabled) void initNotifications();
      })
      .catch(() => {
        void initNotifications();
      });
  }, []);

  useEffect(() => {
    if (status?.name) setCharacterName(status.name);
  }, [status?.name]);

  useEffect(() => {
    if (!isTauri() || !status) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("update_tray", {
          unread: status.unread,
          own: status.own?.unread ?? 0,
          label: status.own?.lastResult ?? "",
        }),
      )
      .catch(() => undefined);
  }, [status?.unread, status?.own?.unread, status?.own?.lastResult]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("navigate", (event) => {
          const next = event.payload.replace(/^#/, "") as Page;
          if (!pages.includes(next)) return;
          setPage(next);
          if (next === "chat") void markRead();
        }),
      )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [markRead, setPage]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.status(), api.messages(120)])
      .then(([nextStatus, history]) => {
        if (!alive) return;
        setStatus(nextStatus);
        setMessages(history.messages);
        if (nextStatus.setupRequired && !window.location.hash) setPage("settings");
      })
      .catch((error) => {
        if (!alive) return;
        showToast(error instanceof Error ? error.message : "连不上本地服务。", "error");
      });
    return () => {
      alive = false;
    };
  }, [setPage, showToast]);

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const source = new EventSource(`${API_BASE}/api/events`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      switch (data.type) {
        case "status":
          setStatus(data.status);
          break;
        case "message":
          lastErrorToast.current = "";
          addMessage(data.message);
          if (data.message.role === "assistant" && !burstRef.current && !data.message.meta?.silent) {
            const now = Date.now();
            if (now - lastNotifyAt.current > 30_000) {
              lastNotifyAt.current = now;
              const preview =
                data.message.kind === "sticker"
                  ? `[表情] ${String(data.message.meta?.emoji ?? "")}`
                  : data.message.kind === "image"
                    ? "[发来一张图]"
                    : data.message.text;
              void notifyMessage(preview);
            }
          }
          break;
        case "typing":
          setTyping(data.on);
          break;
        case "read":
          setReadAt(data.at);
          break;
        case "busy":
          setStatus((prev) => (prev ? { ...prev, busy: data.busy } : prev));
          if (!data.busy) setTyping(false);
          break;
        case "error":
          // 同一条故障只提醒一次；持续状态交给聊天页顶部的状态条。
          if (data.message && data.message !== lastErrorToast.current) {
            lastErrorToast.current = data.message;
            showToast(data.message, "error");
          }
          break;
        case "timeline":
          setTimelineTick((value) => value + 1);
          break;
        case "diary":
          showToast("她写完了今天的日记。");
          void notifyDiary();
          break;
        case "burst_cancel":
          setMessages((prev) =>
            prev.filter((message) => !(message.role === "user" && message.ts >= data.from)),
          );
          setStatus((prev) => (prev ? { ...prev, burst: false, burstCount: 0 } : prev));
          break;
        case "mood":
          setStatus((prev) => (prev ? { ...prev, mood: data.mood } : prev));
          break;
        case "done":
          setTyping(false);
          break;
        default:
          break;
      }
    };

    return () => source.close();
  }, [addMessage, showToast]);

  useEffect(() => {
    if (page !== "chat" || document.visibilityState !== "visible") return;
    const timer = window.setTimeout(() => void markRead(), 420);
    return () => window.clearTimeout(timer);
  }, [page, messages.length, markRead]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && pageRef.current === "chat") void markRead();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [markRead]);

  useEffect(() => {
    if (page !== "today" || document.visibilityState !== "visible") return;
    if (!status?.own?.unread) return;
    void api
      .ownSeen()
      .then(() =>
        setStatus((prev) => (prev ? { ...prev, own: { ...prev.own, unread: 0 } } : prev)),
      )
      .catch(() => undefined);
  }, [page, status?.own?.unread]);

  async function sendSticker(name: string) {
    try {
      const result = await api.sendSticker(name);
      addMessage(result.message);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "表情没发出去。", "error");
      throw error;
    }
  }

  async function send(text: string, quote?: ChatMessage, image?: string) {
    const trimmed = text.trim();
    if (!trimmed && !image) return;
    try {
      const result = await api.send(trimmed, quote?.id, image);
      addMessage(result.message);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "没发出去。", "error");
      throw error;
    }
  }

  async function toggleBurst(active: boolean) {
    try {
      const result = await api.setBurst(active);
      setStatus((prev) => (prev ? { ...prev, burst: result.active, burstCount: result.count } : prev));
      showToast(active ? "连发模式已开：她先不打断你，发完再一起看。" : "已经发给她了，等她慢慢回。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "连发模式切换失败。", "error");
      throw error;
    }
  }

  async function retryChat() {
    try {
      await api.retry();
      setStatus((prev) => (prev ? { ...prev, lastChatError: undefined } : prev));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "重试失败。", "error");
      throw error;
    }
  }

  async function cancelBurst() {
    try {
      const result = await api.cancelBurst();
      setStatus((prev) => (prev ? { ...prev, burst: result.active, burstCount: result.count } : prev));
      showToast(result.cancelled > 0 ? `已撤销 ${result.cancelled} 条消息。` : "这次连发没有要撤销的消息。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "撤销失败。", "error");
      throw error;
    }
  }

  function navigate(next: Page) {
    setPage(next);
    if (next === "chat") void markRead();
  }

  return (
    <AvatarContext.Provider value={avatar}>
    <div className="flex h-screen overflow-hidden">
      <Sidebar status={status} page={page} onNavigate={navigate} connected={connected} />

      <main className={`min-w-0 flex-1 ${page === "chat" ? "h-full overflow-hidden" : "h-full overflow-y-auto"}`}>
        {page === "chat" ? (
          <ChatView
            status={status}
            messages={messages}
            typing={typing}
            readAt={readAt}
            onSend={send}
            onSticker={sendSticker}
            onBurst={toggleBurst}
            onCancelBurst={cancelBurst}
            onNavigateSettings={() => navigate("settings")}
            onRetry={retryChat}
          />
        ) : page === "today" ? (
          <TodayView status={status} showToast={showToast} timelineTick={timelineTick} />
        ) : page === "memory" ? (
          <MemoryView showToast={showToast} />
        ) : page === "diary" ? (
          <DiaryView showToast={showToast} />
        ) : page === "persona" ? (
          <PersonaView showToast={showToast} />
        ) : page === "growth" ? (
          <GrowthView showToast={showToast} />
        ) : page === "settings" ? (
          <SettingsView
            showToast={showToast}
            avatar={avatar}
            avatarCustom={avatarCustom}
            onAvatarChange={(url, custom) => {
              setAvatar(url);
              setAvatarCustom(custom);
            }}
          />
        ) : (
          <DebugView showToast={showToast} />
        )}
      </main>

      {toast ? (
        <div
          className={`fixed bottom-5 left-1/2 z-50 flex max-w-[min(92vw,520px)] -translate-x-1/2 items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-[11.5px] shadow-lg backdrop-blur-md ${
            toast.kind === "error"
              ? "border-coral/30 bg-[#fff5f0]/95 text-coral-deep"
              : "border-sea/25 bg-[#f4faf6]/95 text-sea-deep"
          }`}
        >
          {toast.kind === "error" ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="leading-5">{toast.text}</span>
          <button type="button" onClick={() => setToast(null)} className="ml-1 opacity-50 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
    </AvatarContext.Provider>
  );
}
