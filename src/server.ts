import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type { AppConfig, QuoteRef } from "./types.js";
import { dataRoot, deepMerge, ensureLayout, loadConfig, maskConfig, paths, saveConfig } from "./config.js";
import { MemoryStore } from "./memory.js";
import { ChatAgent } from "./agent.js";
import { Scheduler } from "./scheduler.js";
import { buildStatus } from "./status.js";
import { DEFAULT_PERSONA } from "./persona.js";
import {
  backfillMilestones,
  recordFirstChat,
  relationshipDescription,
  relationshipGrowth,
  updateStreak,
} from "./relationship.js";
import { appendChatMessage, planRetry, recentMessages, removeUserMessagesSince } from "./chat.js";
import { addReminder, cancelReminder, loadReminders, markReminderDone, parseDue } from "./care.js";
import { listDiaries, readDiary, yesterdayKey } from "./diaryStore.js";
import { diarySlotSnapshot, diaryTarget, diaryTargetForDay, writeDiary } from "./diary.js";
import { getSchedule, isQuietHours, lastSleepAtBefore, logicalDayKey, logicalDayRange, nextWakeAt, validateLifeConfig } from "./schedule.js";
import { consolidateMemory, hasInbox, readConsolidateState } from "./consolidate.js";
import { appendTimeline, readTimelineBetween, readTimelineForDisplay } from "./timeline.js";
import { loadDeferred, loadLife, saveLife } from "./life.js";
import { todayUsage } from "./usage.js";
import { MODEL_PRICES, costPolicy, normalizePeakWindows, peakInfo } from "./pricing.js";
import { SIDE_ATTEMPTS, SIDE_TIMEOUT_MS, callLLM, getLastLLMFailure, LLMError } from "./llm.js";
import { providerSnapshot, resetProviderHealth } from "./provider.js";
import { findSticker, listStickers } from "./stickers.js";
import { avatarFile, avatarInfo, clearAvatar, saveAvatar } from "./avatar.js";
import { loadOwn, markOwnSeen, ownStateSnapshot, reconcileOwnAfterScheduleChange, saveOwn } from "./own.js";
import { readOwnLog } from "./web.js";
import { isAllowedOrigin, isLoopbackOrigin, isRequestOriginAllowed } from "./security.js";
import { readDayBoundary, writeDayBoundary } from "./dayBoundary.js";
import { backupFile, exists, listFiles, readText, writeText } from "./store.js";
import { formatClock, nextClockTs, weekdayCN } from "./time.js";
import type { ServerEvent } from "./events.js";

const root = dataRoot();
const p = paths(root);
ensureLayout(p);

// 旧数据还在用 05:00 的日界；应用现在写入作息逻辑日，读取同时兼容两边。
if (readDayBoundary(p).mode === "legacy") {
  const hasOldFiles = listFiles(p.chat, ".jsonl").length > 0 || listFiles(p.timeline, ".jsonl").length > 0;
  writeDayBoundary(p, hasOldFiles ? "dual" : "logical", {
    note: hasOldFiles ? "新数据按作息逻辑日写入，旧文件继续可读。" : "新数据按作息逻辑日写入。",
  });
}

const firstRun = !exists(p.config);
let config = loadConfig(p);
if (firstRun) {
  // 首次启动：先留一个占位名字，强制用户去设置页起名；模型也留空待单独配置。
  config.name = "某鱼";
  config.ownerTitle = "主人";
  config.setupPending = true;
  config.model.model = "";
  config.model.sideModel = "";
  config.model.apiKey = "";
  saveConfig(p, config);
}
if (!exists(p.persona)) writeText(p.persona, DEFAULT_PERSONA);
let persona = readText(p.persona, DEFAULT_PERSONA).trim() || DEFAULT_PERSONA;

const memory = new MemoryStore(p, config);
memory.ensure();
updateStreak(p, config);
backfillMilestones(p, config);

const app = Fastify({ logger: { level: "warn" }, bodyLimit: 20 * 1024 * 1024 });
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, isAllowedOrigin(origin) || isLoopbackOrigin(origin));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

// CORS headers alone do not stop simple requests from executing. Reject foreign
// origins outright so a random web page cannot read memories, send messages, or
// spend the daily budget while she is running.
app.addHook("onRequest", async (request, reply) => {
  if (isRequestOriginAllowed(request.headers.origin, request.headers.host)) return;
  request.log.warn(
    { origin: request.headers.origin, host: request.headers.host, url: request.url },
    "blocked cross-origin request",
  );
  return reply.code(403).send({ error: "这个来源不被允许。" });
});

