import { useEffect, useRef, useState } from "react";
import {
  Braces,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  FileText,
  LoaderCircle,
  RefreshCw,
  Server,
  Terminal,
  Wand2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { api, isTauri } from "../api";
import type { DebugPayload } from "../types";
import { Badge, Card, Loading, SectionTitle } from "./ui";

type DebugTab = "system" | "now" | "raw" | "tools" | "history";

interface PendingCatchUpView {
  plannedAt?: number;
  windowEnd?: number;
  attempts?: number;
  nextRetryAt?: number;
  lastErrorKind?: string;
  lastError?: string;
  createdAt?: number;
}

const debugTabs: { key: DebugTab; label: string }[] = [
  { key: "system", label: "系统提示词" },
  { key: "now", label: "此刻" },
  { key: "raw", label: "原始输出" },
  { key: "tools", label: "工具调用" },
  { key: "history", label: "历史" },
];

function Pre({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, open]);

  return (
    <div>
      <pre
        ref={ref}
        className={`rounded-xl border border-line/60 bg-[rgba(255,252,247,0.5)] p-3.5 font-mono text-[10.5px] leading-5 whitespace-pre-wrap break-words text-ink-soft ${
          open ? "" : "max-h-[430px] overflow-auto"
        }`}
      >
        {text || "（空）"}
      </pre>
      {overflowing || open ? (
        <div className="mt-2 flex items-center justify-end gap-3 text-[10px] text-ink-faint">
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(text)}
            className="transition hover:text-coral"
          >
            复制
          </button>
          <button type="button" onClick={() => setOpen((value) => !value)} className="transition hover:text-coral">
            {open ? "收起" : `展开全文（${text.length} 字）`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function DebugView({ showToast }: { showToast: (text: string, kind?: "info" | "error") => void }) {
  const [data, setData] = useState<DebugPayload | null>(null);
  const [tab, setTab] = useState<DebugTab>("system");
  const [refreshing, setRefreshing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  async function load(show = false) {
    setRefreshing(true);
    try {
      setData(await api.debug());
      if (show) showToast("已经刷新。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取调试信息失败。", "error");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function backfill() {
    if (backfilling) return;
    setBackfilling(true);
    try {
      const result = await api.backfillMilestones();
      showToast(result.added > 0 ? `补录完成，新增 ${result.added} 条记号。` : "没有需要补录的记号。");
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "补录失败。", "error");
    } finally {
      setBackfilling(false);
    }
  }

  async function consolidate() {
    if (consolidating) return;
    setConsolidating(true);
    try {
      const result = await api.consolidate();
      if (result.ok) {
        showToast("记忆整理完成，旧版本已备份。");
        await load();
      } else {
        showToast(result.error ?? "整理失败。", "error");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "整理失败。", "error");
    } finally {
      setConsolidating(false);
    }
  }

  if (!data) {
    return (
      <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
        <SectionTitle eyebrow="DEBUG" title="调试" desc="看她在想什么，也看她哪里卡住了。" />
        <Loading />
      </div>
    );
  }

  const turn = data.lastTurn;
  const catchUp =
    (data.own as { pendingCatchUp?: PendingCatchUpView | null } | undefined)?.pendingCatchUp ?? null;
  const turnText =
    tab === "system"
      ? turn?.system ?? ""
      : tab === "now"
        ? turn?.nowBlock ?? ""
        : tab === "raw"
          ? turn?.raw ?? ""
          : tab === "tools"
            ? JSON.stringify(turn?.toolCalls ?? [], null, 2)
            : JSON.stringify(turn?.history ?? [], null, 2);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-7 sm:px-8">
      <SectionTitle
        eyebrow="DEBUG"
        title="调试"
        desc="给愿意看细节的人。这里的东西不会影响她怎么说话。"
        action={
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load(true)} className="btn-ghost">
              {refreshing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </button>
            <button type="button" onClick={() => void backfill()} disabled={backfilling} className="btn-ghost">
              {backfilling ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
              补录记号
            </button>
            <button type="button" onClick={() => void consolidate()} disabled={consolidating} className="btn-primary">
              {consolidating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              整理记忆
            </button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="p-4">
          <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            <Cpu className="h-3 w-3" />
            模型
          </div>
          <div className="font-mono text-[12px] text-ink">{data.config.model.model}</div>
          <div className="mt-1 truncate text-[9.5px] text-ink-faint">{data.config.model.baseUrl}</div>
          <div className="mt-2">
            {data.config.model.apiKey ? (
              <Badge tone="sea">
                <CheckCircle2 className="h-2.5 w-2.5" /> 已配置 Key
              </Badge>
            ) : (
              <Badge tone="coral">缺少 Key</Badge>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            <Clock className="h-3 w-3" />
            此刻
          </div>
          <div className="text-[12px] text-ink">{data.status.rhythm.label}</div>
          <div className="mt-1 text-[9.5px] text-ink-faint">{data.status.rhythm.status}</div>
          <div className="mt-2 text-[9.5px] text-ink-faint">
            {data.status.busy ? "正在想" : "安静着"} · {data.status.room.status}
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            <Database className="h-3 w-3" />
            今日用量
          </div>
          <div className="font-mono text-[12px] text-ink">¥{data.usage.costCny.toFixed(3)}</div>
          <div className="mt-1 text-[9.5px] text-ink-faint">
            {data.usage.calls} 次调用 · {data.usage.promptTokens + data.usage.completionTokens} token
          </div>
          <div className="mt-2">
            <Badge tone={data.status.pricing.peakEnabled ? data.status.pricing.isPeak ? "coral" : "sea" : "sea"}>
              {!data.status.pricing.peakEnabled ? "峰谷关闭" : data.status.pricing.isPeak ? "高峰" : "空闲"} · {data.status.pricing.budgetState}
            </Badge>
          </div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            <Braces className="h-3 w-3" />
            队列
          </div>
          <div className="font-mono text-[12px] text-ink">{data.deferred.length} 个延后任务</div>
          <div className="mt-1 text-[9.5px] text-ink-faint">峰时不做后台，闲时补上。</div>
        </Card>

        <Card className="p-4">
          <div className="mb-2 inline-flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.16em] text-ink-faint">
            <Server className="h-3 w-3" />
            服务
          </div>
          <div className="font-mono text-[12px] text-ink">
            {isTauri() ? "端口自动分配" : `端口 ${window.location.port || data.config.ui.port}`}
          </div>
          <div className="mt-1 truncate text-[9.5px] text-ink-faint">~/Library/Logs/DeepHome/server.log</div>
          {isTauri() ? (
            <button
              type="button"
              onClick={() => void invoke("open_logs").catch(() => showToast("打不开日志目录。", "error"))}
              className="mt-2 inline-flex items-center gap-1 text-[10px] text-sea-deep hover:text-coral"
            >
              <FileText className="h-3 w-3" />
              打开日志
            </button>
          ) : null}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_300px]">
        <Card className="p-5 sm:p-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              <Terminal className="h-3 w-3" />
              最近一轮
            </div>
            <div className="flex flex-wrap gap-1">
              {debugTabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                    tab === item.key ? "bg-ink text-paper" : "text-ink-faint hover:bg-white/50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          {turn ? (
            <>
              <div className="mb-2 text-[9px] text-ink-faint">
                {new Date(turn.at).toLocaleString("zh-CN")} · {turn.silent ? "这一轮没有开口" : `${turn.bubbles.length} 个气泡`}
              </div>
              <Pre key={tab} text={turnText} />
            </>
          ) : (
            <p className="py-12 text-center text-[11px] text-ink-faint">还没有跑过一轮。去聊一句就有了。</p>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">模型服务</div>
              <span
                className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] ${
                  data.provider.state === "ok" ? "bg-sea/10 text-sea-deep" : "bg-coral/10 text-coral"
                }`}
              >
                {data.provider.state}
              </span>
            </div>
            <div className="text-[11.5px] leading-5 text-ink">{data.provider.label}</div>
            <div className="mt-0.5 text-[10px] text-ink-faint">{data.provider.detail}</div>
            <div className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
              连续失败 {data.provider.consecutiveFailures} 次
              {data.provider.openUntil
                ? ` · 熔断到 ${new Date(data.provider.openUntil).toLocaleTimeString("zh-CN")}`
                : ""}
              {data.provider.retryAt ? ` · 限流到 ${new Date(data.provider.retryAt).toLocaleTimeString("zh-CN")}` : ""}
            </div>
            <div className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
              探活 {data.provider.lastProbeAt ? new Date(data.provider.lastProbeAt).toLocaleTimeString("zh-CN") : "-"} ·{" "}
              {data.provider.lastProbeAt ? (data.provider.lastProbeOk ? "可达" : "失败") : "未探测"}
            </div>
            {data.provider.lastFailure ? (
              <div className="mt-1.5 rounded-lg bg-ink/[0.03] px-2 py-1.5 font-mono text-[9.5px] leading-4 text-ink-faint">
                <span className="text-ink-soft">{data.provider.lastFailure.kind}</span> ·{" "}
                {data.provider.lastFailure.message}
                {data.provider.lastFailure.code ? ` · ${data.provider.lastFailure.code}` : ""}
                {data.provider.lastFailure.status ? ` · HTTP ${data.provider.lastFailure.status}` : ""}
              </div>
            ) : null}
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">最近一次模型失败</div>
              {data.lastLlmError ? (
                <span className="rounded-full bg-coral/10 px-1.5 py-0.5 font-mono text-[9px] text-coral">
                  {data.lastLlmError.kind}
                </span>
              ) : null}
            </div>
            {data.lastLlmError ? (
              <>
                <div className="text-[11.5px] leading-5 text-ink">{data.lastLlmError.message}</div>
                <div className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
                  {new Date(data.lastLlmError.at).toLocaleString("zh-CN")} · 第 {data.lastLlmError.attempts} 次尝试
                </div>
                <div className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
                  {data.lastLlmError.code || "no-code"} · HTTP {data.lastLlmError.status || "-"}
                </div>
                <div className="mt-0.5 truncate font-mono text-[9.5px] text-ink-faint">{data.lastLlmError.model}</div>
              </>
            ) : (
              <p className="text-[10px] text-ink-faint">最近没有失败记录。</p>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.16em] text-ink-faint">待补跑</div>
              {catchUp ? (
                <span className="rounded-full bg-sea/10 px-1.5 py-0.5 font-mono text-[9px] text-sea-deep">
                  {catchUp.attempts ?? 0} 次
                </span>
              ) : null}
            </div>
            {catchUp ? (
              <>
                <div className="text-[11.5px] leading-5 text-ink">
                  {catchUp.plannedAt ? new Date(catchUp.plannedAt).toLocaleString("zh-CN") : "时间未知"}
                </div>
                <div className="mt-1.5 font-mono text-[9.5px] text-ink-faint">
                  下次重试 {catchUp.nextRetryAt ? new Date(catchUp.nextRetryAt).toLocaleTimeString("zh-CN") : "-"}
                </div>
                <div className="mt-0.5 font-mono text-[9.5px] text-ink-faint">
                  {catchUp.lastErrorKind || "unknown"} · {catchUp.lastError || "没有记录"}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-ink-faint">没有待补跑的窗口。</p>
            )}
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">life.json</div>
            <Pre text={JSON.stringify(data.life, null, 2)} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">own.json</div>
            <Pre text={JSON.stringify(data.own, null, 2)} />
          </Card>
          <Card className="p-4">
            <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-ink-faint">deferred.json</div>
            <Pre text={JSON.stringify(data.deferred, null, 2)} />
          </Card>
        </div>
      </div>
    </div>
  );
}
