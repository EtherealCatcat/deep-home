import { useEffect, useState } from "react";
import {
  Bell,
  BookOpen,
  Brain,
  Check,
  Clock3,
  Coffee,
  Compass,
  LoaderCircle,
  MessageCircle,
  Moon,
  Plus,
  RefreshCw,
  Share2,
  Sparkles,
  Sun,
  Sunrise,
  Waves,
  X,
} from "lucide-react";
import { api, formatDay, formatTime, relativeTime } from "../api";
import type { Reminder, Status, TimelineEvent } from "../types";
import { Badge, Card, SectionTitle } from "./ui";

const eventMeta: Record<string, { icon: typeof Sun; tone: string }> = {
  chat: { icon: MessageCircle, tone: "text-sea" },
  speak: { icon: Sparkles, tone: "text-coral" },
  memory: { icon: Brain, tone: "text-gold" },
  diary: { icon: BookOpen, tone: "text-gold" },
  remind: { icon: Bell, tone: "text-coral" },
  room: { icon: Waves, tone: "text-sea" },
  mood: { icon: Sun, tone: "text-gold" },
  sleep: { icon: Moon, tone: "text-ink-faint" },
  wake: { icon: Sunrise, tone: "text-gold" },
  web: { icon: Coffee, tone: "text-sea" },
  own: { icon: Compass, tone: "text-sea" },
  share: { icon: Share2, tone: "text-coral" },
};

