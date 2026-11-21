import { Fragment, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCheck, ChevronLeft, ChevronRight, Feather, ImagePlus, ListPlus, LoaderCircle, Quote, RotateCcw, Send, Smile, Sparkles, X } from "lucide-react";
import type { ChatMessage, QuoteRef, Status, Sticker } from "../types";
import { API_BASE, api, formatDay, formatTime } from "../api";
import { prepareImage, type PreparedImage } from "../image";
import { WhaleAvatar } from "./ui";
import { StickerImage } from "./StickerImage";
import { useAvatar } from "../avatar";

function MiniAvatar() {
  const avatar = useAvatar();
  return (
    <img
      src={avatar}
      alt=""
      draggable={false}
      className="mt-0.5 h-7 w-7 shrink-0 rounded-full bg-white/40 object-cover shadow-sm ring-1 ring-white/40"
    />
  );
}

function DayDivider({ day }: { day: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <div className="h-px flex-1 bg-line/50" />
      <span className="text-[10px] tracking-[0.12em] text-ink-faint">{formatDay(day)}</span>
      <div className="h-px flex-1 bg-line/50" />
    </div>
  );
}

function QuoteBlock({ quote }: { quote: QuoteRef }) {
  const who = quote.role === "user" ? "你" : "鲸鲸";
  const body =
    quote.kind === "sticker" ? `[表情] ${quote.text}` : quote.kind === "image" ? "[图片]" : quote.text;
  return (
    <button
      type="button"
      onClick={() => document.getElementById(`msg-${quote.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
      className="mb-1.5 block w-full rounded-lg border-l-2 border-coral/45 bg-ink/[0.04] px-2.5 py-1.5 text-left transition hover:bg-ink/[0.07]"
      title="跳到原消息"
    >
      <div className="truncate text-[9.5px] text-coral-deep/80">{who}</div>
      <div className="line-clamp-2 text-[10.5px] leading-4 text-ink-soft">{body}</div>
    </button>
  );
}

function MessageRow({
  message,
  readAt,
  showRead,
  onQuote,
}: {
  message: ChatMessage;
  readAt: number | null;
  showRead: boolean;
  onQuote: (message: ChatMessage) => void;
}) {
  const proactive = Boolean(message.meta?.proactive);

  if (message.kind === "silent") return null;

  if (message.role === "user" && message.kind === "sticker") {
    const file = String(message.meta?.file ?? "");
    return (
      <div id={`msg-${message.id}`} className="fade-up group flex justify-end">
        <div className="flex min-w-0 max-w-[62%] flex-col items-end">
          {message.quote ? <QuoteBlock quote={message.quote} /> : null}
          {file ? (
            <StickerImage
              src={`${API_BASE}/stickers/${encodeURIComponent(file.replace(/^\/+/, ""))}`}
              alt={message.text}
              className="max-h-40 max-w-[170px]"
            />
          ) : (
            <div className="bubble-me">{message.text}</div>
          )}
          <div className="mt-1 flex items-center justify-end gap-1.5 pr-1 text-[10px] text-ink-faint">
            {showRead && readAt && readAt >= message.ts ? (
              <span className="inline-flex items-center gap-0.5 text-sea/80">
                <CheckCheck className="h-3 w-3" />
                已读
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onQuote(message)}
              className="inline-flex items-center gap-0.5 text-[9.5px] opacity-0 transition hover:text-coral group-hover:opacity-100"
            >
              <Quote className="h-2.5 w-2.5" />
              引用
            </button>
            <span>{formatTime(message.ts)}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "user" && message.kind === "image") {
    const file = String(message.meta?.file ?? "");
    return (
      <div id={`msg-${message.id}`} className="fade-up group flex justify-end">
        <div className="flex min-w-0 max-w-[82%] flex-col items-end">
          {message.quote ? <QuoteBlock quote={message.quote} /> : null}
          <img
            src={`${API_BASE}/media/${file.replace(/^\/+/, "")}`}
            alt="你发来的图片"
            className="max-h-72 max-w-full rounded-2xl border border-line/60 object-cover shadow-sm"
          />
          {message.text && message.text !== "（发来一张图片）" ? (
            <div className="bubble-me mt-1.5">{message.text}</div>
          ) : null}
          <div className="mt-1 flex items-center justify-end gap-1.5 pr-1 text-[10px] text-ink-faint">
            {showRead && readAt && readAt >= message.ts ? (
              <span className="inline-flex items-center gap-0.5 text-sea/80">
                <CheckCheck className="h-3 w-3" />
                已读
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onQuote(message)}
              className="inline-flex items-center gap-0.5 text-[9.5px] opacity-0 transition hover:text-coral group-hover:opacity-100"
            >
              <Quote className="h-2.5 w-2.5" />
              引用
            </button>
            <span>{formatTime(message.ts)}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div id={`msg-${message.id}`} className="fade-up group flex justify-end">
        <div className="flex min-w-0 max-w-[82%] flex-col items-end">
          {message.quote ? <QuoteBlock quote={message.quote} /> : null}
          <div className="bubble-me">{message.text}</div>
          <div className="mt-1 flex items-center justify-end gap-1.5 pr-1 text-[10px] text-ink-faint">
            {showRead && readAt && readAt >= message.ts ? (
              <span className="inline-flex items-center gap-0.5 text-sea/80">
                <CheckCheck className="h-3 w-3" />
                已读
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => onQuote(message)}
              className="inline-flex items-center gap-0.5 text-[9.5px] opacity-0 transition hover:text-coral group-hover:opacity-100"
            >
              <Quote className="h-2.5 w-2.5" />
              引用
            </button>
            <span>{formatTime(message.ts)}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.kind === "sticker") {
    const emoji = String(message.meta?.emoji ?? "🫧");
    const file = String(message.meta?.file ?? "");
    return (
      <div id={`msg-${message.id}`} className="fade-up flex items-start gap-2.5">
        <MiniAvatar />
        <div>
          {file ? (
            <StickerImage
              src={`${API_BASE}/stickers/${encodeURIComponent(file.replace(/^\/+/, ""))}`}
              alt={message.text}
              className="max-h-44 max-w-[180px]"
            />
          ) : (
            <div className="grid h-20 w-20 place-items-center rounded-[20px] border border-line/60 bg-white/55 text-4xl shadow-sm">
              {emoji}
            </div>
          )}
          <div className="mt-1 pl-1 text-[10px] text-ink-faint">{message.text}</div>
        </div>
      </div>
    );
  }

  if (message.kind === "image") {
    const file = String(message.meta?.file ?? "");
    return (
      <div id={`msg-${message.id}`} className="fade-up flex items-start gap-2.5">
        <MiniAvatar />
        <img
          src={`${API_BASE}/media/${file.replace(/^\/+/, "")}`}
          alt="她发来的图片"
          className="max-h-72 max-w-[78%] rounded-2xl border border-line/60 object-cover shadow-sm"
        />
      </div>
    );
  }

  if (message.kind === "monologue") {
    return (
      <div id={`msg-${message.id}`} className="fade-up group flex items-start gap-2.5">
        <div className="w-7 shrink-0" />
        <div className="monologue">
          <div className="mb-1 text-[9px] font-sans uppercase tracking-[0.18em] text-ink-faint">
            心里想
          </div>
          {message.text}
          <button
            type="button"
            onClick={() => onQuote(message)}
            className="ml-2 inline-flex align-middle text-[9px] text-ink-faint opacity-0 transition hover:text-coral group-hover:opacity-100"
          >
            引用
          </button>
        </div>
      </div>
    );
  }

  return (
    <div id={`msg-${message.id}`} className="fade-up group flex items-start gap-2.5">
      <MiniAvatar />
      <div className="min-w-0 max-w-[82%]">
        {message.quote ? <QuoteBlock quote={message.quote} /> : null}
        {proactive ? (
          <div className="mb-1 flex items-center gap-1 pl-0.5 text-[9.5px] tracking-[0.06em] text-coral/75">
            <Sparkles className="h-2.5 w-2.5" />
            她主动找你
          </div>
        ) : null}
        <div className="bubble-her">{message.text}</div>
        <div className="mt-1 flex items-center gap-1.5 pl-1 text-[10px] text-ink-faint">
          <span>{formatTime(message.ts)}</span>
          <button
            type="button"
            onClick={() => onQuote(message)}
            className="inline-flex items-center gap-0.5 text-[9.5px] opacity-0 transition hover:text-coral group-hover:opacity-100"
          >
            <Quote className="h-2.5 w-2.5" />
            引用
          </button>
          {showRead && readAt && readAt >= message.ts ? (
            <span className="inline-flex items-center gap-0.5 text-sea/80">
              <CheckCheck className="h-3 w-3" />
              已读
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="fade-up flex items-end gap-2.5">
      <MiniAvatar />
      <div className="flex items-center gap-1.5 rounded-[19px] rounded-bl-[6px] border border-line/60 bg-[#fcf8f1] px-4 py-3 shadow-sm">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}

function PeakPill({ status }: { status: Status }) {
  const peak = status.pricing.isPeak;
  const disabled = !status.pricing.peakEnabled;
  return (
    <div
      className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] sm:inline-flex ${
        disabled
          ? "border-line/60 bg-ink/5 text-ink-faint"
          : peak
            ? "border-gold/30 bg-gold/10 text-[#876529]"
            : "border-sea/25 bg-sea/10 text-sea-deep"
      }`}
      title={disabled ? "峰谷计费与降载已关闭" : `${status.pricing.reason} · 下次切换 ${formatTime(status.pricing.nextChangeAt)}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${peak ? "bg-gold" : "bg-sea"}`} />
      {disabled ? "峰谷关闭" : peak ? "忙时 · 说话简短" : "闲时"}
    </div>
  );
}

export function ChatView({
  status,
  messages,
  typing,
  readAt,
  onSend,
  onSticker,
  onBurst,
  onCancelBurst,
  onNavigateSettings,
  onRetry,
}: {
  status: Status | null;
  messages: ChatMessage[];
  typing: boolean;
  readAt: number | null;
  onSend: (text: string, quote?: ChatMessage, image?: string) => Promise<void>;
  onSticker: (name: string) => Promise<void>;
  onBurst: (active: boolean) => Promise<void>;
  onCancelBurst: () => Promise<void>;
  onNavigateSettings: () => void;
  onRetry: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [quote, setQuote] = useState<ChatMessage | null>(null);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cancellingBurst, setCancellingBurst] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [stickerPage, setStickerPage] = useState(0);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerError, setStickerError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const lastMessage = messages[messages.length - 1];
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const readReceiptId =
    lastMessage?.role === "assistant" && lastMessage.kind !== "silent"
      ? lastMessage.id
      : lastUserMessage?.id;

  useEffect(() => {
    if (quote && !messages.some((m) => m.id === quote.id)) setQuote(null);
  }, [messages, quote]);

  useEffect(() => {
    if (!stickerOpen || stickers.length) return;
    let cancelled = false;
    setStickerLoading(true);
    setStickerError(null);
    void api
      .stickers()
      .then((result) => {
        if (!cancelled) setStickers(result.stickers.filter((item) => Boolean(item.file)));
      })
      .catch((error) => {
        if (!cancelled) setStickerError(error instanceof Error ? error.message : "表情加载失败。");
      })
      .finally(() => {
        if (!cancelled) setStickerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stickerOpen, stickers.length]);


  useEffect(() => {
    stick.current = true;
    const timer = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }, 40);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (stick.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, typing]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  async function submit(value?: string) {
    const content = (value ?? text).trim();
    if ((!content && !image) || sending || preparing) return;
    setSending(true);
    try {
      await onSend(content, quote ?? undefined, image?.dataUrl);
      setText("");
      setQuote(null);
      setImage(null);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
        textareaRef.current.focus();
      }
    } finally {
      setSending(false);
    }
  }

  async function attach(file: File | undefined) {
    if (!file || preparing) return;
    setPreparing(true);
    setImageError(null);
    try {
      setImage(await prepareImage(file));
      setImageError(null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "这张图处理不了。");
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function chooseSticker(sticker: Sticker) {
    if (!sticker.file || sending || preparing || burst) return;
    setSending(true);
    try {
      await onSticker(sticker.name);
      setStickerOpen(false);
    } finally {
      setSending(false);
    }
  }

  const asleep = status?.rhythm.phase === "asleep";
  const burst = Boolean(status?.burst);
  const burstCount = status?.burstCount ?? 0;
  const provider = status?.provider;
  const lastChatError = status?.lastChatError;
  const latestMessage = messages[messages.length - 1];
  const providerBar = Boolean(provider && provider.state !== "ok") || Boolean(lastChatError);
  const failedSend =
    latestMessage?.role === "user" &&
    !status?.busy &&
    !status?.burst &&
    (Boolean(provider && provider.state !== "ok") || Boolean(lastChatError));
  const needsSettings =
    provider?.state === "auth" ||
    provider?.state === "config" ||
    lastChatError?.kind === "auth" ||
    lastChatError?.kind === "config";
  const canRetry = failedSend && (lastChatError ? lastChatError.retryable : true);
  const stickerPageSize = 10;

  useEffect(() => {
    if (burst) setStickerOpen(false);
  }, [burst]);
  const stickerPageCount = Math.max(1, Math.ceil(stickers.length / stickerPageSize));
  const stickerPageItems = stickers.slice(stickerPage * stickerPageSize, (stickerPage + 1) * stickerPageSize);

  async function finishBurst() {
    if (sending || preparing) return;
    if (text.trim() || image) await submit();
    await onBurst(false);
  }

  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  async function undoBurst() {
    if (cancellingBurst) return;
    setCancellingBurst(true);
    try {
      await onCancelBurst();
      setQuote(null);
    } finally {
      setCancellingBurst(false);
    }
  }

  useEffect(() => {
    if (stickerPage >= stickerPageCount) setStickerPage(stickerPageCount - 1);
  }, [stickerPage, stickerPageCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3.5 border-b border-line/55 bg-[rgba(247,240,230,0.5)] px-5 py-3.5 backdrop-blur-md sm:px-7">
        <WhaleAvatar size="lg" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="serif truncate text-[21px] font-semibold tracking-tight text-ink">
              {status?.name ?? "鲸鲸"}
            </h1>
            {status?.rhythm.woken ? (
              <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[9px] text-[#876529]">
                刚被吵醒
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-soft">
            <span className="truncate">{status?.rhythm.status ?? "在书桌前发呆"}</span>
            <span className="text-line">·</span>
            <span className="truncate">{status?.moodLabel ?? "心情还不错"}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2.5">
          <PeakPill status={status ?? emptyStatus} />
          <button
            type="button"
            onClick={onNavigateSettings}
            className="hidden text-right text-[10px] leading-4 text-ink-faint transition hover:text-coral sm:block"
            title="查看今日用量和计费设置"
          >
            <div className="tabular text-[11px] text-ink-soft">
              ¥{(status?.usage.costCny ?? 0).toFixed(2)}
            </div>
            <div>今日用量</div>
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7"
      >
        <div className="mx-auto flex w-full max-w-[780px] flex-col gap-3.5">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center px-4 pb-10 pt-10 text-center sm:pt-16">
              <div className="relative mb-6">
                <WhaleAvatar size="xl" />
                <span className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border border-line/70 bg-paper-light text-[12px] shadow-sm">
                  🫧
                </span>
              </div>
              <h2 className="serif text-[23px] font-semibold text-ink">房间里很安静</h2>
              <p className="mt-2 max-w-sm text-[13px] leading-7 text-ink-soft">
                她在书桌前发呆，台灯亮着，鱼缸在冒泡。
                <br />
                说句话，或者只是打个招呼。
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {["在做什么呀？", "今天有点累。", "你还记得我们第一次说话吗？"].map((line) => (
                  <button
                    key={line}
                    type="button"
                    onClick={() => void submit(line)}
                    className="rounded-full border border-line/80 bg-white/45 px-3.5 py-1.5 text-[11.5px] text-ink-soft transition hover:border-coral/35 hover:bg-white/80 hover:text-coral-deep"
                  >
                    {line}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <Fragment key={message.id}>
              {index === 0 || messages[index - 1].dayKey !== message.dayKey ? (
                <DayDivider day={message.dayKey} />
              ) : null}
              <MessageRow
                message={message}
                readAt={readAt}
                showRead={message.id === readReceiptId}
                onQuote={(target) => {
                  setQuote(target);
                  textareaRef.current?.focus();
                }}
              />
            </Fragment>
          ))}

          {typing ? <TypingBubble /> : null}
          <div ref={bottomRef} className="h-1" />
        </div>
      </div>

      <div className="border-t border-line/55 bg-[rgba(247,240,230,0.55)] px-4 pb-4 pt-3 backdrop-blur-md sm:px-7">
        <div className="mx-auto w-full max-w-[780px]">
          {providerBar ? (
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-300/50 bg-amber-50/70 px-3 py-2 text-[10.5px] text-ink-soft">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-700" />
              {failedSend ? (
                <span className="font-medium text-amber-800">这条没发出去</span>
              ) : null}
              <span className="min-w-0 flex-1">
                {provider?.state && provider.state !== "ok" ? `${provider.label} · ${provider.detail}` : lastChatError?.message}
              </span>
              {needsSettings ? (
                <button
                  type="button"
                  onClick={onNavigateSettings}
                  className="shrink-0 rounded-full border border-ink/15 px-3 py-1 font-medium text-ink-soft transition hover:border-ink/25 hover:bg-white/70"
                >
                  去设置
                </button>
              ) : null}
              {canRetry ? (
                <button
                  type="button"
                  onClick={() => void retry()}
                  disabled={retrying}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-amber-600 px-3 py-1 font-medium text-white transition hover:bg-amber-700 disabled:opacity-50"
                >
                  {retrying ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {burst ? (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-sea/25 bg-sea/[0.06] px-3 py-2">
              <ListPlus className="h-3.5 w-3.5 shrink-0 text-sea-deep" />
              <div className="min-w-0 flex-1 text-[10.5px] text-ink-soft">
                <span className="font-medium text-sea-deep">连发中</span>
                <span className="text-ink-faint">
                  {" "}
                  · {burstCount} 条待发送 - 点击「撤销」回退所有消息
                </span>
              </div>
              <button
                type="button"
                onClick={() => void undoBurst()}
                disabled={cancellingBurst || sending || preparing}
                className="shrink-0 rounded-full border border-ink/15 px-3 py-1 text-[10.5px] font-medium text-ink-soft transition hover:border-ink/25 hover:bg-white/70 disabled:opacity-50"
              >
                撤销
              </button>
              <button
                type="button"
                onClick={() => void finishBurst()}
                disabled={cancellingBurst || sending || preparing}
                className="shrink-0 rounded-full bg-sea px-3 py-1 text-[10.5px] font-medium text-white transition hover:bg-sea-deep disabled:opacity-50"
              >
                发完了
              </button>
            </div>
          ) : null}
          {image ? (
            <div className="mb-2 flex items-center gap-2.5 rounded-xl border border-line/70 bg-white/50 p-2">
              <img src={image.dataUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-ink-soft">{image.name}</div>
                <div className="text-[9.5px] text-ink-faint">
                  {image.width}×{image.height} · 会一起发给她
                </div>
              </div>
              <button
                type="button"
                onClick={() => setImage(null)}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint transition hover:bg-white/70 hover:text-coral"
                title="取消图片"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {imageError ? (
            <div className="mb-2 rounded-lg border border-coral/25 bg-coral/5 px-3 py-1.5 text-[10px] text-coral-deep">
              {imageError}
            </div>
          ) : null}
          {quote ? (
            <div className="mb-2 flex items-start gap-2 rounded-xl border border-coral/25 bg-coral/5 px-3 py-2">
              <Quote className="mt-0.5 h-3 w-3 shrink-0 text-coral/70" />
              <div className="min-w-0 flex-1">
                <div className="text-[9px] tracking-[0.08em] text-coral-deep/75">
                  引用 {quote.role === "user" ? "你" : "鲸鲸"}
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-ink-soft">
                  {quote.kind === "sticker" ? `[表情] ${quote.text}` : quote.text}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setQuote(null)}
                className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-ink-faint transition hover:bg-white/70 hover:text-coral"
                title="取消引用"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
          {stickerOpen ? (
            <div className="mb-2 rounded-2xl border border-line/70 bg-[rgba(255,252,247,0.92)] p-3 shadow-[0_8px_24px_rgba(82,61,42,.06)]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink">
                  <Smile className="h-3.5 w-3.5 text-coral" />
                  表情
                </div>
                <button
                  type="button"
                  onClick={() => setStickerOpen(false)}
                  className="grid h-6 w-6 place-items-center rounded-full text-ink-faint transition hover:bg-white/80 hover:text-coral"
                  title="收起表情"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              {stickerLoading ? (
                <div className="flex h-32 items-center justify-center text-[11px] text-ink-faint">
                  <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  正在翻表情包…
                </div>
              ) : stickerError ? (
                <div className="rounded-lg border border-coral/20 bg-coral/5 px-3 py-2 text-[10.5px] text-coral-deep">
                  {stickerError}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-5 gap-1.5">
                    {stickerPageItems.map((sticker) => (
                      <button
                        key={sticker.name}
                        type="button"
                        onClick={() => void chooseSticker(sticker)}
                        disabled={sending || preparing}
                        className="group/sticker grid aspect-square place-items-center rounded-xl border border-transparent p-1 transition hover:border-coral/25 hover:bg-white/70 disabled:opacity-40"
                        title={`${sticker.name}${sticker.desc ? ` · ${sticker.desc}` : ""}`}
                      >
                        <StickerImage
                          src={`${API_BASE}/stickers/${encodeURIComponent(String(sticker.file).replace(/^\/+/, ""))}`}
                          alt={sticker.name}
                          className="h-full w-full object-contain"
                        />
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[9.5px] text-ink-faint">
                    <button
                      type="button"
                      onClick={() => setStickerPage((value) => Math.max(0, value - 1))}
                      disabled={stickerPage <= 0}
                      className="grid h-6 w-6 place-items-center rounded-full transition hover:bg-white/80 hover:text-coral disabled:opacity-30"
                      title="上一页"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <span className="tabular-nums">
                      第 {stickerPage + 1} / {stickerPageCount} 页
                    </span>
                    <button
                      type="button"
                      onClick={() => setStickerPage((value) => Math.min(stickerPageCount - 1, value + 1))}
                      disabled={stickerPage >= stickerPageCount - 1}
                      className="grid h-6 w-6 place-items-center rounded-full transition hover:bg-white/80 hover:text-coral disabled:opacity-30"
                      title="下一页"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    <span className="ml-auto">共 {stickers.length} 个 · 表情来源：ming</span>
                  </div>
                </>
              )}
            </div>
          ) : null}
          <div className="flex items-end gap-2 rounded-[20px] border border-line/80 bg-[rgba(255,252,247,0.82)] p-1.5 pl-2 shadow-[0_8px_26px_rgba(82,61,42,.05)] transition focus-within:border-coral/40 focus-within:shadow-[0_0_0_3px_rgba(207,114,87,.08)]">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void attach(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => void onBurst(!burst)}
              className={`mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full transition ${
                burst ? "bg-sea/15 text-sea-deep" : "text-ink-faint hover:bg-white/70 hover:text-coral"
              }`}
              title={burst ? "结束连发，让她看整段" : "连发模式：先攒着，不打断她"}
              aria-label={burst ? "结束连发" : "连发模式"}
              aria-pressed={burst}
            >
              <ListPlus className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={preparing || sending || burst}
              className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-faint transition hover:bg-white/70 hover:text-coral disabled:opacity-40"
              title={burst ? "连发时先只发文字，图片请单独发" : "发一张图片"}
              aria-label={burst ? "连发时暂不支持图片" : "发一张图片"}
            >
              {preparing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            </button>
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) => {
                setText(event.target.value);
                const el = event.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && (quote || stickerOpen)) {
                  setQuote(null);
                  setStickerOpen(false);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={burst ? "继续发…她还没收到" : asleep ? "她睡着了，留言会等到早上…" : "和鲸鲸说点什么…"}
              className="max-h-[150px] min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[14.5px] leading-6 text-ink outline-none placeholder:text-ink-faint/80"
            />
            <button
              type="button"
              onClick={() => setStickerOpen((value) => !value)}
              disabled={sending || preparing || burst}
              className={`mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full transition disabled:opacity-40 ${
                stickerOpen ? "bg-coral/15 text-coral-deep" : "text-ink-faint hover:bg-white/70 hover:text-coral"
              }`}
              title={burst ? "连发时先只发文字" : stickerOpen ? "收起表情" : "发一个表情"}
              aria-label="表情"
              aria-expanded={stickerOpen}
            >
              <Smile className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={(!text.trim() && !image) || sending || preparing}
              className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-coral text-white shadow-sm transition hover:bg-coral-deep disabled:cursor-default disabled:bg-line disabled:text-ink-faint"
              aria-label="发送"
            >
              <Send className="h-4 w-4 -translate-x-px" strokeWidth={1.9} />
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between px-1 text-[9.5px] text-ink-faint">
            <span>{burst ? `连发中 · ${burstCount} 条还没发出去 · 点「发完了」再交给她` : "Enter 发送 · Shift + Enter 换行"}</span>
            <span className="inline-flex items-center gap-1">
              <Feather className="h-2.5 w-2.5" />
              她可能已读不回，也可能突然找你
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const emptyStatus = {
  pricing: {
    isPeak: false,
    reason: "按北京时间自动切换",
    nextChangeAt: Date.now(),
  },
  usage: { costCny: 0 },
} as unknown as Status;

