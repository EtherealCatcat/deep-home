import type { AppConfig, DeferredTask } from "./types.js";
import type { Paths } from "./config.js";
import type { MemoryStore } from "./memory.js";
import type { ChatAgent } from "./agent.js";
import type { ServerEvent } from "./events.js";
import { addDeferred, loadDeferred, loadLife, saveDeferred, saveLife } from "./life.js";
import { getRhythm, isQuietHours } from "./rhythm.js";
import { costPolicy } from "./pricing.js";
import { todayUsage } from "./usage.js";
import { loadMood } from "./mood.js";
import { loadRoom, roomAction, roomIsStale } from "./room.js";
import { dueReminders, markReminderDone } from "./care.js";
import { diaryTarget, writeDiary } from "./diary.js";
import { consolidateMemory, hasInbox } from "./consolidate.js";
import { lastAssistantMessageAt, lastOwnerMessageAt, todayProactiveCount } from "./chat.js";
import { dayKey, formatClock, humanGap, nextClockTs, zonedParts } from "./time.js";
import { appendTimeline } from "./timeline.js";
import { addMilestone } from "./relationship.js";
import {
  canShareNow,
  ensureOwnSchedule,
  loadOwn,
  markOwnEnd,
  markOwnStart,
  queueShare,
  resetShareDay,
  saveOwn,
  scheduleOwnRetry,
  takeFreshShares,
} from "./own.js";

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
    const policy = costPolicy(config, todayUsage(paths, config), now);

    await this.processDeferred(now, policy, rhythm);

    life = loadLife(paths);
    const diaryDay = config.life.diaryEnabled ? diaryTarget(config, life.lastDiary, now) : null;
    if (diaryDay && !agent.busy) {
      if (policy.allowDiary) {
        const ok = await writeDiary(diaryDay, {
          config,
          paths,
          memory: this.ctx.memory,
          persona: this.ctx.persona,
          emit,
          onChange,
        });
        if (!ok) {
          // No activity, or a transient failure: diaryTarget will retry later.
        }
      } else {
        addDeferred(paths, { kind: "diary", runAfter: policy.nextChangeAt, payload: { day: diaryDay } });
      }
    }

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

    if (!agent.isHolding()) await this.fireReminders(now, rhythm);

    // 先把昨晚静默期记下的话补发掉，再考虑新的自己的时间；两条主动消息不要同一分钟抢着说。
    const flushed = await this.flushPendingShares(now, rhythm);
    this.maybeDecayRoom(now);

    if (config.web.ownTimeEnabled && !agent.busy) {
      await this.maybeOwnTime(now, rhythm, policy);
    }

    if (flushed === 0 && policy.allowProactive && !agent.busy) {
      await this.maybeSpeak(now, rhythm);
    }

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
          await writeDiary(day, {
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

  private async maybeOwnTime(
    now: number,
    rhythm: ReturnType<typeof getRhythm>,
    policy: ReturnType<typeof costPolicy>,
  ): Promise<void> {
    const { config, paths, agent } = this.ctx;
    if (agent.isHolding()) return;
    if (!config.web.ownTimeEnabled) return;
    if (rhythm.phase !== "awake" || isQuietHours(config, now)) return;

    let own = ensureOwnSchedule(config, now, loadOwn(paths));
    if (!policy.allowOwnTime) {
      saveOwn(paths, own);
      return;
    }
    if (!own.nextAt || own.nextAt > now || own.windowEnd <= now) {
      saveOwn(paths, own);
      return;
    }

    const windowEnd = own.windowEnd;
    markOwnStart(own, now, windowEnd);
    saveOwn(paths, own);
    this.ctx.onChange();

    const result = await agent.runOwnTime(now, windowEnd);

    own = loadOwn(paths);
    markOwnEnd(own, Date.now(), result.ok ? result.summary : result.error || "在房间里坐了一会儿。");
    own = ensureOwnSchedule(config, Date.now(), own);

    // 网络/服务端的临时故障不该算作她今天已经出过门：退回这次配额，10 分钟后再试一次。
    const infraFailure =
      result.errorKind === "network" ||
      result.errorKind === "timeout" ||
      result.errorKind === "rate" ||
      result.errorKind === "server";
    if (!result.ok && infraFailure) {
      scheduleOwnRetry(own, config, Date.now());
    }

    if (result.ok) {
      addMilestone(paths, config, "第一次自己出门");
      const remainingShares = Math.max(0, config.speak.tellOwnerMaxPerDay - own.shareCount);
      for (const share of result.shares.slice(0, remainingShares)) {
        if (canShareNow(own, config, Date.now())) {
          await agent.say(share, true);
          own.shareCount += 1;
          appendTimeline(paths, config, { kind: "share", text: `忍不住告诉他：${share.slice(0, 80)}` });
        } else if (isQuietHours(config, Date.now())) {
          // 静默期才排队；配额用完的话 tell_owner 已经跟她说清楚了，不悄悄攒着。
          queueShare(own, share, nextClockTs(Date.now(), config.speak.quietEnd, config.behavior.timezone));
          appendTimeline(paths, config, { kind: "share", text: `想分享，先记着：${share.slice(0, 80)}` });
        }
      }
    } else if (result.error && result.error !== "被打断了。") {
      appendTimeline(paths, config, {
        kind: "own",
        text: `自己的时间没去成：${result.error}`,
        meta: { errorKind: result.errorKind, errorCode: result.errorCode },
      });
    }
    saveOwn(paths, own);
    this.ctx.onChange();
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
    const today = dayKey(now, config.behavior.rotateHour, config.behavior.timezone);
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