const clients = new Set<NodeJS.WritableStream & { write: (chunk: string) => boolean }>();
let unread = 0;

function emit(event: ServerEvent): void {
  if (event.type === "message" && event.message.role === "assistant") {
    unread += 1;
    broadcast(event);
    onChange();
    return;
  }
  broadcast(event);
}

function broadcast(event: ServerEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function currentStatus() {
  return buildStatus({
    config,
    paths: p,
    busy: agent.busy,
    burst: agent.isHolding(),
    burstCount: agent.pendingCount,
    unread,
    lastChatError: agent.getLastChatError(),
  });
}

function onChange(): void {
  broadcast({ type: "status", status: currentStatus() });
}

const agent = new ChatAgent({ config, paths: p, memory, persona }, emit, onChange);
const scheduler = new Scheduler({ config, paths: p, memory, persona, agent, emit, onChange });

function refreshContext(): void {
  const next = { config, paths: p, memory, persona };
  agent.setContext(next);
  scheduler.setContext({ ...next, agent, emit, onChange });
}

function requireObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function paramDay(params: unknown): string {
  const day = String((params as { day?: string }).day ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : logicalDayKey(config, Date.now());
}

// ---------- status & realtime ----------

const APP_VERSION = "0.6.0";

app.get("/api/health", async () => ({
  ok: true,
  name: config.name.trim() || "某鱼",
  version: APP_VERSION,
  root,
  hasKey: Boolean(config.model.apiKey),
  time: Date.now(),
}));

app.get("/api/status", async () => currentStatus());

app.get("/api/events", async (request, reply) => {
  reply.hijack();
  const res = reply.raw;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  // The hijacked response bypasses @fastify/cors, so reflect the (already
  // validated) origin here instead of the previous wildcard.
  const origin = request.headers.origin;
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  res.writeHead(200, headers);
  clients.add(res as unknown as NodeJS.WritableStream & { write: (chunk: string) => boolean });
  res.write(`retry: 3000\n\n`);
  res.write(`data: ${JSON.stringify({ type: "status", status: currentStatus() })}\n\n`);
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res as unknown as NodeJS.WritableStream & { write: (chunk: string) => boolean });
  });
});

// ---------- chat ----------

app.get("/api/messages", async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.max(1, Math.min(300, Number(query.limit) || 80));
  return { messages: recentMessages(p, config, limit) };
});

app.post("/api/messages", async (request, reply) => {
  const body = requireObject(request.body);
  const text = String(body.text ?? "").trim();
  const rawImage = typeof body.image === "string" ? body.image.trim() : "";
  const stickerName = String(body.sticker ?? "").trim();
  const sticker = stickerName ? findSticker(p, stickerName) : null;
  if (stickerName && !sticker) return reply.code(400).send({ error: "这个表情找不到了。" });
  if (!text && !rawImage && !sticker) return reply.code(400).send({ error: "说点什么吧，或者发一张图片。" });
  if (text.length > 4000) return reply.code(413).send({ error: "太长了，分几次说。" });
  if (sticker && rawImage) return reply.code(400).send({ error: "表情和图片一次只能发一个。" });

  let imageInfo: { file: string; mime: string } | undefined;
  if (rawImage) {
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(rawImage);
    if (!match) return reply.code(400).send({ error: "这张图片的格式不支持。" });
    const mime = match[1];
    const data = Buffer.from(match[2], "base64");
    if (!data.length) return reply.code(400).send({ error: "这张图片是空的。" });
    if (data.length > 8 * 1024 * 1024) return reply.code(413).send({ error: "这张图太大了，压缩一下再发。" });
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    const file = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(p.media, file), data);
    imageInfo = { file, mime };
  }

  const quoteId = String(body.quoteId ?? "").trim();
  let quote: QuoteRef | undefined;
  if (quoteId) {
    const original = recentMessages(p, config, 300).find((m) => m.id === quoteId);
    if (!original) return reply.code(400).send({ error: "引用的消息找不到了。" });
    quote = {
      id: original.id,
      role: original.role,
      kind: original.kind,
      text: original.text.slice(0, 240),
      ts: original.ts,
    };
  }

  if (sticker) {
    unread = 0;
    const message = appendChatMessage(p, config, {
      role: "user",
      kind: "sticker",
      text: sticker.name,
      meta: {
        file: sticker.file,
        emoji: sticker.emoji,
        desc: sticker.desc,
        scene: sticker.scene,
      },
      quote,
    });
    updateStreak(p, config);
    recordFirstChat(p, config);
    emit({ type: "message", message });
    const detail = sticker.desc ?? sticker.scene ?? "一张表情";
    agent.enqueue(`（${config.ownerTitle}发来一个表情：${sticker.name}，${detail}）`, undefined, quote);
    onChange();
    return { ok: true, message };
  }

  unread = 0;
  const message = appendChatMessage(p, config, {
    role: "user",
    kind: imageInfo ? "image" : "text",
    text: text || "（发来一张图片）",
    quote,
    ...(imageInfo ? { meta: imageInfo } : {}),
  });
  updateStreak(p, config);
  recordFirstChat(p, config);
  emit({ type: "message", message });
  agent.enqueue(text || "（发来一张图片，看看是什么。）", undefined, quote, imageInfo);
  onChange();
  return { ok: true, message };
});

