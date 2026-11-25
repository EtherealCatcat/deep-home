import fs from "node:fs";
import path from "node:path";
import type { AppConfig, ChatMessage, LLMMessage, OwnTimeState, QuoteRef, SceneKind } from "./types.js";
import type { Paths } from "./config.js";
import type { MemoryStore } from "./memory.js";
import type { ServerEvent } from "./events.js";
import { buildNow, buildSystem } from "./persona.js";
import { getRhythm, isQuietHours, rhythmPrompt } from "./rhythm.js";
import { loadLife } from "./life.js";
import { loadMood, saveMood, applyMood, heuristicMood, moodDeltaFromJson } from "./mood.js";
import { loadRoom, roomAction, roomActionForOwnTime } from "./room.js";
import { loadRelationship, saveRelationship, updateStreak } from "./relationship.js";
import { loadReminders, pendingReminders } from "./care.js";
import { listStickers, ensureStickers, findSticker } from "./stickers.js";
import { appendChatMessage, messagesBefore, quoteLine, toLLMHistory, yesterdayDigest, todayMessageCount, todayProactiveCount, lastOwnerMessageAt, ensureSession } from "./chat.js";
import { formatClock, nextClockTs } from "./time.js";
import { logicalDayKey } from "./schedule.js";
import { timelineSummary, appendTimeline } from "./timeline.js";
import { costPolicy, isPeak } from "./pricing.js";
import { todayUsage, recordUsage } from "./usage.js";
import {
  BACKGROUND_ATTEMPTS,
  BACKGROUND_TIMEOUT_MS,
  CHAT_ATTEMPTS,
  CHAT_TIMEOUT_MS,
  SIDE_ATTEMPTS,
  SIDE_TIMEOUT_MS,
  callLLM,
  LLMError,
  type LLMFailureKind,
} from "./llm.js";
import type { ChatError } from "./provider.js";
import { appendOwnLog } from "./web.js";
import { cleanReply, parseReply, styleGuard, typingMs, gapMs } from "./reply.js";
import { runToolLoop } from "./agentLoop.js";
import type { ToolContext, OutboxItem } from "./tools.js";
import { loadOwn, queueShare, recentOwnResult, resetShareDay, saveOwn } from "./own.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ChatImage {
  file: string;
  mime: string;
}

export interface AgentContext {
  config: AppConfig;
  paths: Paths;
  memory: MemoryStore;
  persona: string;
}

export class ChatAgent {
  private pending: { text: string; ts: number; quote?: QuoteRef; image?: ChatImage }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ownMode = false;
  private holding = false;
  /** 本轮连发开始的时刻；撤销时用它划掉这之后的所有用户消息。 */
  private holdStartedAt = 0;
  private abort: AbortController | null = null;
  private turnSeq = 0;
  private sentInTurn = false;
  private historyFrom = 0;
  private debug: Record<string, unknown> | null = null;
  private lastChatError: ChatError | null = null;

  constructor(
    private ctx: AgentContext,
    private emit: (event: ServerEvent) => void,
    private onChange: () => void,
  ) {}

  get busy(): boolean {
    return this.running;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get historyStart(): number {
    return this.historyFrom;
  }

  getLastChatError(): ChatError | null {
    return this.lastChatError;
  }

  clearLastChatError(): void {
    this.lastChatError = null;
  }

  isHolding(): boolean {
    return this.holding;
  }

  get burstStartedAt(): number {
    return this.holdStartedAt;
  }

  /**
   * 连发模式：消息只落盘并攒在 pending 里，不唤醒她；关掉时才把整批交给她。
   */
  setHold(active: boolean): boolean {
    const next = Boolean(active);
    if (next && !this.holding) this.holdStartedAt = Date.now();
    if (!next) this.holdStartedAt = 0;
    this.holding = next;
    if (this.holding) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    } else if (this.pending.length && !this.running) {
      this.arm(300);
    }
    this.onChange();
    return this.holding;
  }

  /**
   * 放弃这次连发：退出连发、丢掉这之后攒下的消息，不交给她。
   * 返回被丢掉的 pending 条数；连发期间已经落盘的聊天记录由调用方清理。
   */
  cancelHold(): number {
    const since = this.holdStartedAt;
    this.holding = false;
    this.holdStartedAt = 0;
    const before = this.pending.length;
    if (since > 0) {
      this.pending = this.pending.filter((item) => item.ts < since);
    }
    if (this.pending.length && !this.running) this.arm(300);
    this.onChange();
    return before - this.pending.length;
  }

