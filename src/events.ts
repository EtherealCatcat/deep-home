import type { ChatMessage, MoodState, Relationship, RoomState, TimelineEvent, UsageDay } from "./types.js";
import type { CostPolicy } from "./pricing.js";
import type { Phase } from "./rhythm.js";
import type { ChatError, ProviderSnapshot } from "./provider.js";

export interface StatusSnapshot {
  name: string;
  ownerTitle: string;
  setupRequired: boolean;
  busy: boolean;
  burst: boolean;
  burstCount: number;
  unread: number;
  serverTime: number;
  mood: MoodState;
  moodLabel: string;
  rhythm: {
    phase: Phase;
    label: string;
    status: string;
    sleepAt: number;
    wakeAt: number;
    nextChangeAt: number;
    woken: boolean;
    day: string;
    dayType: string;
  };
  room: RoomState;
  relationship: Relationship;
  pricing: CostPolicy;
  usage: UsageDay;
  todayMessages: number;
  proactiveToday: number;
  lastOwnerAt: number;
  lastMessageAt: number;
  activity: string;
  provider: ProviderSnapshot;
  lastChatError?: ChatError;
  own: {
    enabled: boolean;
    active: boolean;
    nextAt: number;
    windowEnd: number;
    label: string;
    lastResult: string;
    unread: number;
  };
}

export type ServerEvent =
  | { type: "status"; status: StatusSnapshot }
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; on: boolean }
  | { type: "read"; at: number }
  | { type: "mood"; mood: MoodState }
  | { type: "timeline"; event: TimelineEvent }
  | { type: "busy"; busy: boolean }
  | { type: "error"; message: string; kind?: string; retryable?: boolean; at?: number }
  | { type: "done"; turnId: string }
  | { type: "diary"; day: string }
  | { type: "burst_cancel"; from: number };