app.post("/api/retry", async (_request, reply) => {
  if (agent.busy) return reply.code(409).send({ error: "她还在回上一条，等一下。" });
  const plan = planRetry(recentMessages(p, config, 80), agent.historyStart);
  if (!plan.ok) return reply.code(plan.status).send({ error: plan.error });
  agent.enqueue(plan.text || "（发来一张图片，看看是什么。）", plan.firstTs, plan.quote, plan.image);
  return { ok: true, count: plan.count };
});

app.post("/api/read", async () => {
  unread = 0;
  onChange();
  return { ok: true };
});

app.post("/api/typing", async () => ({ ok: true }));

app.post("/api/reaction", async (request) => {
  const body = requireObject(request.body);
  const messageId = String(body.messageId ?? "");
  const reaction = String(body.reaction ?? "").slice(0, 20);
  const message = recentMessages(p, config, 300).find((m) => m.id === messageId);
  if (message && reaction) {
    appendTimeline(p, config, {
      kind: "reaction",
      text: `${reaction}了「${message.text.slice(0, 20)}」`,
      meta: { messageId, reaction },
    });
    emit({ type: "timeline", event: { ts: Date.now(), kind: "reaction", text: `${reaction}` } });
  }
  return { ok: true };
});

app.post("/api/stop", async () => {
  agent.stop();
  return { ok: true };
});

app.get("/api/burst", async () => ({ active: agent.isHolding(), count: agent.pendingCount }));

app.post("/api/burst", async (request) => {
  const body = requireObject(request.body);
  const active = Boolean(body.active);
  agent.setHold(active);
  return { ok: true, active, count: agent.pendingCount };
});

app.post("/api/burst/cancel", async () => {
  const startedAt = agent.burstStartedAt;
  agent.cancelHold();
  if (!startedAt) {
    return { ok: true, cancelled: 0, active: false, count: agent.pendingCount };
  }
  // 连发期间的消息在发送时已经落盘，这里把它们从聊天记录里也拿掉，
  // 不留给模型，也不留给下次打开时的历史。
  const cancelled = removeUserMessagesSince(p, config, startedAt);
  updateStreak(p, config);
  broadcast({ type: "burst_cancel", from: startedAt });
  onChange();
  return { ok: true, cancelled, active: false, count: agent.pendingCount };
});

app.post("/api/new", async () => {
  agent.newSession();
  return { ok: true };
});

app.post("/api/command", async (request, reply) => {
  const body = requireObject(request.body);
  const command = String(body.command ?? "").trim();
  if (command === "/stop") {
    agent.stop();
    return { ok: true, text: "停下了。" };
  }
  if (command === "/new") {
    agent.newSession();
    return { ok: true, text: "好，重新开始。" };
  }
  if (command === "/status") {
    const s = currentStatus();
    return {
      ok: true,
      text: `${s.name} · ${s.rhythm.label} · ${s.moodLabel}\n在${s.activity}。今天聊了 ${s.todayMessages} 句，主动 ${s.proactiveToday} 次。`,
    };
  }
  if (command === "/diary") {
    const target = diaryTarget(config, loadLife(p), Date.now());
    if (!target) return { ok: true, text: "今天还没到写日记的时候。" };
    const ok = await writeDiary(target, { config, paths: p, memory, persona, emit, onChange });
    return { ok, text: ok ? `写好了 ${target.day} 的日记。` : "今天没有可写的，或者写失败了。" };
  }
  return reply.code(400).send({ error: "不认识这个命令。" });
});

