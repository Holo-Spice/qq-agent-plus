// 「补课」回复窗口：重连/重启后从历史里补回的消息，窗口内的按新消息处理（进队列、唤醒模型），
// 更早的只补进历史（state=acked），避免停机一小时回来后把一小时前的对话全部回复一遍。
//
// 为什么单独成模块（Issue #22）：报告人指出"超窗消息被静默吞掉"——bot 在历史里看得到、
// 群里却像没收到。窗口现在是配置项，日志也要把"其中 N 条只补记录"写出来，
// 让这条设计从"看不见"变成"看得见"。这两个判断都不依赖任何运行时状态，所以直接单元测试。
export const DEFAULT_CATCHUP_REPLY_WINDOW_MS = 30 * 60 * 1000;
// 上限一天：再长就等于"什么都回"，那种需求应该显式关掉补课，而不是把窗口开到无限。
export const MAX_CATCHUP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 读配置里的补课窗口（毫秒）。非法值一律回落默认值（与配置里别的数值字段同一口径）。 */
export function catchupReplyWindowMs(cfg) {
  const raw = cfg?.onebot?.catchupReplyWindowMs;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CATCHUP_REPLY_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CATCHUP_REPLY_WINDOW_MS;
  return Math.min(value, MAX_CATCHUP_REPLY_WINDOW_MS);
}

/** 这条补回来的消息还算不算"新消息"（要回复）。窗口为 0 时一律不算。 */
export function isFreshForReply(messageTsMs, nowMs, windowMs) {
  return nowMs - messageTsMs <= windowMs;
}

/**
 * 补课日志行。added=0 返回空串（调用方据此决定不打日志）。
 * 有"只补记录"的条数时把两个数都写出来 —— 否则用户看到"补进 N 条"却等不到回复，
 * 只会以为 bot 坏了（Issue #22 的影响 2）。
 */
export function catchupLogLine(chatKey, added, recordedOnly) {
  if (!added) return '';
  const base = `[catchup] ${chatKey} 补进 ${added} 条（重启/断线期间漏掉的）`;
  if (!recordedOnly) return base;
  return recordedOnly >= added
    ? `${base} —— 全部超过回复窗口，只补记录、不回复`
    : `${base} —— 其中 ${recordedOnly} 条超过回复窗口，只补记录、不回复`;
}