  setContext(ctx: AgentContext): void {
    this.ctx = ctx;
  }

  enqueue(text: string, ts = Date.now(), quote?: QuoteRef, image?: ChatImage): void {
    const clean = text.trim();
    if (!clean && !image) return;
    this.pending.push({ text: clean || "（发来一张图片）", ts, quote, image });
    if (this.holding) {
      this.onChange();
      return;
    }
    if (this.running && this.ownMode) {
      this.abort?.abort();
      return;
    }
    if (!this.running) this.arm();
  }

  getDebug(): Record<string, unknown> | null {
    return this.debug;
  }

  newSession(): void {
    this.holding = false;
    this.holdStartedAt = 0;
    this.pending = [];
    this.historyFrom = Date.now();
    this.emit({ type: "read", at: Date.now() });
    this.onChange();
  }

  stop(): void {
    this.holding = false;
    this.holdStartedAt = 0;
    this.pending = [];
    this.ownMode = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    if (this.running) {
      this.running = false;
      this.emit({ type: "busy", busy: false });
      this.onChange();
    }
  }

  private arm(delay = this.ctx.config.behavior.burstMs): void {
    if (this.holding) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(300, delay));
  }

  private async flush(): Promise<void> {
    if (this.holding || this.running || !this.pending.length) return;
    const batch = this.pending.splice(0);
    const firstTs = batch[0]?.ts ?? Date.now();
    const text = batch.map((item) => item.text).join("\n");
    const quote = batch.find((item) => item.quote)?.quote;
    const image = batch.find((item) => item.image)?.image;
    await this.runTurn(text, firstTs, false, quote, image);
    if (this.pending.length && !this.running) this.arm(300);
  }

  async proactive(nudge: string): Promise<boolean> {
    if (this.holding || this.running || this.pending.length) return false;
    this.sentInTurn = false;
    await this.runTurn(nudge, Date.now(), true);
    return this.sentInTurn;
  }

  private async runTurn(
    text: string,
    firstTs: number,
    proactive: boolean,
    quote?: QuoteRef,
    image?: ChatImage,
  ): Promise<void> {
    const { config, paths, memory } = this.ctx;
    const turnId = `turn-${Date.now().toString(36)}-${++this.turnSeq}`;
    this.running = true;
    this.sentInTurn = false;
    this.abort = new AbortController();
    this.emit({ type: "busy", busy: true });
    this.onChange();

    try {
      if (!config.model.apiKey.trim()) {
        this.emit({ type: "error", message: "还没有配置 DeepSeek API Key。打开设置，把 key 填进去。" });
        return;
      }

      const now = Date.now();
      const day = logicalDayKey(config, now);
      const usage = todayUsage(paths, config);
      const policy = costPolicy(config, usage, now);
      const historyLimit = Math.max(1, policy.historyMessages);
      const history = toLLMHistory(
        messagesBefore(paths, config, firstTs, historyLimit).filter((m) => m.ts >= this.historyFrom),
        historyLimit,
        config,
      );
      const relationship = loadRelationship(paths, config);
      const rhythm = getRhythm(config, loadLife(paths), now);
      const mood = loadMood(paths, config);
      const room = loadRoom(paths);
      const reminders = pendingReminders(paths);
      // 补跑时 now 是原计划的时刻：别让她看到那之后才发生的事。
      const todaySummary = timelineSummary(paths, config, day, 14, now);
      const recalls = memory.recall(text, 3);
      const justRemembered = memory.recentInbox(4);
      const stickers = ensureStickers(paths);

      const system = buildSystem({
        config,
        kind: "chat",
        memory: memory.prompt(),
        relationship,
        yesterdaySummary: yesterdayDigest(paths, config),
        room,
        persona: this.ctx.persona,
      });
      const nowBlock = buildNow({
        config,
        kind: "chat",
        now,
        rhythm: rhythmPrompt(rhythm, config),
        mood,
        room,
        todaySummary,
        reminders,
        relationship,
        lastOwnerAt: lastOwnerMessageAt(paths, config),
        todayMessages: todayMessageCount(paths, config),
        proactiveToday: todayProactiveCount(paths, config),
        recalls,
        justRemembered,
        stickers,
        activity: recentOwnResult(loadOwn(paths), now),
      });

      const body = proactive
        ? `<内心>\n${text}\n</内心>`
        : `${quote ? `${quoteLine(quote, config)}\n` : ""}${config.ownerTitle}：${text}`;
      let userContent: LLMMessage["content"] = `${nowBlock}\n\n${body}`;
      if (image && !proactive) {
        const file = path.join(paths.media, path.basename(image.file));
        if (fs.existsSync(file)) {
          const base64 = fs.readFileSync(file).toString("base64");
          userContent = [
            { type: "text", text: `${nowBlock}\n\n${body}` },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${base64}` } },
          ];
        }
      }
      const messages: LLMMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userContent },
      ];

      ensureSession(paths, config);
      if (!proactive && todayMessageCount(paths, config) === 1) {
        updateStreak(paths, config);
      }

      const outbox: OutboxItem[] = [];
      const toolContext: ToolContext = {
        config,
        paths,
        scene: "chat",
        memory,
        now,
        outbox,
        onTimeline: (event) => this.emit({ type: "timeline", event }),
      };

      const result = await runToolLoop({
        config,
        paths,
        messages,
        scene: "chat",
        maxSteps: policy.maxToolSteps,
        maxTokens: policy.maxOutputTokens,
        toolContext,
        kind: proactive ? "proactive" : "chat",
        signal: this.abort.signal,
        llmOptions: { attempts: CHAT_ATTEMPTS, timeoutMs: CHAT_TIMEOUT_MS },
      });
      this.lastChatError = null;

      let raw = result.content.trim();
      if (raw && styleGuard(raw).violation && !policy.isPeak && policy.budgetState !== "exhausted") {
        raw = await this.retryStyle(raw, messages, policy.maxOutputTokens);
      }

      const quoteCandidates = messagesBefore(paths, config, now + 1, 30).filter((m) => m.ts >= this.historyFrom);
      const parsed = parseReply(raw, config, quoteCandidates);
      this.debug = {
        at: now,
        turnId,
        proactive,
        system: system.slice(0, 8000),
        nowBlock: nowBlock.slice(0, 6000),
        history: history.slice(-12),
        raw: raw.slice(0, 4000),
        toolCalls: result.toolCalls,
        bubbles: parsed.bubbles,
        silent: parsed.silent,
      };
      const bubbles = parsed.bubbles;
      if (!bubbles.length || parsed.silent) {
        if (!proactive) {
          const silent = appendChatMessage(paths, config, {
            role: "assistant",
            kind: "silent",
            text: "",
          });
          this.emit({ type: "message", message: silent });
          this.emit({ type: "read", at: Date.now() });
        }
      } else {
        await this.deliver(bubbles, proactive);
        this.sentInTurn = true;
      }

      for (const item of outbox) {
        if (item.kind === "sticker") {
          await this.deliverSticker(item.text, proactive);
        } else if (item.kind === "image") {
          await this.deliverImage(item.text, proactive);
        }
      }

      if (!proactive) this.emit({ type: "read", at: Date.now() });

      const replyText = bubbles
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join(" ");
      await this.updateMood(text, replyText, policy);
      appendTimeline(paths, config, {
        kind: proactive ? "speak" : "chat",
        text: proactive ? "主动找主人说话" : `和${config.ownerTitle}聊了 ${text.length} 字`,
        meta: { proactive, bubbles: bubbles.length, turns: 1, chars: text.length },
      });
      this.emit({
        type: "timeline",
        event: {
          ts: Date.now(),
          kind: proactive ? "speak" : "chat",
          text: proactive ? "主动找主人说话" : "聊天",
        },
      });
    } catch (error) {
      if (this.abort?.signal.aborted) return;
      const failure = error instanceof LLMError ? error : null;
      const kind: LLMFailureKind = failure?.kind ?? "unknown";
      const message = failure?.message ?? (error instanceof Error ? error.message : "出了点问题，稍后再试。");
      const retryable = kind !== "auth" && kind !== "config";
      this.lastChatError = { message, kind, at: Date.now(), retryable };
      this.emit({ type: "error", message, kind, retryable, at: this.lastChatError.at });
    } finally {
      this.running = false;
      this.abort = null;
      this.emit({ type: "done", turnId });
      this.emit({ type: "busy", busy: false });
      this.onChange();
      if (!this.holding && this.pending.length) this.arm(300);
    }
  }

  async runOwnTime(
    now: number,
    windowEnd: number,
    opts: { catchUp?: boolean } = {},
  ): Promise<{ ok: boolean; summary: string; shares: string[]; error?: string; errorKind?: LLMFailureKind | "aborted"; errorCode?: string }> {
    const { config, paths, memory } = this.ctx;
    if (this.holding) return { ok: false, summary: "", shares: [], error: "连发中，先等她收完。" };
    if (this.running) return { ok: false, summary: "", shares: [], error: "正忙着。" };

    this.running = true;
    this.ownMode = true;
    this.abort = new AbortController();
    this.emit({ type: "busy", busy: true });
    this.onChange();

    try {
      if (!config.model.apiKey.trim()) {
        return { ok: false, summary: "", shares: [], error: "还没有配置 API Key。" };
      }
      if (!config.web.ownTimeEnabled) {
        return { ok: false, summary: "", shares: [], error: "自己的时间关着。" };
      }
      const usage = todayUsage(paths, config);
      const policy = costPolicy(config, usage, now);
      if (!policy.allowOwnTime) {
        return { ok: false, summary: "", shares: [], error: policy.reason };
      }

      const day = logicalDayKey(config, now);
      const relationship = loadRelationship(paths, config);
      const rhythm = getRhythm(config, loadLife(paths), now);
      const mood = loadMood(paths, config);
      const room = loadRoom(paths);
      const reminders = pendingReminders(paths);
      const todaySummary = timelineSummary(paths, config, day);
      const recalls = memory.recall("最近 自己 想做的事 笔记", 3);
      const justRemembered = memory.recentInbox(3);

      const system = buildSystem({
        config,
        kind: "own",
        memory: memory.prompt(),
        relationship,
        yesterdaySummary: yesterdayDigest(paths, config),
        room,
        persona: this.ctx.persona,
      });
      const nowBlock = buildNow({
        config,
        kind: "own",
        now,
        rhythm: rhythmPrompt(rhythm, config),
        mood,
        room,
        todaySummary,
        reminders,
        relationship,
        lastOwnerAt: lastOwnerMessageAt(paths, config),
        todayMessages: todayMessageCount(paths, config),
        proactiveToday: todayProactiveCount(paths, config),
        recalls,
        justRemembered,
        stickers: [],
        activity: "自己的时间",
      });

      const canWeb = config.web.enabled;
      const body = `<内心>
现在是你的自己的时间（${formatClock(now, config.behavior.timezone)} 到 ${formatClock(windowEnd, config.behavior.timezone)}）。主人没有来找你。
你可以先翻翻笔记（note_read）或记忆（recall），${canWeb ? "看看订阅（rss_read），挑一篇读（web_read），或者搜一下（web_search），" : "今天网络关着，就在房间里待着，"}或者什么都不做。
如果看到什么真想告诉他，用 tell_owner（今天最多 ${config.speak.tellOwnerMaxPerDay} 次）。
不要为了显得有用而做事。结束时用一两句话记下你做了什么、想了什么。
</内心>`;

      const outbox: OutboxItem[] = [];
      // tell_owner 要说实话：能发、只能记到早上、或者今天已经说得够多了，三种回执不一样。
      const tellOwner = (text: string): string => {
        const state = loadOwn(paths);
        resetShareDay(state, config, now);
        const outgoing = outbox.filter((item) => item.kind === "text").length;
        // 已经排到早上的话也占当天的名额，免得她一句接一句地“先记着”。
        const remaining = config.speak.tellOwnerMaxPerDay - state.shareCount - state.pendingShares.length - outgoing;
        if (remaining <= 0) return "（今天说得够多了，先不说了。）";
        if (isQuietHours(config, now)) {
          // 记下的是“明天早上静默结束”的时刻，晚上收尾时说的话不会因为过了 5 点就作废。
          queueShare(state, text, nextClockTs(now, config.speak.quietEnd, config.behavior.timezone));
          saveOwn(paths, state);
          appendTimeline(paths, config, {
            kind: "share",
            text: `想分享，先记着：${text.replace(/\s+/g, " ").slice(0, 80)}`,
            ts: now,
          });
          return "（先记着，早上再说。）";
        }
        outbox.push({ kind: "text", text });
        return "（说给他听了。）";
      };
      const toolContext: ToolContext = {
        config,
        paths,
        scene: "own",
        memory,
        now,
        outbox,
        tellOwner,
        catchUp: Boolean(opts.catchUp),
        onTimeline: (event) => this.emit({ type: "timeline", event }),
      };
      const result = await runToolLoop({
        config,
        paths,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${nowBlock}

${body}` },
        ],
        scene: "own",
        maxSteps: Math.min(8, Math.max(3, policy.maxToolSteps + 2)),
        maxTokens: policy.maxOutputTokens,
        toolContext,
        kind: "own",
        signal: this.abort.signal,
        llmOptions: { attempts: BACKGROUND_ATTEMPTS, timeoutMs: BACKGROUND_TIMEOUT_MS },
      });

      const summary = cleanReply(result.content).slice(0, 1200) || "在房间里坐了一会儿，什么也没做。";
      // 她没主动 room_do 的话，房间也要跟着她刚做过的事变一下。
      if (!result.toolCalls.some((call) => call.name === "room_do")) {
        const action = roomActionForOwnTime(result.toolCalls.map((call) => call.name));
        const nextRoom = roomAction(paths, action);
        appendTimeline(paths, config, { kind: "room", text: nextRoom.status, ts: now, meta: { from: "own" } });
        this.onChange();
      }
      appendOwnLog(paths, config, summary, now);
      const shares = outbox.filter((item) => item.kind === "text").map((item) => item.text.trim()).filter(Boolean);
      const nextMood = applyMood(loadMood(paths, config), { ...heuristicMood(summary), source: "own" }, config);
      saveMood(paths, nextMood);
      this.emit({ type: "mood", mood: nextMood });
      appendTimeline(paths, config, {
        kind: "own",
        text: `过了会儿自己的时间：${summary.replace(/\s+/g, " ").slice(0, 80)}`,
        meta: { shares: shares.length },
        ts: now,
      });
      this.emit({
        type: "timeline",
        event: { ts: now, kind: "own", text: "自己的时间" },
      });
      return { ok: true, summary, shares };
    } catch (error) {
      if (this.abort?.signal.aborted) {
        return { ok: false, summary: "", shares: [], error: "被打断了。", errorKind: "aborted" };
      }
      if (error instanceof LLMError) {
        return {
          ok: false,
          summary: "",
          shares: [],
          error: error.message,
          errorKind: error.kind,
          errorCode: error.code,
        };
      }
      const message = error instanceof Error ? error.message : "自己的时间出了点问题。";
      return { ok: false, summary: "", shares: [], error: message, errorKind: "unknown" };
    } finally {
      this.running = false;
      this.ownMode = false;
      this.abort = null;
      this.emit({ type: "busy", busy: false });
      this.onChange();
      if (this.pending.length) this.arm(400);
    }
  }

  async say(
    text: string,
    proactive = true,
    at: number = Date.now(),
    opts: { silent?: boolean; catchUp?: boolean } = {},
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    if (!opts.silent) {
      this.emit({ type: "typing", on: true });
      await sleep(Math.min(1800, 400 + clean.length * 35));
      this.emit({ type: "typing", on: false });
    }
    const meta: Record<string, unknown> = {};
    if (proactive) meta.proactive = true;
    if (opts.silent) meta.silent = true;
    if (opts.catchUp) meta.catchUp = true;
    const msg = appendChatMessage(this.ctx.paths, this.ctx.config, {
      role: "assistant",
      kind: "text",
      text: clean,
      ts: at,
      meta: Object.keys(meta).length ? meta : undefined,
    });
    this.emit({ type: "message", message: msg });
    this.sentInTurn = true;
    this.onChange();
  }

  private async retryStyle(raw: string, messages: LLMMessage[], maxTokens: number): Promise<string> {
    const { config, paths } = this.ctx;
    try {
      const result = await callLLM(
        config,
        [
          ...messages,
          { role: "assistant", content: raw },
          { role: "user", content: "（重说。就像平时发消息，短一点，别解释，别像助手。）" },
        ],
        {
          maxTokens: Math.min(maxTokens, 300),
          temperature: 1.2,
          signal: this.abort?.signal,
          attempts: SIDE_ATTEMPTS,
          timeoutMs: SIDE_TIMEOUT_MS,
        },
      );
      recordUsage(paths, config, {
        model: result.model,
        provider: config.model.provider,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        cacheHitTokens: result.usage.prompt_cache_hit_tokens,
        cacheMissTokens: result.usage.prompt_cache_miss_tokens,
        peak: isPeak(config, Date.now()),
        kind: "style-retry",
      });
      return result.content.trim() || raw;
    } catch {
      return raw;
    }
  }

  private async deliver(
    bubbles: { kind: "text" | "sticker" | "image" | "monologue" | "silent"; text: string; quote?: QuoteRef }[],
    proactive: boolean,
  ): Promise<void> {
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      if (bubble.kind === "silent") continue;
      if (bubble.kind === "sticker") {
        await this.deliverSticker(bubble.text, proactive, bubble.quote);
      } else if (bubble.kind === "image") {
        await this.deliverImage(bubble.text, proactive, bubble.quote);
      } else if (bubble.kind === "monologue") {
        await this.emitTyping(false);
        const msg = appendChatMessage(this.ctx.paths, this.ctx.config, {
          role: "assistant",
          kind: "monologue",
          text: bubble.text,
          meta: { proactive },
          quote: bubble.quote,
        });
        this.emit({ type: "message", message: msg });
      } else {
        this.emit({ type: "typing", on: true });
        await sleep(typingMs(bubble.text, this.ctx.config));
        this.emit({ type: "typing", on: false });
        const msg = appendChatMessage(this.ctx.paths, this.ctx.config, {
          role: "assistant",
          kind: "text",
          text: bubble.text,
          meta: proactive ? { proactive: true } : undefined,
          quote: bubble.quote,
        });
        this.emit({ type: "message", message: msg });
      }
      if (i < bubbles.length - 1) await sleep(gapMs());
    }
  }

  private async deliverSticker(name: string, proactive: boolean, quote?: QuoteRef): Promise<void> {
    const { config, paths } = this.ctx;
    const sticker = findSticker(paths, name);
    const msg = appendChatMessage(paths, config, {
      role: "assistant",
      kind: "sticker",
      text: sticker?.name ?? name,
      meta: {
        ...(sticker?.emoji ? { emoji: sticker.emoji } : {}),
        ...(sticker?.file ? { file: sticker.file } : {}),
        ...(sticker?.desc ? { desc: sticker.desc } : {}),
        ...(sticker?.scene ? { scene: sticker.scene } : {}),
        proactive,
      },
      quote,
    });
    await this.emitTyping(false, 250);
    this.emit({ type: "message", message: msg });
  }

  private async deliverImage(file: string, proactive: boolean, quote?: QuoteRef): Promise<void> {
    const { config, paths } = this.ctx;
    const msg = appendChatMessage(paths, config, {
      role: "assistant",
      kind: "image",
      text: "",
      meta: { file, proactive },
      quote,
    });
    this.emit({ type: "message", message: msg });
  }

  private async emitTyping(on: boolean, wait = 0): Promise<void> {
    this.emit({ type: "typing", on });
    if (on && wait > 0) await sleep(wait);
  }

  private async updateMood(userText: string, replyText: string, policy: ReturnType<typeof costPolicy>): Promise<void> {
    const { config, paths } = this.ctx;
    if (!config.mood.enabled) return;
    try {
      if (policy.allowSideCalls && policy.budgetState !== "exhausted") {
        const result = await callLLM(
          config,
          [
            {
              role: "system",
              content:
                "你是情绪观察器。读一段主人和角色的对话，判断角色心情的变化。只输出 JSON：{\"delta\":-15到15的整数,\"dims\":{\"happy\":...,\"calm\":...,\"sweet\":...,\"miss\":...,\"shy\":...,\"worry\":...,\"sad\":...,\"jealous\":...,\"angry\":...,\"bored\":...,\"heartache\":...},\"reason\":\"一句话\"}。dims 每项 -30 到 30，没有变化就省略。",
            },
            {
              role: "user",
              content: `${config.ownerTitle}：${userText.slice(0, 1200)}\n${config.name}：${replyText.slice(0, 1200)}`,
            },
          ],
          {
            maxTokens: 180,
            model: config.model.sideModel,
            temperature: 0.2,
            json: true,
            signal: this.abort?.signal,
            attempts: SIDE_ATTEMPTS,
            timeoutMs: SIDE_TIMEOUT_MS,
          },
        );
        recordUsage(paths, config, {
          model: result.model,
          provider: config.model.provider,
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          cacheHitTokens: result.usage.prompt_cache_hit_tokens,
          cacheMissTokens: result.usage.prompt_cache_miss_tokens,
          peak: isPeak(config, Date.now()),
          kind: "mood",
        });
        const parsed = safeJson(result.content);
        const change = moodDeltaFromJson(parsed);
        if (change) {
          const next = applyMood(loadMood(paths, config), { ...change, source: "chat" }, config);
          saveMood(paths, next);
          this.emit({ type: "mood", mood: next });
          return;
        }
      }
      const next = applyMood(loadMood(paths, config), { ...heuristicMood(`${userText}\n${replyText}`), source: "chat" }, config);
      saveMood(paths, next);
      this.emit({ type: "mood", mood: next });
    } catch {
      // Mood is best-effort; never fail a reply because of it.
    }
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function formatNow(ts: number, config: AppConfig): string {
  return formatClock(ts, config.behavior.timezone);
}