// ---------- memory & persona ----------

app.get("/api/memory", async () => memory.snapshot());

app.put("/api/memory", async (request, reply) => {
  const body = requireObject(request.body);
  const name = String(body.name ?? "");
  const content = String(body.content ?? "");
  if (content.length > 20_000) return reply.code(413).send({ error: "这段记忆太长了。" });
  if (name === "owner" || name === "me" || name === "we") {
    memory.writeCore(name, content);
    onChange();
    return { ok: true };
  }
  if (name.startsWith("topic:")) {
    const title = name.slice(6).trim().replace(/[\\/:*?"<>|]/g, "-");
    if (!title) return reply.code(400).send({ error: "话题名不能为空。" });
    const file = memory.topicFile(title);
    if (readText(file)) backupFile(p, file, `topic-${title}`);
    writeText(file, content.trim() + "\n");
    onChange();
    return { ok: true };
  }
  return reply.code(400).send({ error: "不认识这份记忆。" });
});

app.get("/api/persona", async () => ({ persona, defaultPersona: DEFAULT_PERSONA }));

app.put("/api/persona", async (request, reply) => {
  const body = requireObject(request.body);
  const content = String(body.content ?? "").trim();
  if (content.length < 50) return reply.code(400).send({ error: "人设太短了，再写一点。" });
  if (content.length > 20_000) return reply.code(413).send({ error: "人设太长了。" });
  backupFile(p, p.persona, "persona");
  writeText(p.persona, content + "\n");
  persona = content;
  refreshContext();
  onChange();
  return { ok: true };
});

// ---------- diary, timeline, reminders ----------

app.get("/api/diary", async () => ({ diaries: listDiaries(p) }));

app.get("/api/diary/:day", async (request, reply) => {
  const day = paramDay(request.params);
  const content = readDiary(p, day);
  if (!content) return reply.code(404).send({ error: "这一天还没有日记。" });
  return { day, content };
});

app.post("/api/diary/write", async (request) => {
  const body = requireObject(request.body);
  const day = String(body.day ?? "") || yesterdayKey(config);
  const ok = await writeDiary(diaryTargetForDay(config, day), { config, paths: p, memory, persona, emit, onChange });
  return { ok };
});

app.get("/api/timeline", async (request) => {
  const query = request.query as { day?: string };
  const day = query.day && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : logicalDayKey(config, Date.now());
  return { day, events: readTimelineForDisplay(p, config, day), heading: `${day} · ${weekdayCN(day)}` };
});

app.get("/api/reminders", async () => ({ reminders: loadReminders(p).filter((r) => r.status === "pending") }));

app.post("/api/reminders", async (request, reply) => {
  const body = requireObject(request.body);
  const text = String(body.text ?? "").trim();
  const due = String(body.due ?? "").trim();
  if (!text || !due) return reply.code(400).send({ error: "要写提醒内容和时间。" });
  const dueAt = parseDue(due, config);
  if (!dueAt) return reply.code(400).send({ error: "没看懂这个时间，试试「明天 09:00」。" });
  const reminder = addReminder(p, config, {
    text,
    dueAt,
    kind: body.kind === "care" ? "care" : "owner",
  });
  onChange();
  return { ok: true, reminder };
});

app.post("/api/reminders/:id/done", async (request) => {
  const id = String((request.params as { id?: string }).id ?? "");
  const reminder = markReminderDone(p, id);
  onChange();
  return { ok: Boolean(reminder) };
});

app.delete("/api/reminders/:id", async (request) => {
  const id = String((request.params as { id?: string }).id ?? "");
  const ok = cancelReminder(p, id);
  onChange();
  return { ok };
});

// ---------- avatar ----------

app.get("/api/avatar/info", async () => avatarInfo(p));

app.get("/api/avatar", async (_request, reply) => {
  const avatar = avatarFile(p);
  if (!avatar) return reply.code(404).send({ error: "还没有自定义头像。" });
  return reply
    .header("cache-control", "no-store")
    .type(avatar.mime)
    .send(fs.readFileSync(avatar.file));
});

app.post("/api/avatar", async (request, reply) => {
  const body = requireObject(request.body);
  const dataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
  if (!dataUrl) return reply.code(400).send({ error: "没有收到图片。" });
  try {
    const avatar = saveAvatar(p, dataUrl);
    return { ok: true, avatar };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "头像保存失败。" });
  }
});