function OwnCard({ status }: { status: Status }) {
  const own = status.own;
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">她自己的时间</div>
        <span className={`text-[10px] ${own.active ? "text-sea" : "text-ink-faint"}`}>
          {own.enabled ? (own.active ? "正在过" : "开着") : "关着"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${own.active ? "animate-pulse bg-sea" : "bg-line"}`} />
        <span className="text-[12.5px] text-ink">{own.active ? "她正在做自己的事" : own.label}</span>
      </div>
      {own.lastResult ? (
        <p className="mt-2 line-clamp-3 text-[10.5px] leading-5 text-ink-soft">{own.lastResult}</p>
      ) : (
        <p className="mt-2 text-[10.5px] leading-5 text-ink-faint">
          还没留下记录。到时间她会去读点东西、翻翻笔记，或者只是坐着。
        </p>
      )}
    </Card>
  );
}

function EventRow({ event }: { event: TimelineEvent }) {
  const meta = eventMeta[event.kind] ?? { icon: Sun, tone: "text-ink-faint" };
  const Icon = meta.icon;
  return (
    <div className="relative flex gap-3 pb-5 pl-1 last:pb-0">
      <div className="relative z-10 mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line/70 bg-paper-light">
        <Icon className={`h-3.5 w-3.5 ${meta.tone}`} strokeWidth={1.7} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-baseline gap-2">
          <span className="tabular shrink-0 text-[10.5px] text-ink-faint">{formatTime(event.ts)}</span>
          <span className="line-clamp-2 break-words text-[12.5px] text-ink" title={event.text}>
            {event.text}
          </span>
        </div>
        {event.meta && Object.keys(event.meta).length > 0 ? (
          <div className="mt-0.5 truncate text-[10px] text-ink-faint">
            {Object.entries(event.meta)
              .filter(([, value]) => typeof value === "string" || typeof value === "number")
              .slice(0, 3)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MoodCard({ status }: { status: Status }) {
  const dims = Object.entries(status.mood.dims)
    .filter(([, value]) => value > 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">她的心情</div>
        <span className="text-[11px] text-coral/80">{status.moodLabel}</span>
      </div>
      <div className="mb-1 flex items-end justify-between">
        <span className="serif text-[28px] leading-none text-ink">{Math.round(status.mood.base)}</span>
        <span className="mb-0.5 text-[10px] text-ink-faint">基调 / 100</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sea via-gold to-coral transition-all duration-700"
          style={{ width: `${Math.max(3, Math.min(100, status.mood.base))}%` }}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {dims.length === 0 ? (
          <span className="text-[10.5px] text-ink-faint">今天心里很平</span>
        ) : (
          dims.map(([name, value]) => (
            <span
              key={name}
              className="rounded-full border border-line/70 bg-white/40 px-2 py-0.5 text-[10px] text-ink-soft"
            >
              {dimLabel(name)} {Math.round(value)}
            </span>
          ))
        )}
      </div>
    </Card>
  );
}

function dimLabel(key: string): string {
  const labels: Record<string, string> = {
    happy: "开心",
    calm: "平静",
    sweet: "甜",
    miss: "想你",
    shy: "害羞",
    worry: "担心",
    sad: "难过",
    jealous: "吃醋",
    angry: "生气",
    bored: "无聊",
    heartache: "心软",
  };
  return labels[key] ?? key;
}

function ReminderRow({
  reminder,
  onDone,
  onCancel,
}: {
  reminder: Reminder;
  onDone: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <div className="group flex items-start gap-2.5 border-b border-line/45 py-2.5 last:border-0">
      <button
        type="button"
        onClick={() => onDone(reminder.id)}
        className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-line text-transparent transition hover:border-sea hover:text-sea"
        title="标记完成"
      >
        <Check className="h-2.5 w-2.5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-5 text-ink">{reminder.text}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[9.5px] text-ink-faint">
          <Clock3 className="h-2.5 w-2.5" />
          {formatTime(reminder.dueAt)}
          <span>·</span>
          {reminder.kind === "care" ? "她惦记的" : "你交代的"}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onCancel(reminder.id)}
        className="mt-0.5 text-ink-faint/0 transition group-hover:text-ink-faint hover:!text-coral"
        title="取消"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function TodayView({ status, showToast }: { status: Status | null; showToast: (text: string, kind?: "info" | "error") => void }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [heading, setHeading] = useState("");
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState("");
  const [newDue, setNewDue] = useState("明天 09:00");
  const [adding, setAdding] = useState(false);

  async function load() {
    try {
      const [timeline, rem] = await Promise.all([api.timeline(), api.reminders()]);
      setEvents(timeline.events);
      setHeading(timeline.heading);
      setReminders(rem.reminders);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取今天失败。", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [status?.lastMessageAt, status?.lastOwnerAt]);

  async function addReminder() {
    if (!newText.trim() || !newDue.trim() || adding) return;
    setAdding(true);
    try {
      await api.addReminder(newText.trim(), newDue.trim());
      setNewText("");
      showToast("记下了。到点会提醒你。");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "没记住这个时间。", "error");
    } finally {
      setAdding(false);
    }
  }

  async function doneReminder(id: string) {
    await api.doneReminder(id);
    await load();
  }

  async function cancelReminder(id: string) {
    await api.cancelReminder(id);
    await load();
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
      <SectionTitle
        eyebrow="TODAY"
        title="今天"
        desc={heading || formatDay(status?.rhythm.day ?? "")}
        action={
          <button type="button" onClick={() => void load()} className="btn-ghost">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <Card className="min-w-0 p-5 sm:p-6">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="serif text-[17px] text-ink">今天发生的事</h3>
            <Badge tone="sea">
              {events.length} 件
            </Badge>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 py-10 text-[12px] text-ink-soft">
              <LoaderCircle className="h-4 w-4 animate-spin text-coral/70" />
              正在翻今天的时间线…
            </div>
          ) : events.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line/80 px-5 py-10 text-center">
              <Sun className="mx-auto mb-3 h-5 w-5 text-gold/70" />
              <p className="text-[12.5px] text-ink-soft">今天还什么都没发生。</p>
              <p className="mt-1 text-[10.5px] text-ink-faint">说句话，或者等她自己找过来。</p>
            </div>
          ) : (
            <div className="relative">
              <div className="absolute bottom-2 left-[15px] top-2 w-px bg-line/55" />
              {events.map((event, index) => (
                <EventRow key={`${event.ts}-${index}`} event={event} />
              ))}
            </div>
          )}
        </Card>

        <div className="min-w-0 space-y-4">
          <MoodCard status={status ?? emptyMoodStatus} />

          {status ? <OwnCard status={status} /> : null}

          <Card className="p-5">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">今天的花费</div>
              <span className="text-[10px] text-ink-faint">人民币</span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="tabular text-[24px] font-medium text-ink">
                ¥{(status?.usage.costCny ?? 0).toFixed(2)}
              </span>
              <span className="text-[10px] text-ink-faint">今天</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
              <div className="rounded-lg bg-paper-deep/35 px-2.5 py-2">
                <div className="text-ink-faint">模型调用</div>
                <div className="tabular mt-0.5 text-[13px] text-ink">{status?.usage.calls ?? 0}</div>
              </div>
              <div className="rounded-lg bg-paper-deep/35 px-2.5 py-2">
                <div className="text-ink-faint">忙时 / 闲时</div>
                <div className="tabular mt-0.5 text-[13px] text-ink">
                  {status?.usage.peakCalls ?? 0} / {status?.usage.offPeakCalls ?? 0}
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-[10px] text-ink-faint">
              <span>
                {!status?.pricing.peakEnabled
                  ? "峰谷已关闭，全时段按闲时运行"
                  : status.pricing.isPeak
                    ? "现在忙时，她说话会更短"
                    : "现在闲时，可以慢慢聊"}
              </span>
              <span>{Math.round((status?.usage.costCny ?? 0) * 100)}%</span>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="serif text-[17px] text-ink">惦记着</h3>
              <Badge tone="coral">{reminders.length}</Badge>
            </div>
            {reminders.length === 0 ? (
              <p className="py-2 text-[11px] text-ink-faint">没有待办。她记性很好，你交代的都会记着。</p>
            ) : (
              <div className="mb-3">
                {reminders.map((reminder) => (
                  <ReminderRow
                    key={reminder.id}
                    reminder={reminder}
                    onDone={(id) => void doneReminder(id)}
                    onCancel={(id) => void cancelReminder(id)}
                  />
                ))}
              </div>
            )}
            <div className="mt-2 space-y-2 border-t border-line/50 pt-3">
              <input
                value={newText}
                onChange={(event) => setNewText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addReminder();
                }}
                placeholder="提醒她什么？"
                className="input-warm min-w-0"
              />
              <div className="flex gap-2">
                <input
                  value={newDue}
                  onChange={(event) => setNewDue(event.target.value)}
                  className="input-warm min-w-0 flex-1"
                  placeholder="明天 09:00"
                />
                <button
                  type="button"
                  onClick={() => void addReminder()}
                  disabled={adding || !newText.trim()}
                  className="grid w-8 shrink-0 place-items-center rounded-lg bg-coral text-white disabled:opacity-40"
                  title="添加提醒"
                >
                  {adding ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              <p className="text-[9px] leading-4 text-ink-faint">
                可以写「明天 09:00」「今晚 22:30」「30 分钟后」。
              </p>
            </div>
          </Card>

          <div className="flex items-center justify-between px-1 text-[10px] text-ink-faint">
            <span>上次联系 {relativeTime(status?.lastOwnerAt ?? 0)}</span>
            <span>{status?.todayMessages ?? 0} 句 · 主动 {status?.proactiveToday ?? 0} 次</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const emptyMoodStatus = {
  mood: { base: 65, dims: {}, updatedAt: Date.now(), history: [] },
  moodLabel: "心情还不错",
} as unknown as Status;
