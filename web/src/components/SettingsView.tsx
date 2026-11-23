import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  FlaskConical,
  Gauge,
  Globe2,
  ImagePlus,
  LoaderCircle,
  MessageCircleHeart,
  Moon,
  Plus,
  Power,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Wallet,
} from "lucide-react";
import { api, assetUrl, clockToMin, formatTime, minToClock } from "../api";
import { getAutostart, setAutostart } from "../autostart";
import { initNotifications, setNotificationsEnabled } from "../notify";
import type { AppConfig, Phase, SettingsPayload } from "../types";
import { Badge, Card, Labeled, Loading, SectionTitle } from "./ui";

function awakeMinutes(sleepMin: number, wakeMin: number): number {
  return (sleepMin - wakeMin + 1440) % 1440;
}

function awakeLabel(minutes: number): string {
  if (minutes === 0) return "24 小时（不合法）";
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

const MIN_AWAKE = 360;
const MAX_AWAKE = 1200;

function scheduleCombos(life: AppConfig["life"]): { label: string; minutes: number }[] {
  return [
    { label: "工作日", minutes: awakeMinutes(life.sleepMin, life.wakeMin) },
    { label: "周五", minutes: awakeMinutes(life.weekendSleepMin, life.wakeMin) },
    { label: "周六", minutes: awakeMinutes(life.weekendSleepMin, life.weekendWakeMin) },
    { label: "周日", minutes: awakeMinutes(life.sleepMin, life.weekendWakeMin) },
  ];
}

function phaseLabel(phase: Phase): string {
  return phase === "asleep" ? "睡着" : phase === "waking" ? "刚醒" : phase === "sleepy" ? "有点困" : "醒着";
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-4 text-left">
      <span>
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-[10px] leading-4 text-ink-faint">{hint}</span> : null}
      </span>
      <span
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full border transition ${
          checked ? "border-sea/40 bg-sea" : "border-line bg-ink/10"
        }`}
      >
        <span
          className={`absolute top-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[18px]" : "left-[2px]"
          }`}
        />
      </span>
    </button>
  );
}

function PriceTable({ prices }: { prices: SettingsPayload["prices"] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line/60">
      <table className="w-full text-left text-[10px]">
        <thead className="bg-ink/5 text-ink-faint">
          <tr>
            <th className="px-2.5 py-2 font-normal">模型</th>
            <th className="px-2.5 py-2 text-right font-normal">缓存命中</th>
            <th className="px-2.5 py-2 text-right font-normal">未命中</th>
            <th className="px-2.5 py-2 text-right font-normal">输出</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(prices).map((item) => (
            <tr key={item.key} className="border-t border-line/40">
              <td className="px-2.5 py-2 text-ink-soft">{item.label}</td>
              <td className="px-2.5 py-2 text-right font-mono text-ink-faint">
                {item.offPeak.hit}/{item.peak.hit}
              </td>
              <td className="px-2.5 py-2 text-right font-mono text-ink-faint">
                {item.offPeak.miss}/{item.peak.miss}
              </td>
              <td className="px-2.5 py-2 text-right font-mono text-ink-faint">
                {item.offPeak.output}/{item.peak.output}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsView({
  showToast,
  avatar,
  avatarCustom,
  onAvatarChange,
}: {
  showToast: (text: string, kind?: "info" | "error") => void;
  avatar: string;
  avatarCustom: boolean;
  onAvatarChange: (url: string, custom: boolean) => void;
}) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [autostart, setAutostartState] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const data = await api.settings();
      setPayload(data);
      setConfig(data.config);
      setApiKey("");
      setDirty(false);
      setNotificationsEnabled(data.config.ui.notificationsEnabled);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取设置失败。", "error");
    }
  }

  useEffect(() => {
    void load();
    void getAutostart().then(setAutostartState).catch(() => undefined);
  }, []);

  function edit(next: AppConfig) {
    setConfig(next);
    setDirty(true);
  }

  const patchModel = (value: Partial<AppConfig["model"]>) =>
    config && edit({ ...config, model: { ...config.model, ...value } });
  const patchBehavior = (value: Partial<AppConfig["behavior"]>) =>
    config && edit({ ...config, behavior: { ...config.behavior, ...value } });
  const patchLife = (value: Partial<AppConfig["life"]>) =>
    config && edit({ ...config, life: { ...config.life, ...value } });
  const patchSpeak = (value: Partial<AppConfig["speak"]>) =>
    config && edit({ ...config, speak: { ...config.speak, ...value } });
  const patchMood = (value: Partial<AppConfig["mood"]>) =>
    config && edit({ ...config, mood: { ...config.mood, ...value } });
  const patchCost = (value: Partial<AppConfig["cost"]>) =>
    config && edit({ ...config, cost: { ...config.cost, ...value } });
  const patchWeb = (value: Partial<AppConfig["web"]>) =>
    config && edit({ ...config, web: { ...config.web, ...value } });
  const patchUi = (value: Partial<AppConfig["ui"]>) =>
    config && edit({ ...config, ui: { ...config.ui, ...value } });

  function setPeakWindow(index: number, value: Partial<AppConfig["cost"]["peakWindows"][number]>) {
    if (!config) return;
    const windows = config.cost.peakWindows.map((row, i) => (i === index ? { ...row, ...value } : row));
    patchCost({ peakWindows: windows });
  }

  function addPeakWindow() {
    if (!config || config.cost.peakWindows.length >= 4) return;
    patchCost({ peakWindows: [...config.cost.peakWindows, { start: 20 * 60, end: 22 * 60 }] });
  }

  function removePeakWindow(index: number) {
    if (!config || config.cost.peakWindows.length <= 1) return;
    patchCost({ peakWindows: config.cost.peakWindows.filter((_, i) => i !== index) });
  }

  function effectiveConfig(): AppConfig | null {
    if (!config) return null;
    return {
      ...config,
      model: { ...config.model, apiKey: apiKey.trim() || config.model.apiKey },
    };
  }

  async function toggleAutostart(value: boolean) {
    if (autostartBusy) return;
    setAutostartBusy(true);
    try {
      await setAutostart(value);
      setAutostartState(value);
      showToast(value ? "下次登录会自动打开。" : "已取消开机自启。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "设置开机自启失败。", "error");
    } finally {
      setAutostartBusy(false);
    }
  }


  async function changeAvatar(file: File | undefined) {
    if (!file || avatarBusy) return;
    if (file.size > 4 * 1024 * 1024) {
      showToast("头像不要超过 4MB。", "error");
      return;
    }
    setAvatarBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("读取图片失败。"));
        reader.readAsDataURL(file);
      });
      const result = await api.uploadAvatar(dataUrl);
      onAvatarChange(assetUrl(result.avatar.url), result.avatar.custom);
      showToast("头像换好了。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "头像保存失败。", "error");
    } finally {
      setAvatarBusy(false);
      if (avatarRef.current) avatarRef.current.value = "";
    }
  }

  async function resetAvatar() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      const result = await api.resetAvatar();
      onAvatarChange(assetUrl(result.avatar.url), result.avatar.custom);
      showToast("已恢复默认头像。");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "恢复失败。", "error");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function save() {
    const next = effectiveConfig();
    if (!next || saving) return;
    if (!next.name.trim() || next.setupPending) {
      showToast("先给她起个名字，再保存设置。", "error");
      return;
    }
    const combos = scheduleCombos(next.life);
    const bad = combos.find((item) => item.minutes === 0 || item.minutes < MIN_AWAKE || item.minutes > MAX_AWAKE);
    if (bad) {
      const message = `「${bad.label}」清醒 ${awakeLabel(bad.minutes)}，需要在 6–20 小时之间。`;
      setScheduleError(message);
      showToast(message, "error");
      return;
    }
    setScheduleError(null);
    setSaving(true);
    try {
      const result = await api.saveSettings(next);
      const fresh = await api.settings();
      setPayload(fresh);
      setConfig(fresh.config);
      setApiKey("");
      setDirty(false);
      setTestResult(null);
      setSavedAt(Date.now());
      const phase = fresh.schedulePreview.phase;
      showToast(
        result.note ??
          (phase === "asleep"
            ? "已保存。按新作息，她现在在睡；醒来后的安排已重排。"
            : "已保存。新的醒睡时间已生效；正在进行的自己的时间会先收尾。"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败。";
      if (message.includes("作息")) setScheduleError(message);
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    const next = effectiveConfig();
    if (!next || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testModel(next);
      setTestResult({
        ok: result.ok,
        text: result.ok
          ? `连接正常：${result.text ?? "在的"}${result.model ? `（${result.model}）` : ""}（已恢复）`
          : `${result.error ?? "连接失败。"}${result.kind ? `（${result.kind}${result.code ? ` / ${result.code}` : ""}）` : ""}`,
      });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : "连接失败。" });
    } finally {
      setTesting(false);
    }
  }

  if (!payload || !config) {
    return (
      <div className="mx-auto w-full max-w-5xl px-5 py-7 sm:px-8">
        <SectionTitle eyebrow="SETTINGS" title="设置" desc="模型、作息、花销，都在这里。" />
        <Loading />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-7 sm:px-8">
      <SectionTitle
        eyebrow="SETTINGS"
        title="设置"
        desc={`数据目录：${payload.root}`}
        action={
          <div className="flex items-center gap-2">
            {dirty ? (
              <Badge tone="coral">未保存</Badge>
            ) : (
              <Badge tone="sea">
                <CheckCircle2 className="h-2.5 w-2.5" /> 已同步
              </Badge>
            )}
            <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="btn-primary">
              {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存
            </button>
          </div>
        }
      />

      <Card className="mb-5 p-5 sm:p-6">
        <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          <ImagePlus className="h-3 w-3" />
          聊天头像
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <img
            src={avatar}
            alt="鲸鲸的头像"
            className="h-20 w-20 rounded-2xl border border-line/60 bg-white/50 object-cover shadow-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-ink">她在聊天里显示的样子</div>
            <div className="mt-0.5 text-[10px] leading-4 text-ink-faint">
              PNG / JPEG / WebP / GIF，方形最好，不超过 4MB；只影响你的界面，不会发给模型。
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                ref={avatarRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(event) => void changeAvatar(event.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => avatarRef.current?.click()}
                disabled={avatarBusy}
                className="btn-ghost text-[10.5px]"
              >
                {avatarBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
                更换头像
              </button>
              <button
                type="button"
                onClick={() => void resetAvatar()}
                disabled={avatarBusy || !avatarCustom}
                className="btn-ghost text-[10.5px] disabled:opacity-40"
              >
                <RotateCcw className="h-3 w-3" />
                恢复默认
              </button>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <Cpu className="h-3 w-3" />
            模型
          </div>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="提供方">
                <select
                  value={config.model.provider}
                  onChange={(event) => patchModel({ provider: event.target.value as AppConfig["model"]["provider"] })}
                  className="input-warm"
                >
                  <option value="deepseek">DeepSeek</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
                </select>
              </Labeled>
              <Labeled label="模型">
                <input
                  list="model-options"
                  value={config.model.model}
                  onChange={(event) => patchModel({ model: event.target.value })}
                  className="input-warm"
                />
                <datalist id="model-options">
                  {payload.modelOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </datalist>
              </Labeled>
            </div>
            <Labeled label="API 地址" hint="兼容 OpenAI 的 /chat/completions">
              <input
                value={config.model.baseUrl}
                onChange={(event) => patchModel({ baseUrl: event.target.value })}
                className="input-warm"
                spellCheck={false}
              />
            </Labeled>
            <Labeled label="API Key" hint={config.model.apiKey ? "已保存，留空不改" : "还没有填"}>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setDirty(true);
                }}
                placeholder={config.model.apiKey ? "••••••••（已保存）" : "sk-..."}
                className="input-warm"
                autoComplete="off"
              />
            </Labeled>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="副模型" hint="心情/整理用">
                <input
                  value={config.model.sideModel}
                  onChange={(event) => patchModel({ sideModel: event.target.value })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="温度" hint="0–2">
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={config.model.temperature}
                  onChange={(event) => patchModel({ temperature: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
            </div>
            <div className="border-t border-line/50 pt-4">
              <Toggle
                checked={config.model.thinking}
                onChange={(value) => patchModel({ thinking: value })}
                label="思考模式"
                hint="更聪明但更慢更贵；日常聊天建议关闭。"
              />
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void test()} disabled={testing} className="btn-ghost">
                {testing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                测试连接
              </button>
              {testResult ? (
                <span className={`inline-flex items-center gap-1 text-[10px] ${testResult.ok ? "text-sea-deep" : "text-coral-deep"}`}>
                  {testResult.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                  {testResult.text}
                </span>
              ) : null}
            </div>
          </div>
        </Card>

        <div className="space-y-5">
          <Card className="p-5 sm:p-6">
            <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              <Settings2 className="h-3 w-3" />
              称呼
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="她的名字" hint={config.setupPending ? "第一次见面，先给她起个名字" : undefined}>
                <input
                  value={config.setupPending ? "" : config.name}
                  placeholder="某鱼"
                  onChange={(event) => edit({ ...config, name: event.target.value, setupPending: false })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="她怎么叫你">
                <input
                  value={config.ownerTitle}
                  onChange={(event) => edit({ ...config, ownerTitle: event.target.value })}
                  className="input-warm"
                />
              </Labeled>
            </div>
          </Card>

          <Card className="p-5 sm:p-6">
            <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
              <Clock className="h-3 w-3" />
              作息
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Labeled label="工作日睡">
                <input
                  type="time"
                  value={minToClock(config.life.sleepMin)}
                  onChange={(event) => patchLife({ sleepMin: clockToMin(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="工作日醒">
                <input
                  type="time"
                  value={minToClock(config.life.wakeMin)}
                  onChange={(event) => patchLife({ wakeMin: clockToMin(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="周末睡">
                <input
                  type="time"
                  value={minToClock(config.life.weekendSleepMin)}
                  onChange={(event) => patchLife({ weekendSleepMin: clockToMin(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="周末醒">
                <input
                  type="time"
                  value={minToClock(config.life.weekendWakeMin)}
                  onChange={(event) => patchLife({ weekendWakeMin: clockToMin(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
            </div>
            <div className="mt-3 space-y-1.5 rounded-xl bg-ink/[0.03] px-3 py-2 text-[10px] text-ink-faint">
              {(() => {
                return scheduleCombos(config.life).map((item) => {
                  const invalid = item.minutes === 0 || item.minutes < MIN_AWAKE || item.minutes > MAX_AWAKE;
                  return (
                    <div key={item.label} className={invalid ? "text-[#b4553f]" : ""}>
                      {item.label}清醒 {awakeLabel(item.minutes)}
                      {invalid ? "（应在 6–20 小时）" : ""}
                    </div>
                  );
                });
              })()}
            </div>
            {scheduleError ? (
              <div className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-[#b4553f]">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {scheduleError}
              </div>
            ) : null}
            {(() => {
              const preview = payload.schedulePreview;
              return (
                <div className="mt-3 space-y-1 rounded-xl border border-line/70 bg-paper/60 px-3 py-2 text-[10px] leading-4 text-ink-soft">
                  <div>
                    现在：{phaseLabel(preview.phase)} · 下一次切换 {formatTime(preview.nextChangeAt)}
                  </div>
                  <div>
                    {preview.own.active
                      ? `正在自己的时间，约 ${formatTime(preview.own.windowEnd)} 收尾`
                      : preview.own.nextAt
                        ? `下一次自己的时间 ${formatTime(preview.own.nextAt)}–${formatTime(preview.own.windowEnd)}`
                        : "自己的时间：今天不再另排"}
                  </div>
                  <div>
                    {preview.diary.slotAt
                      ? `日记：${preview.diary.targetDay ?? "今天"} 睡前（约 ${formatTime(preview.diary.slotAt)}）`
                      : "日记：今天还没排"}
                  </div>
                  <div>
                    {preview.quietNow
                      ? `安静：现在安静中，到 ${formatTime(preview.quietEndAt)}`
                      : `安静：${formatTime(preview.quietStartAt)}–${formatTime(preview.quietEndAt)}`}
                  </div>
                  {preview.pendingCatchUp ? <div>待补跑：还有一次落下的自己的时间</div> : null}
                  {preview.notice ? <div className="text-[#8a6d3b]">{preview.notice}</div> : null}
                  {savedAt ? <div className="text-ink-faint">保存于 {formatTime(savedAt)}</div> : null}
                </div>
              );
            })()}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Labeled label="睡着时被找">
                <select
                  value={config.life.whenAsleep}
                  onChange={(event) => patchLife({ whenAsleep: event.target.value as AppConfig["life"]["whenAsleep"] })}
                  className="input-warm"
                >
                  <option value="wake">叫醒自己</option>
                  <option value="sleepy">迷糊地回</option>
                  <option value="morning">留到早上</option>
                </select>
              </Labeled>
              <div className="flex items-end pb-1">
                <Toggle
                  checked={config.life.diaryEnabled}
                  onChange={(value) => patchLife({ diaryEnabled: value })}
                  label="写日记"
                  hint="睡前一页"
                />
              </div>
            </div>
          </Card>
        </div>

        <Card className="p-5 sm:p-6">
          <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <MessageCircleHeart className="h-3 w-3" />
            主动与安静
          </div>
          <div className="space-y-4">
            <Toggle
              checked={config.speak.enabled}
              onChange={(value) => patchSpeak({ enabled: value })}
              label="允许她主动找你"
              hint="不是每次都发，会看时间、心情和多久没聊。"
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Labeled label="间隔" hint="分钟">
                <input
                  type="number"
                  min={10}
                  value={config.speak.intervalMin}
                  onChange={(event) => patchSpeak({ intervalMin: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="概率" hint="0–1">
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={config.speak.chance}
                  onChange={(event) => patchSpeak({ chance: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <Labeled label="每日上限">
                <input
                  type="number"
                  min={0}
                  value={config.speak.maxPerDay}
                  onChange={(event) => patchSpeak({ maxPerDay: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium text-ink-soft">安静时段</div>
              <div className="inline-flex rounded-xl border border-line/60 p-0.5">
                {([
                  { value: "sleep", label: "跟随作息" },
                  { value: "manual", label: "手动" },
                ] as const).map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => patchSpeak({ quietMode: item.value })}
                    className={`rounded-[10px] px-3 py-1.5 text-[11px] transition ${
                      config.speak.quietMode === item.value
                        ? "bg-sea text-white"
                        : "text-ink-soft hover:bg-ink/5"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {config.speak.quietMode === "sleep" ? (
                <div className="mt-2 text-[10px] leading-4 text-ink-faint">
                  跟着作息走：睡前 30 分钟到第二天醒来，期间不主动说话。
                  <span className="ml-1 text-ink-soft">
                    安静 {minToClock((config.life.sleepMin - 30 + 1440) % 1440)} – 次日{" "}
                    {minToClock(config.life.wakeMin)}
                  </span>
                </div>
              ) : (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <Labeled label="安静开始">
                    <input
                      type="time"
                      value={minToClock(config.speak.quietStart)}
                      onChange={(event) => patchSpeak({ quietStart: clockToMin(event.target.value) })}
                      className="input-warm"
                    />
                  </Labeled>
                  <Labeled label="安静结束">
                    <input
                      type="time"
                      value={minToClock(config.speak.quietEnd)}
                      onChange={(event) => patchSpeak({ quietEnd: clockToMin(event.target.value) })}
                      className="input-warm"
                    />
                  </Labeled>
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="最少沉默" hint="分钟">
                <input
                  type="number"
                  min={0}
                  value={config.speak.minSilenceMin}
                  onChange={(event) => patchSpeak({ minSilenceMin: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="提醒你 每日上限">
                <input
                  type="number"
                  min={0}
                  value={config.speak.tellOwnerMaxPerDay}
                  onChange={(event) => patchSpeak({ tellOwnerMaxPerDay: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <div className="flex items-end pb-1">
                <Toggle
                  checked={config.mood.enabled}
                  onChange={(value) => patchMood({ enabled: value })}
                  label="心情"
                  hint="会自己回稳"
                />
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <Wallet className="h-3 w-3" />
            花销与峰谷
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line/60 bg-white/35 px-3 py-2.5">
              <div className="inline-flex items-center gap-2">
                <Gauge className="h-3.5 w-3.5 text-gold" />
                <div>
                  <div className="text-[11px] text-ink">{payload.pricing.label}</div>
                  <div className="text-[9.5px] text-ink-faint">
                    {payload.pricing.enabled
                      ? `下次切换 ${formatTime(payload.pricing.nextChangeAt)} · ${payload.pricing.peakWindow}`
                      : "峰谷已关闭，全时段按闲时价格与额度运行"}
                  </div>
                </div>
              </div>
              <Badge tone={!payload.pricing.enabled ? "sea" : payload.pricing.isPeak ? "coral" : "sea"}>
                {!payload.pricing.enabled ? "已关闭" : payload.pricing.isPeak ? "高峰" : "空闲"}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="每日预算" hint="元，0 = 不限">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={config.cost.dailyBudgetCny}
                  onChange={(event) => patchCost({ dailyBudgetCny: Number(event.target.value) })}
                  className="input-warm"
                />
              </Labeled>
              <div className="flex items-end pb-1">
                <Toggle
                  checked={config.cost.peakPolicy}
                  onChange={(value) => patchCost({ peakPolicy: value })}
                  label="峰谷计费与降载"
                  hint="关闭后全时段按闲时价格与额度运行"
                />
              </div>
            </div>
            {config.cost.peakPolicy ? (
              <div className="rounded-xl border border-line/60 bg-white/35 px-3 py-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-1.5 text-[11px] text-ink">
                    <Clock className="h-3.5 w-3 text-gold" />
                    高峰时段
                  </div>
                  <button
                    type="button"
                    onClick={addPeakWindow}
                    disabled={config.cost.peakWindows.length >= 4}
                    className="inline-flex items-center gap-1 rounded-full border border-line/70 px-2 py-1 text-[10px] text-ink-soft transition hover:border-coral/40 hover:text-coral disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    添加
                  </button>
                </div>
                <div className="space-y-2">
                  {config.cost.peakWindows.map((window, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={minToClock(window.start)}
                        onChange={(event) => setPeakWindow(index, { start: clockToMin(event.target.value) })}
                        className="input-warm w-auto min-w-0 flex-1 px-2 py-1.5 text-[11px]"
                      />
                      <span className="text-ink-faint">–</span>
                      <input
                        type="time"
                        value={minToClock(window.end)}
                        onChange={(event) => setPeakWindow(index, { end: clockToMin(event.target.value) })}
                        className="input-warm w-auto min-w-0 flex-1 px-2 py-1.5 text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => removePeakWindow(index)}
                        disabled={config.cost.peakWindows.length <= 1}
                        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint transition hover:bg-coral/10 hover:text-coral disabled:opacity-30"
                        title="删除这个时段"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[9.5px] leading-4 text-ink-faint">
                  按本地时间；结束早于开始表示跨午夜。法定节假日与周末仍按闲时。
                </p>
              </div>
            ) : null}
            <PriceTable prices={payload.prices} />
            <p className="text-[9.5px] leading-4 text-ink-faint">
              {payload.pricing.enabled
                ? `当前高峰：${payload.pricing.peakWindow}。表中为「空闲/高峰」元每百万 token。`
                : "峰谷已关闭；表中为参考价，实际按「空闲」列计费。"}
            </p>
          </div>
        </Card>

        <Card className="p-5 sm:p-6">
          <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
            <Globe2 className="h-3 w-3" />
            她上网
          </div>
          <div className="space-y-4">
            <Toggle
              checked={config.web.enabled}
              onChange={(value) => patchWeb({ enabled: value })}
              label="允许她出去看看"
              hint="读 RSS、HN，偶尔记一笔；不会发帖。"
            />
            <Toggle
              checked={config.web.ownTimeEnabled}
              onChange={(value) => patchWeb({ ownTimeEnabled: value })}
              label="让她有自己的时间"
              hint="在随机窗口里读点东西、翻笔记；偶尔忍不住来找你。"
            />
            <Labeled label="订阅源" hint="一行一个 URL">
              <textarea
                value={config.web.rssFeeds.join("\n")}
                onChange={(event) =>
                  patchWeb({ rssFeeds: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })
                }
                rows={4}
                className="input-warm resize-none font-mono text-[10.5px] leading-5"
                spellCheck={false}
              />
            </Labeled>
          </div>
        </Card>
      </div>

      <Card className="mt-5 p-5 sm:p-6">
        <div className="mb-4 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-ink-faint">
          <Power className="h-3 w-3" />
          这台电脑
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle
            checked={config.ui.notificationsEnabled}
            onChange={(value) => {
              patchUi({ notificationsEnabled: value });
              setNotificationsEnabled(value);
              if (value) void initNotifications();
            }}
            label="展示通知"
            hint="她发来新消息时，通过 macOS 通知提醒你。"
          />
          <Toggle
            checked={autostart}
            onChange={(value) => void toggleAutostart(value)}
            label="登录时自动打开"
            hint="macOS 下次登录后，鲸鲸会自己醒来。"
          />
        </div>
      </Card>

      <details className="paper-card mt-5 p-5">
        <summary className="flex cursor-pointer list-none items-center justify-between text-[11.5px] text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            <Moon className="h-3.5 w-3.5" />
            高级参数
          </span>
          <ChevronDown className="h-3.5 w-3.5" />
        </summary>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <Labeled label="历史条数" hint="空闲">
            <input
              type="number"
              min={4}
              max={100}
              value={config.behavior.historyMessages}
              onChange={(event) => patchBehavior({ historyMessages: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="历史条数" hint="高峰">
            <input
              type="number"
              min={4}
              max={100}
              value={config.behavior.historyPeakMessages}
              onChange={(event) => patchBehavior({ historyPeakMessages: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="输出上限" hint="空闲 token">
            <input
              type="number"
              min={100}
              max={4000}
              value={config.behavior.maxOutputTokens}
              onChange={(event) => patchBehavior({ maxOutputTokens: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="输出上限" hint="高峰 token">
            <input
              type="number"
              min={80}
              max={2000}
              value={config.behavior.maxOutputTokensPeak}
              onChange={(event) => patchBehavior({ maxOutputTokensPeak: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="工具步数" hint="空闲">
            <input
              type="number"
              min={1}
              max={10}
              value={config.behavior.maxToolSteps}
              onChange={(event) => patchBehavior({ maxToolSteps: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="工具步数" hint="高峰">
            <input
              type="number"
              min={1}
              max={6}
              value={config.behavior.maxToolStepsPeak}
              onChange={(event) => patchBehavior({ maxToolStepsPeak: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="连发防抖" hint="毫秒">
            <input
              type="number"
              min={300}
              max={8000}
              value={config.behavior.burstMs}
              onChange={(event) => patchBehavior({ burstMs: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="打字速度" hint="字/秒">
            <input
              type="number"
              min={1}
              max={30}
              value={config.behavior.typingCps}
              onChange={(event) => patchBehavior({ typingCps: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
          <Labeled label="最多气泡">
            <input
              type="number"
              min={1}
              max={8}
              value={config.behavior.maxBubbles}
              onChange={(event) => patchBehavior({ maxBubbles: Number(event.target.value) })}
              className="input-warm"
            />
          </Labeled>
        </div>
      </details>

      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-[9.5px] text-ink-faint">改完记得保存。模型和作息会在下一轮生效。</p>
        <button type="button" onClick={() => void save()} disabled={saving || !dirty} className="btn-primary">
          {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存设置
        </button>
      </div>
    </div>
  );
}