app.delete("/api/avatar", async () => ({ ok: true, avatar: clearAvatar(p) }));

// ---------- relationship, usage, stickers, debug ----------

app.get("/api/relationship", async () => {
  const snapshot = currentStatus();
  return {
    relationship: snapshot.relationship,
    daysKnown: snapshot.relationship.daysKnown ?? 1,
    description: relationshipDescription(snapshot.relationship, config.ownerTitle),
    growth: relationshipGrowth(snapshot.relationship),
  };
});

// 老数据补录成长记号；按文案去重，重复调用不会长出新条目。
app.post("/api/relationship/backfill", async () => {
  const result = backfillMilestones(p, config);
  onChange();
  return { ok: true, added: result.added, relationship: result.relationship };
});

app.get("/api/usage", async () => ({
  today: todayUsage(p, config),
  policy: costPolicy(config, todayUsage(p, config)),
  pricing: peakInfo(config, Date.now()),
  prices: MODEL_PRICES,
}));

app.get("/api/stickers", async () => ({ stickers: listStickers(p) }));

app.get("/api/own", async () => {
  const state = loadOwn(p);
  return {
    ...ownStateSnapshot(state, config, Date.now()),
    state,
    log: readOwnLog(p, config),
    notes: readText(`${p.web}/notes.md`, "（还没有笔记。）"),
  };
});

app.post("/api/own/seen", async () => {
  const state = loadOwn(p);
  markOwnSeen(state);
  saveOwn(p, state);
  onChange();
  return { ok: true };
});

app.get("/api/own/log", async (request, reply) => {
  const query = request.query as { day?: string };
  const raw = String(query.day ?? "").trim();
  const day = raw || logicalDayKey(config, Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return reply.code(400).send({ error: "日期格式不对。" });
  }
  return { day, content: readOwnLog(p, config, day) };
});

app.get("/api/debug", async () => {
  const life = loadLife(p);
  const now = Date.now();
  return {
    version: APP_VERSION,
    status: currentStatus(),
    life,
    own: loadOwn(p),
    deferred: loadDeferred(p),
    schedule: getSchedule(config, now, life),
    diarySlot: diarySlotSnapshot(life),
    memory: {
      inboxCount: listFiles(p.memoryInbox, ".md").length,
      lastConsolidate: life.lastConsolidate || null,
      lastError: readConsolidateState(p),
    },
    usage: todayUsage(p, config),
    timeline: (() => {
      const range = logicalDayRange(config, logicalDayKey(config, now));
      return readTimelineBetween(p, config, range.start, Math.min(now, range.end)).slice(-20);
    })(),
    lastTurn: agent.getDebug(),
    lastLlmError: getLastLLMFailure(),
    provider: providerSnapshot(),
    config: maskConfig(config),
  };
});

app.post("/api/debug/consolidate", async () => {
  if (agent.busy) return { ok: false, code: "busy", detail: "她正在说话，稍后再整理。" };
  const life = loadLife(p);
  if (!life.lastDiary) {
    return { ok: false, code: "no-diary", detail: "还没有日记可整理。" };
  }
  return consolidateMemory(life.lastDiary, { config, paths: p, memory, emit, onChange });
});

// ---------- settings ----------

app.post("/api/test-model", async (request) => {
  const body = requireObject(request.body);
  const patch = body.config && typeof body.config === "object" ? (body.config as Partial<AppConfig>) : {};
  const cfg = deepMerge<AppConfig>(config, patch);
  if (patch.model?.apiKey && patch.model.apiKey.includes("•")) cfg.model.apiKey = config.model.apiKey;
  if (!cfg.model.apiKey.trim()) return { ok: false, error: "还没有填 API Key。" };
  try {
    const result = await callLLM(cfg, [{ role: "user", content: "只回两个字：在的" }], {
      maxTokens: 20,
      temperature: 0,
      model: cfg.model.model,
      force: true,
      recordHealth: false,
      attempts: SIDE_ATTEMPTS,
      timeoutMs: SIDE_TIMEOUT_MS,
    });
    resetProviderHealth();
    return { ok: true, text: result.content, model: result.model, provider: providerSnapshot() };
  } catch (error) {
    const failure = error instanceof LLMError ? error : null;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "连接失败。",
      kind: failure?.kind,
      code: failure?.code,
      provider: providerSnapshot(),
    };
  }
});

