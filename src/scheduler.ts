import type { AppConfig, DeferredTask } from "./types.js";
import type { Paths } from "./config.js";
import type { MemoryStore } from "./memory.js";
import type { ChatAgent } from "./agent.js";
import type { ServerEvent } from "./events.js";
import { addDeferred, loadDeferred, loadLife, saveDeferred, saveLife } from "./life.js";
import { getRhythm, isQuietHours } from "./rhythm.js";
import { getSchedule, quietEndsAt, scheduleDayKey } from "./schedule.js";
import { costPolicy } from "./pricing.js";
import { todayUsage } from "./usage.js";
import { loadMood } from "./mood.js";
import { loadRoom, roomAction, roomIsStale } from "./room.js";
import { dueReminders, markReminderDone } from "./care.js";
import { diaryTarget, diaryTargetForDay, ensureDiarySlot, writeDiary } from "./diary.js";
import { consolidateMemory, hasInbox } from "./consolidate.js";
import { lastAssistantMessageAt, lastOwnerMessageAt, todayProactiveCount } from "./chat.js";
import { formatClock, humanGap, zonedParts } from "./time.js";
import { appendTimeline } from "./timeline.js";
import { addMilestone } from "./relationship.js";
import {
  CATCHUP_HORIZON_MS,
  CATCHUP_MAX_UNKNOWN_ATTEMPTS,
  canShareNow,
  catchUpBackoff,
  createPendingCatchUp,
  ensureOwnSchedule,
  isInfraFailure,
  loadOwn,
  markCatchUpDone,
  markOwnEnd,
  markOwnStart,
  queueShare,
  resetShareDay,
  saveOwn,
  takeFreshShares,
} from "./own.js";
import { probeProviderReachable } from "./llm.js";
import { localNetworkAvailable } from "./network.js";
import {
  noteProviderProbe,
  providerAllowsEssential,
  providerAllowsNonEssential,
  providerRetryAt,
  providerSnapshot,
} from "./provider.js";

const DIARY_LATEST_BEFORE_SLEEP_MS = 15 * 60_000;

