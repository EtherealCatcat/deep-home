import type { AppConfig, LifeState } from "./types.js";
import { getSchedule, isQuietHours, type Schedule } from "./schedule.js";

export type { Phase } from "./schedule.js";
export { isQuietHours } from "./schedule.js";

export interface Rhythm extends Schedule {
  label: string;
  status: string;
}

/** 兼容旧调用：节奏就是日程的展示层。 */
export function getRhythm(config: AppConfig, life: LifeState, now = Date.now()): Rhythm {
  const schedule = getSchedule(config, now, life);
  const label =
    schedule.phase === "asleep"
      ? "睡着中"
      : schedule.phase === "waking"
        ? "刚醒"
        : schedule.phase === "sleepy"
          ? "有点困"
          : "醒着";
  const status =
    schedule.phase === "asleep"
      ? schedule.woken
        ? "刚被消息吵醒，还埋在枕头里"
        : "睡着中，呼吸很轻"
      : schedule.phase === "waking"
        ? "刚醒，头发乱糟糟的"
        : schedule.phase === "sleepy"
          ? "困了，眼皮在打架"
          : "醒着，在自己的房间里";
  return { ...schedule, label, status };
}

export function rhythmPrompt(rhythm: Rhythm, config: AppConfig): string {
  if (rhythm.phase === "asleep") {
    if (config.life.whenAsleep === "morning") return "你正睡着。这条消息先不回复，等早上醒来再说。";
    if (config.life.whenAsleep === "sleepy") return "你正睡着，被这条消息吵醒了。脑子还糊着，可以回，但短一点、慢一点，带点起床气也可以。";
    return "你正睡着，被这条消息吵醒了。先回一句，别装清醒。";
  }
  if (rhythm.phase === "waking") return "你刚醒没多久，还没完全清醒。说话可以慢半拍，别太利索。";
  if (rhythm.phase === "sleepy") return "你有点困了，眼皮打架。回复会短一些，可能说着说着就想睡。";
  return "你醒着，状态正常。";
}