app.get("/api/settings", async () => {
  const life = loadLife(p);
  const now = Date.now();
  const schedule = getSchedule(config, now, life);
  const quietNow = isQuietHours(config, now);
  const ownState = loadOwn(p);
  const own = ownStateSnapshot(ownState, config, now);
  const target = diaryTarget(config, life, now);
  let quietStartAt: number;
  let quietEndAt: number;
  if (config.speak.quietMode === "manual") {
    quietStartAt = nextClockTs(now, config.speak.quietStart, config.behavior.timezone);
    quietEndAt = nextClockTs(now, config.speak.quietEnd, config.behavior.timezone);
  } else if (schedule.phase === "asleep") {
    // 睡着时 schedule.sleepAt 是“下一晚”，安静要从刚刚过去的睡点算。
    quietStartAt = lastSleepAtBefore(config, schedule, now) - 30 * 60_000;
    quietEndAt = schedule.wakeAt;
  } else {
    quietStartAt = schedule.sleepAt - 30 * 60_000;
    quietEndAt = nextWakeAt(config, schedule.sleepAt);
  }
  return {
  config: maskConfig(config),
  root,
  schedulePreview: {
    wakeAt: schedule.wakeAt,
    sleepAt: schedule.sleepAt,
    awakeMin: Math.round(schedule.awakeMs / 60_000),
    phase: schedule.phase,
    nextChangeAt: schedule.nextChangeAt,
    quietNow,
    quietStartAt,
    quietEndAt,
    own: { nextAt: own.nextAt, windowEnd: own.windowEnd, active: own.active },
    diary: { targetDay: life.diarySlotDay || (target ? target.day : null), slotAt: life.diarySlotAt },
    pendingCatchUp: Boolean(ownState.pendingCatchUp),
    issues: validateLifeConfig(config),
    notice: config.life.clampNotice,
  },
  pricing: peakInfo(config, Date.now()),
  prices: MODEL_PRICES,
  modelOptions: [
    { value: "deepseek-flash", label: "DeepSeek Flash（便宜、快）" },
    { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro（更聪明、贵）" },
  ],
  };
});

app.put("/api/settings", async (request, reply) => {
  const body = requireObject(request.body);
  const patch = requireObject(body.config ?? body) as Partial<AppConfig>;
  const safe = structuredClone(patch);
  if (safe.model?.apiKey && safe.model.apiKey.includes("•")) safe.model.apiKey = config.model.apiKey;

  const oldPort = config.ui.port;
  const next = deepMerge<AppConfig>(config, safe);
  const issues = validateLifeConfig(next);
  if (issues.length) {
    return reply
      .code(400)
      .send({ error: "作息时间对不上：清醒时长需要在 6–20 小时之间。", field: issues[0].field, issues });
  }
  const nextName = next.name.trim();
  if (!nextName) {
    return reply.code(400).send({ error: "先给她起个名字，再保存设置。" });
  }
  if (config.setupPending && next.setupPending && nextName === config.name) {
    return reply.code(400).send({ error: "先给她起个名字，再保存设置。" });
  }
  next.name = nextName;
  next.setupPending = false;
  if (!next.ownerTitle.trim()) next.ownerTitle = config.ownerTitle;
  if (!next.model.baseUrl.trim()) next.model.baseUrl = config.model.baseUrl;
  if (!next.model.model.trim()) next.model.model = config.model.model;
  if (!next.model.sideModel.trim()) next.model.sideModel = next.model.model;
  next.model.temperature = Math.max(0, Math.min(2, Number(next.model.temperature) || 1));
  next.cost.dailyBudgetCny = Math.max(0, Number(next.cost.dailyBudgetCny) || 0);
  next.cost.peakPolicy = Boolean(next.cost.peakPolicy);
  next.cost.peakWindows = normalizePeakWindows(next.cost.peakWindows);
  next.behavior.historyMessages = Math.max(4, Math.min(100, Number(next.behavior.historyMessages) || 40));
  next.behavior.historyPeakMessages = Math.max(4, Math.min(100, Number(next.behavior.historyPeakMessages) || 16));
  next.behavior.maxOutputTokens = Math.max(100, Math.min(4000, Number(next.behavior.maxOutputTokens) || 800));
  next.behavior.maxOutputTokensPeak = Math.max(80, Math.min(2000, Number(next.behavior.maxOutputTokensPeak) || 320));
  next.speak.chance = Math.max(0, Math.min(1, Number(next.speak.chance) || 0.3));
  next.mood.base = Math.max(0, Math.min(100, Number(next.mood.base) || 65));
  next.web.enabled = Boolean(next.web.enabled);
  next.web.ownTimeEnabled = Boolean(next.web.ownTimeEnabled);
  next.ui.notificationsEnabled = Boolean(next.ui.notificationsEnabled);
  if (!Array.isArray(next.web.rssFeeds)) next.web.rssFeeds = [];
  next.web.rssFeeds = next.web.rssFeeds.filter((item): item is string => typeof item === "string" && item.startsWith("http"));

  // 关掉自己的时间、换时区或换逻辑日起点后，旧的补跑窗口已经没有意义了。
  // 预算/Key/模型变更不清：用户可能正是为了让补跑能跑才改的。
  const scheduleChanged = (["sleepMin", "wakeMin", "weekendSleepMin", "weekendWakeMin"] as const).some(
    (key) => config.life[key] !== next.life[key],
  );
  const scheduleRelevantChanged =
    scheduleChanged ||
    config.behavior.timezone !== next.behavior.timezone ||
    config.behavior.rotateHour !== next.behavior.rotateHour;
  const catchUpInvalid =
    (config.web.ownTimeEnabled && !next.web.ownTimeEnabled) ||
    config.behavior.timezone !== next.behavior.timezone ||
    config.behavior.rotateHour !== next.behavior.rotateHour ||
    scheduleChanged;
  if (catchUpInvalid) {
    const own = loadOwn(p);
    if (own.pendingCatchUp) {
      own.pendingCatchUp = null;
      saveOwn(p, own);
    }
  }
  const now = Date.now();
  if (scheduleRelevantChanged || next.life.diaryEnabled === false) {
    const life = loadLife(p);
    life.diarySlotAt = 0;
    life.diarySlotDay = "";
    life.diarySlotEndAt = 0;
    if (scheduleRelevantChanged) life.scheduleChangedAt = now;
    saveLife(p, life);
  }

  // 保存成功即视为用户在设置页确认了被自动修正的提示。
  next.life.clampNotice = undefined;
  next.life.clampNoticeAt = undefined;
  saveConfig(p, next);
  config = next;
  memory.setConfig(config);
  resetProviderHealth();
  agent.clearLastChatError();
  if (scheduleRelevantChanged) {
    const schedule = getSchedule(config, now, loadLife(p));
    reconcileOwnAfterScheduleChange(p, config, now, schedule);
  }
  refreshContext();
  onChange();
  return { ok: true, config: maskConfig(config), note: next.ui.port !== oldPort ? "端口改动需要重启服务。" : undefined };
});

// ---------- errors & static web ----------

app.setErrorHandler((error, _request, reply) => {
  const err = error as { statusCode?: number; message?: string };
  app.log.error(error);
  reply.code(err.statusCode ?? 500).send({ error: err.message || "服务端出了点问题。" });
});

await app.register(fastifyStatic, {
  root: p.media,
  prefix: "/media/",
  decorateReply: false,
  index: false,
});

await app.register(fastifyStatic, {
  root: p.stickers,
  prefix: "/stickers/",
  decorateReply: false,
  index: false,
});

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, "../web/dist");
if (exists(path.join(staticRoot, "index.html"))) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.type("text/html").send(fs.readFileSync(path.join(staticRoot, "index.html"), "utf8"));
    }
    return reply.code(404).send({ error: "没有这个页面。" });
  });
} else {
  app.get("/", async () => ({
    ok: true,
    message: "DeepHome API 在跑。Web UI 还没构建：开发时用 npm run dev，或先 npm run build:web。",
    root,
  }));
}

const port = Number(process.env.DEEPHOME_PORT ?? process.env.CHATBRIDGE_PORT) || Number(config.ui.port) || 7788;
try {
  await app.listen({ host: "127.0.0.1", port });
  scheduler.start();
  console.log(`\n  DeepHome · ${config.name.trim() || "某鱼"} 的房间`);
  console.log(`  http://127.0.0.1:${port}`);
  console.log(`  数据：${root}\n`);
} catch (error) {
  console.error("DeepHome 启动失败：", error);
  process.exit(1);
}

async function shutdown(): Promise<void> {
  scheduler.stop();
  agent.stop();
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