export interface SchedulerContext {
  config: AppConfig;
  paths: Paths;
  memory: MemoryStore;
  persona: string;
  agent: ChatAgent;
  emit: (event: ServerEvent) => void;
  onChange: () => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private ctx: SchedulerContext) {}

  start(): void {
    if (this.timer) return;
    const life = loadLife(this.ctx.paths);
    if (!life.lastTick) {
      life.lastTick = Date.now();
      saveLife(this.ctx.paths, life);
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 60_000);
    setTimeout(() => {
      void this.tick();
    }, 1500);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setContext(ctx: SchedulerContext): void {
    this.ctx = ctx;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : "调度器出了点问题。";
      this.ctx.emit({ type: "error", message });
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const { config, paths, agent, emit, onChange } = this.ctx;
    const now = Date.now();
    let life = loadLife(paths);
    const gap = life.lastTick ? now - life.lastTick : 0;

    if (gap > 3 * 60_000 && life.lastTick > 0) {
      // Diagnostic only; wake gaps are noisy in the day view and are not life events.
      life.lastResumeGapAt = now;
    }
    life.lastTick = now;
    saveLife(paths, life);

    const rhythm = getRhythm(config, life, now);
    const schedule = getSchedule(config, now, life);
    const providerOk = providerAllowsNonEssential();

    // 供应商故障时不发提醒也不写日记：提醒留在队列里，等恢复后再补。
    if (!agent.isHolding() && providerOk) await this.fireReminders(now, rhythm);

    // 自己的时间先跑：它可能决定这一轮要不要补跑，日记/整理也得等它落定。
    if (config.web.ownTimeEnabled && !agent.busy) {
      await this.maybeOwnTime(now, rhythm);
    }
    await this.maybeCatchUp(now);

    const pendingCatchUp = loadOwn(paths).pendingCatchUp;
    const pending = Boolean(pendingCatchUp);
    const pendingExpired = Boolean(pendingCatchUp && now - pendingCatchUp.nextRetryAt > 30 * 60_000);
    let policy = costPolicy(config, todayUsage(paths, config), now);

    // 日记：睡前窗口自己排；有待补跑的窗口时，只有临近睡前/补跑明显卡住才照常写。
    // 睡着后也可能是在补写昨晚的日记（睡后 6 小时内），所以 asleep 也算到期。
    const diaryDue =
      !pending ||
      schedule.phase === "asleep" ||
      now >= schedule.sleepAt - DIARY_LATEST_BEFORE_SLEEP_MS ||
      pendingExpired;
    if (providerOk && !agent.busy && diaryDue) {
      life = loadLife(paths);
      ensureDiarySlot(paths, config, life, loadOwn(paths), schedule, now);
      const target = diaryTarget(config, loadLife(paths), now);
      if (target) {
        // 峰时豁免日记（6.4A），只有预算真的用完才不写。
        if (policy.budgetState !== "exhausted") {
          await writeDiary(target, {
            config,
            paths,
            memory: this.ctx.memory,
            persona: this.ctx.persona,
            emit,
            onChange,
          });
        }
      }
    }

    // 有待补跑的窗口时，先别整理；补跑回来后那才是“今天”的完整记录。
    if (!pending && providerOk) {
      await this.processDeferred(now, policy, rhythm);

      life = loadLife(paths);
      if (
        life.lastDiary &&
        life.lastConsolidate !== life.lastDiary &&
        hasInbox(paths) &&
        !agent.busy
      ) {
        if (policy.allowConsolidation) {
          await consolidateMemory(life.lastDiary, {
            config,
            paths,
            memory: this.ctx.memory,
            emit,
            onChange,
          });
        } else {
          addDeferred(paths, { kind: "consolidate", runAfter: policy.nextChangeAt, payload: { day: life.lastDiary } });
        }
      }
    }

    // 先把昨晚/静默期记下的话补发掉，再考虑新的自己的时间；两条主动消息不要同一分钟抢着说。
    const flushed = pending || !providerOk ? 0 : await this.flushPendingShares(now, rhythm);
    this.maybeDecayRoom(now);

    policy = costPolicy(config, todayUsage(paths, config), now);
    if (!pending && providerOk && flushed === 0 && policy.allowProactive && !agent.busy) {
      await this.maybeSpeak(now, rhythm);
    }

    // 到点的熔断顺手探一下，通了下一轮就恢复。
    await this.maybeProbeProvider(now);
    onChange();
  }

  private async processDeferred(
    now: number,
    policy: ReturnType<typeof costPolicy>,
    rhythm: ReturnType<typeof getRhythm>,
  ): Promise<void> {
    const { paths, config, agent } = this.ctx;
    const tasks = loadDeferred(paths);
    if (!tasks.length) return;
    const remaining: DeferredTask[] = [];
    for (const task of tasks) {
      if (task.runAfter > now) {
        remaining.push(task);
        continue;
      }
      if (task.kind === "diary") {
        if (!config.life.diaryEnabled) continue;
        if (!policy.allowDiary || agent.busy) {
          remaining.push(task);
          continue;
        }
        const day = String(task.payload?.day ?? "");
        if (day) {
          await writeDiary(diaryTargetForDay(config, day), {
            config,
            paths,
            memory: this.ctx.memory,
            persona: this.ctx.persona,
            emit: this.ctx.emit,
            onChange: this.ctx.onChange,
          });
        }
      } else if (task.kind === "consolidate") {
        if (!policy.allowConsolidation || agent.busy) {
          remaining.push(task);
          continue;
        }
        const day = String(task.payload?.day ?? "");
        if (day) {
          await consolidateMemory(day, {
            config,
            paths,
            memory: this.ctx.memory,
            emit: this.ctx.emit,
            onChange: this.ctx.onChange,
          });
        }
      }
      // own / mood jobs are not implemented in P0–P3; drop them silently.
    }
    saveDeferred(paths, remaining);
  }

  private async maybeOwnTime(now: number, rhythm: ReturnType<typeof getRhythm>): Promise<void> {
    const { config, paths, agent } = this.ctx;
    const schedule = getSchedule(config, now, loadLife(paths));
    if (agent.isHolding()) return;
    if (!config.web.ownTimeEnabled) {
      saveOwn(paths, ensureOwnSchedule(config, now, loadOwn(paths), schedule));
      return;
    }
    // 睡前 90 分钟仍可能有一段自己的时间（最晚到睡前 60 分钟），所以 sleepy 也放行。
    if ((rhythm.phase !== "awake" && rhythm.phase !== "sleepy") || isQuietHours(config, now)) return;

    let own = ensureOwnSchedule(config, now, loadOwn(paths), schedule);
    if (!own.nextAt || own.nextAt > now || own.windowEnd <= now) {
      saveOwn(paths, own);
      return;
    }

    const plannedAt = own.nextAt;
    const windowEnd = own.windowEnd;
    const missedKey = own.windowKey;

    // 本机完全没网：是用户这边断了，按 v1 的离线补跑处理，别记成她没去。
    if (!localNetworkAvailable()) {
      own.lastWindowKey = missedKey;
      own.pendingCatchUp = createPendingCatchUp({ key: missedKey, plannedAt, windowEnd, now });
      own.activeUntil = 0;
      own.nextAt = 0;
      own.windowEnd = 0;
      own.windowKey = "";
      saveOwn(paths, ensureOwnSchedule(config, now, own, schedule));
      this.ctx.onChange();
      return;
    }

    // 供应商熔断/Key 问题：这一窗直接跳过，不补跑，也不留失败的痕迹。
    if (!providerAllowsEssential(now)) {
      own.lastWindowKey = missedKey;
      own.activeUntil = 0;
      own.nextAt = 0;
      own.windowEnd = 0;
      own.windowKey = "";
      saveOwn(paths, ensureOwnSchedule(config, now, own, schedule));
      this.ctx.onChange();
      return;
    }

    // 权限按实际时间算（可能在这次 tick 里刚花过钱），补跑也一样。
    const policy = costPolicy(config, todayUsage(paths, config), now);
    // 6.2B：第一段自己的时间允许在峰时跑一次，前提是预算还没用完。
    const firstWindow = own.runsToday === 0;
    const peakException = firstWindow && policy.isPeak && policy.budgetState !== "exhausted";
    if (!policy.allowOwnTime && !peakException) {
      saveOwn(paths, own);
      return;
    }

    // 新窗口要试了，旧的补跑就被取代——只补最近一个。
    if (own.pendingCatchUp && own.pendingCatchUp.key !== missedKey) {
      own.pendingCatchUp = null;
    }

    // 先花 3 秒确认真的能连上，别让断网时的模型重试白烧一轮。
    const probe = await probeProviderReachable(config);
    if (!probe.reachable) {
      noteProviderProbe(false);
      own.lastWindowKey = missedKey;
      own.pendingCatchUp = createPendingCatchUp({ key: missedKey, plannedAt, windowEnd, now });
      own.activeUntil = 0;
      own.nextAt = 0;
      own.windowEnd = 0;
      own.windowKey = "";
      saveOwn(paths, ensureOwnSchedule(config, now, own, schedule));
      this.ctx.onChange();
      return;
    }
    noteProviderProbe(true, probe.status);

    markOwnStart(own, now, windowEnd);
    saveOwn(paths, own);
    this.ctx.onChange();

    const result = await agent.runOwnTime(now, windowEnd);
    const actualNow = Date.now();
    own = loadOwn(paths);

    if (result.ok) {
      markOwnEnd(own, actualNow, result.summary);
      addMilestone(paths, config, "第一次自己出门");
      own = ensureOwnSchedule(config, actualNow, own, getSchedule(config, actualNow, loadLife(paths)));

      const remainingShares = Math.max(0, config.speak.tellOwnerMaxPerDay - own.shareCount);
      for (const share of result.shares.slice(0, remainingShares)) {
        if (canShareNow(own, config, actualNow)) {
          await agent.say(share, true, actualNow);
          own.shareCount += 1;
          appendTimeline(paths, config, { kind: "share", text: `忍不住告诉他：${share.slice(0, 80)}` });
        } else if (isQuietHours(config, actualNow)) {
          // 静默期才排队；配额用完的话 tell_owner 已经跟她说清楚了，不悄悄攒着。
          queueShare(own, share, quietEndsAt(config, actualNow));
          appendTimeline(paths, config, { kind: "share", text: `想分享，先记着：${share.slice(0, 80)}` });
        }
      }
      saveOwn(paths, own);
      this.ctx.onChange();
      return;
    }

    // 失败不等于“她今天出过门了”：先收回这次尝试的痕迹。
    own.activeUntil = 0;
    own.nextAt = 0;
    own.windowEnd = 0;
    own.windowKey = "";

    if (result.errorKind === "aborted") {
      // 她选择了和主人说话，这件事就过去了，不补。
      own.runsToday = Math.max(0, own.runsToday - 1);
      saveOwn(paths, ensureOwnSchedule(config, actualNow, own, getSchedule(config, actualNow, loadLife(paths))));
      this.ctx.onChange();
      return;
    }

    if (isInfraFailure(result.errorKind)) {
      own.runsToday = Math.max(0, own.runsToday - 1);
      own.lastWindowKey = missedKey;
      if (!localNetworkAvailable()) {
        // 跑的时候网断了：用户侧问题，下一次联网补跑。
        own.pendingCatchUp = createPendingCatchUp({
          key: missedKey,
          plannedAt,
          windowEnd,
          now: actualNow,
          attempts: 1,
          nextRetryAt: actualNow + catchUpBackoff(1),
          lastErrorKind:
            result.errorKind === "rate" || result.errorKind === "timeout" || result.errorKind === "server"
              ? result.errorKind
              : "network",
          lastError: result.error || "网络没连上。",
        });
      }
      // 供应商故障不补跑：只排下一窗口，不 markOwnEnd、不 unread、不写「没去成」。
      saveOwn(paths, ensureOwnSchedule(config, actualNow, own, getSchedule(config, actualNow, loadLife(paths))));
      this.ctx.onChange();
      return;
    }

    // auth / config / unknown / 早退：这次不算，也不补跑。
    own.runsToday = Math.max(0, own.runsToday - 1);
    own.lastWindowKey = missedKey;
    if (result.errorKind === "auth" && result.error) {
      this.ctx.emit({ type: "error", message: result.error, kind: "auth", retryable: false });
    } else if (result.error) {
      console.warn(`[own] ${result.errorKind ?? "unknown"}: ${result.error}`);
    }
    saveOwn(paths, ensureOwnSchedule(config, actualNow, own, getSchedule(config, actualNow, loadLife(paths))));
    this.ctx.onChange();
  }

  /**
   * 离线错过的那一轮自己的时间：联网后静默补跑，聊天/日志/时间线都写原计划时刻。
   * 只补最近一个窗口；跨逻辑日、超过 4 小时或失败的都按退避规则处理。
   */
  private async maybeCatchUp(now: number): Promise<void> {
    const { config, paths, agent } = this.ctx;
    let own = loadOwn(paths);
    let pending = own.pendingCatchUp;

    if (!config.web.ownTimeEnabled) {
      if (pending) {
        own.pendingCatchUp = null;
        saveOwn(paths, own);
      }
      return;
    }
    if (!pending) return;
    if (agent.busy || agent.isHolding()) return;

    const plannedDay = scheduleDayKey(config, pending.plannedAt);
    if (plannedDay !== scheduleDayKey(config, now)) {
      own.pendingCatchUp = null;
      saveOwn(paths, own);
      return;
    }
    if (now - pending.plannedAt > CATCHUP_HORIZON_MS) {
      own.pendingCatchUp = null;
      saveOwn(paths, own);
      return;
    }
    if (now < pending.nextRetryAt) return;
    if (!config.model.apiKey.trim()) {
      own.pendingCatchUp = null;
      saveOwn(paths, own);
      return;
    }

    // 用户侧断网：补跑保留，继续退避，等网回来。
    if (!localNetworkAvailable()) {
      pending.attempts += 1;
      pending.lastErrorKind = "network";
      pending.lastError = "网络没连上。";
      pending.nextRetryAt = now + catchUpBackoff(pending.attempts);
      own.pendingCatchUp = pending;
      saveOwn(paths, own);
      return;
    }

    // 供应商侧故障：不硬试，等它恢复（或者熔断到点）再说。
    if (!providerAllowsEssential(now)) {
      pending.nextRetryAt = Math.max(now + catchUpBackoff(pending.attempts), providerRetryAt());
      own.pendingCatchUp = pending;
      saveOwn(paths, own);
      return;
    }

    const policy = costPolicy(config, todayUsage(paths, config), now);
    if (!policy.allowOwnTime) {
      pending.nextRetryAt = policy.isPeak
        ? Math.max(now + 30_000, policy.nextChangeAt || now + 5 * 60_000)
        : now + 10 * 60_000;
      own.pendingCatchUp = pending;
      saveOwn(paths, own);
      return;
    }

    const probe = await probeProviderReachable(config);
    if (!probe.reachable) {
      noteProviderProbe(false);
      pending.attempts += 1;
      pending.lastErrorKind = "network";
      pending.lastError = "模型服务暂时连不上。";
      pending.nextRetryAt = now + catchUpBackoff(pending.attempts);
      own.pendingCatchUp = pending;
      saveOwn(paths, own);
      return;
    }
    noteProviderProbe(true, probe.status);

    const result = await agent.runOwnTime(pending.plannedAt, pending.windowEnd, { catchUp: true });
    const actualNow = Date.now();

    if (result.ok) {
      // tellOwner 可能已经 save 过队列，不能拿调用前的旧对象覆盖。
      const latest = loadOwn(paths);
      if (latest.day === plannedDay) latest.runsToday += 1;
      markCatchUpDone(latest, pending, result.summary, actualNow);
      addMilestone(paths, config, "第一次自己出门");
      saveOwn(paths, ensureOwnSchedule(config, actualNow, latest, getSchedule(config, actualNow, loadLife(paths))));
      await this.deliverCatchUpShares(result.shares, pending.plannedAt);
      this.ctx.onChange();
      return;
    }

    own = loadOwn(paths);
    pending = own.pendingCatchUp ?? pending;

    if (result.errorKind === "auth" || result.errorKind === "config" || result.errorKind === "aborted") {
      own.pendingCatchUp = null;
      saveOwn(paths, own);
      if (result.errorKind === "auth" && result.error) {
        this.ctx.emit({ type: "error", message: result.error, kind: "auth", retryable: false });
      } else if (result.errorKind === "config") {
        console.warn(`[catchup] config: ${result.error ?? ""}`);
      }
      return;
    }

    if (result.errorKind === "unknown") {
      pending.attempts += 1;
      if (pending.attempts > CATCHUP_MAX_UNKNOWN_ATTEMPTS) {
        own.pendingCatchUp = null;
        saveOwn(paths, own);
        return;
      }
    } else if (isInfraFailure(result.errorKind)) {
      pending.attempts += 1;
    } else {
      // 没有 errorKind 的早退（没 Key、自己时间被关掉等）：不补了。
      own.pendingCatchUp = null;
      saveOwn(paths, own);
      return;
    }

    pending.lastErrorKind = result.errorKind ?? "unknown";
    pending.lastError = result.error || "补跑失败了。";
    pending.nextRetryAt = actualNow + catchUpBackoff(pending.attempts);
    own.pendingCatchUp = pending;
    saveOwn(paths, own);
  }

  /** 补跑成功后的分享：静默投递，只受每日 tell_owner 配额限制。 */
  private async deliverCatchUpShares(shares: string[], plannedAt: number): Promise<void> {
    const { config, paths, agent } = this.ctx;
    if (!shares.length) return;
    const own = loadOwn(paths);
    resetShareDay(own, config, plannedAt);
    for (const share of shares) {
      if (own.shareCount + own.pendingShares.length >= config.speak.tellOwnerMaxPerDay) break;
      await agent.say(share, true, plannedAt, { silent: true, catchUp: true });
      own.shareCount += 1;
      appendTimeline(paths, config, {
        kind: "share",
        text: `忍不住告诉他：${share.slice(0, 80)}`,
        ts: plannedAt,
        meta: { catchUp: true, silent: true },
      });
    }
    saveOwn(paths, own);
  }

  /**
   * 静默期记下的分享，等安静过去再补发。只补同一个逻辑日里的：
   * 过了一天的话已经不属于“早上”了，直接丢掉，避免把几天前的话一次性倒出来。
   */
  private async flushPendingShares(now: number, rhythm: ReturnType<typeof getRhythm>): Promise<number> {
    const { config, paths, agent } = this.ctx;
    if (agent.busy || agent.isHolding()) return 0;
    // 关掉主动关心时，排队的话先留在队列里；当天没发出去就自然过期。
    if (!config.speak.enabled) return 0;
    if (isQuietHours(config, now) || rhythm.phase === "asleep") return 0;
    const own = loadOwn(paths);
    if (!own.pendingShares.length) return 0;

    resetShareDay(own, config, now);
    const fresh = takeFreshShares(own, config, now);
    const quota = Math.max(0, config.speak.tellOwnerMaxPerDay - own.shareCount);
    const send = quota > 0 ? fresh.slice(-quota) : [];
    for (const item of send) {
      await agent.say(item.text, true);
      own.shareCount += 1;
      appendTimeline(paths, config, { kind: "share", text: `早上才告诉他：${item.text.slice(0, 80)}` });
    }
    saveOwn(paths, own);
    if (send.length) this.ctx.onChange();
    return send.length;
  }

  /** 房间太久没动静，就回落成中性的“在书桌前发呆”。 */
  private maybeDecayRoom(now: number): void {
    const { config, paths } = this.ctx;
    const own = loadOwn(paths);
    if (own.activeUntil > now) return;
    const room = loadRoom(paths);
    if (!roomIsStale(room, now)) return;
    if (room.status === "在书桌前发呆") return;
    const next = roomAction(paths, "发呆");
    appendTimeline(paths, config, {
      kind: "room",
      text: `${next.status}（安静了一阵）`,
      meta: { from: "decay" },
    });
    this.ctx.onChange();
  }

  private async fireReminders(now: number, rhythm: ReturnType<typeof getRhythm>): Promise<void> {
    const { config, paths, agent } = this.ctx;
    const due = dueReminders(paths, config, rhythm, now);
    for (const reminder of due) {
      if (agent.busy) break;
      await agent.say(reminder.text, true);
      markReminderDone(paths, reminder.id);
      appendTimeline(paths, config, {
        kind: "remind",
        text: `提醒${config.ownerTitle}：${reminder.text}`,
        meta: { id: reminder.id, kind: reminder.kind },
      });
      this.ctx.emit({
        type: "timeline",
        event: { ts: Date.now(), kind: "remind", text: reminder.text },
      });
    }
  }

  /** down/rate 到点后探一次；只有真能用的端点才恢复。 */
  private async maybeProbeProvider(now: number): Promise<void> {
    const snapshot = providerSnapshot();
    const due =
      (snapshot.state === "down" && now >= snapshot.openUntil) ||
      (snapshot.state === "rate" && now >= snapshot.retryAt);
    if (!due) return;
    const probe = await probeProviderReachable(this.ctx.config);
    noteProviderProbe(probe.reachable, probe.status);
  }

  private async maybeSpeak(now: number, rhythm: ReturnType<typeof getRhythm>): Promise<void> {
    const { config, paths, agent } = this.ctx;
    if (agent.isHolding()) return;
    if (!config.speak.enabled) return;
    if (rhythm.phase === "asleep") return;
    if (isQuietHours(config, now)) return;

    const lastOwner = lastOwnerMessageAt(paths, config);
    if (!lastOwner) return;
    const silenceMs = now - lastOwner;
    if (silenceMs < config.speak.minSilenceMin * 60_000) return;

    const life = loadLife(paths);
    const today = scheduleDayKey(config, now);
    if (life.speakCountDay !== today) {
      life.speakCountDay = today;
      life.speakCount = 0;
    }
    if (life.speakCount >= config.speak.maxPerDay) return;

    const lastSpeak = Math.max(life.lastSpeakAt, lastAssistantMessageAt(paths, config));
    if (lastSpeak && now - lastSpeak < config.speak.intervalMin * 60_000) return;
    if (todayProactiveCount(paths, config) >= config.speak.maxPerDay) return;

    const mood = loadMood(paths, config);
    let chance = config.speak.chance;
    const hours = silenceMs / 3_600_000;
    if (hours > 8) chance *= 2.2;
    else if (hours > 4) chance *= 1.6;
    else if (hours > 2) chance *= 1.2;
    chance += (mood.dims.miss ?? 0) / 200 + (mood.dims.bored ?? 0) / 300;
    if (rhythm.phase === "sleepy") chance *= 0.5;
    const hour = zonedParts(now, config.behavior.timezone).hour;
    if ((hour >= 11 && hour < 13) || (hour >= 17 && hour < 19)) chance += 0.25;
    chance = Math.min(0.9, chance);

    if (Math.random() > chance) {
      life.lastSpeakAt = now;
      saveLife(paths, life);
      return;
    }

    const room = loadRoom(paths);
    const nudge = [
      `现在是 ${formatClock(now, config.behavior.timezone)}。${config.ownerTitle}已经 ${humanGap(silenceMs)} 没和你说话了。`,
      `你醒着，手头在${room.status}。你想主动和他说句话。`,
      "可以分享你刚想到的、看到的，或者只是问一句；不要问「在吗」，不要解释你在主动，也不要提系统。",
      "如果不想说，写（不回）。",
    ].join("\n");

    const firstSpeak = life.speakCount === 0;
    const sent = await agent.proactive(nudge);
    life.lastSpeakAt = now;
    life.speakCountDay = today;
    if (sent) life.speakCount += 1;
    saveLife(paths, life);
    if (sent && firstSpeak) addMilestone(paths, config, "第一次主动找你");
  }
}
