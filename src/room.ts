import type { Paths } from "./config.js";
import type { RoomState } from "./types.js";
import { readJson, writeJson } from "./store.js";

const DEFAULT_ROOM: RoomState = {
  name: "大肥鱼的家",
  status: "在书桌前发呆",
  detail: "台灯开着，鱼缸在冒泡，窗外没有海，但今晚有风。",
  updatedAt: 0,
};

const ACTIONS: Record<string, { status: string; detail: string }> = {
  看书: { status: "窝在床上看书", detail: "书摊在膝盖上，看到一半走神了。" },
  泡茶: { status: "在桌边泡茶", detail: "杯子冒着热气，茶叶还没完全舒展开。" },
  躺下: { status: "躺在床上", detail: "天花板上的光斑慢慢晃，像水。" },
  听歌: { status: "戴着耳机听歌", detail: "旧唱片转到第二面，有一点点杂音。" },
  发呆: { status: "在书桌前发呆", detail: "笔停在纸上，墨点晕开了一小圈。" },
  看鱼: { status: "蹲在鱼缸前看鱼", detail: "鱼缸里的小鱼绕着一块石头转。" },
  开窗: { status: "把窗开了一条缝", detail: "风把窗帘吹起来一点，带着晚上的凉气。" },
  关灯: { status: "把台灯关了", detail: "房间里只剩鱼缸的蓝光。" },
  收拾: { status: "在收拾房间", detail: "把桌上的纸叠好，又不知道该放哪儿。" },
  洗澡: { status: "刚洗完澡", detail: "头发还有点湿，毛巾搭在椅背上。" },
  吃饭: { status: "在吃东西", detail: "碗里还剩一半，筷子搁在边上。" },
  睡觉: { status: "钻进被窝", detail: "把被子拉到下巴，只露出一双眼睛。" },
};

export function loadRoom(p: Paths): RoomState {
  const room = readJson<RoomState>(p.state + "/room.json", DEFAULT_ROOM);
  if (!room.name) room.name = DEFAULT_ROOM.name;
  if (!room.status) room.status = DEFAULT_ROOM.status;
  if (!room.detail) room.detail = DEFAULT_ROOM.detail;
  return room;
}

export function saveRoom(p: Paths, room: RoomState): void {
  writeJson(p.state + "/room.json", room);
}

export function roomAction(p: Paths, action: string): RoomState {
  const clean = action.trim().slice(0, 24);
  const preset = ACTIONS[clean];
  const current = loadRoom(p);
  const next: RoomState = {
    ...current,
    status: preset?.status ?? `在${clean}`,
    detail: preset?.detail ?? current.detail,
    updatedAt: Date.now(),
  };
  saveRoom(p, next);
  return next;
}

export function roomLook(room: RoomState): string {
  return `${room.name}：${room.status}。${room.detail}`;
}

export function roomSnapshot(p: Paths): RoomState {
  return loadRoom(p);
}

/** 房间多久没变就算“没人待着”了。 */
export const ROOM_STALE_MS = 6 * 60 * 60_000;

export function roomIsStale(room: RoomState, now: number): boolean {
  if (!room.updatedAt) return true;
  return now - room.updatedAt >= ROOM_STALE_MS;
}

/**
 * 自己时间里做了什么，房间就跟着变成什么样。
 * 她显式调过 room_do 时不走这里。
 */
export function roomActionForOwnTime(toolNames: string[]): string {
  if (toolNames.includes("note_write")) return "收拾";
  if (toolNames.includes("web_read") || toolNames.includes("rss_read") || toolNames.includes("web_search")) {
    return "看书";
  }
  return "发呆";
}
