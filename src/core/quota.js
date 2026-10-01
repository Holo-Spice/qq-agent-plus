// 配额双闸（改进方案 #9，施工图见方案附录 J.6.3）：同一动作同时受"每会话"与"全局"两个滑动窗口限制。
// 用途：ASR 转写、贴纸收藏、提醒容量 —— 既防"一个群刷爆全局额度"，也防"全局被刷满后别人全不能用"。
//
// 语义约定：
// - tryConsume 记录一次；peek 只查不记（调用方想"先判闸、成功后才扣"时用它）；
// - 限值非有限 / ≤0 → 视为不设限（Infinity）——与 #8 预算"0 不当封锁"同口径；
// - 窗口滑动：只保留 windowMs 内的时间戳（惰性裁剪，无定时器）；
// - retryAfterMs：最早那次记录滑出窗口还需多久（估算值，用于文案"稍后再试"）。
export function createQuota({ windowMs = 3600_000, globalMax = Infinity, perChatMax = Infinity } = {}) {
  const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : 3600_000;
  const normMax = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
  };
  let gmax = normMax(globalMax);
  let cmax = normMax(perChatMax);
  let globalTimes = [];
  const chatTimes = new Map();

  function prune(now) {
    if (globalTimes.length && now - globalTimes[0] >= win) {
      globalTimes = globalTimes.filter((t) => now - t < win);
    }
    for (const [key, list] of chatTimes) {
      if (list.length && now - list[0] >= win) {
        const kept = list.filter((t) => now - t < win);
        if (kept.length) chatTimes.set(key, kept);
        else chatTimes.delete(key);
      }
    }
  }

  const retryAfter = (list, now) => (list.length ? Math.max(0, win - (now - list[0])) : 0);

  function check(chatKey, now) {
    prune(now);
    const key = String(chatKey ?? '');
    const list = chatTimes.get(key) || [];
    if (list.length >= cmax) return { ok: false, scope: 'chat', retryAfterMs: retryAfter(list, now), list, key };
    if (globalTimes.length >= gmax) return { ok: false, scope: 'global', retryAfterMs: retryAfter(globalTimes, now), list, key };
    return { ok: true, scope: '', retryAfterMs: 0, list, key };
  }

  /** 只查不记：返回 { ok, scope, retryAfterMs }。 */
  function peek(chatKey = '', now = Date.now()) {
    const r = check(chatKey, now);
    return { ok: r.ok, scope: r.scope, retryAfterMs: r.retryAfterMs };
  }

  /** 记录一次；超限则返回 { ok:false, scope, retryAfterMs } 且不记录。 */
  function tryConsume(chatKey = '', now = Date.now()) {
    const r = check(chatKey, now);
    if (!r.ok) return { ok: false, scope: r.scope, retryAfterMs: r.retryAfterMs };
    r.list.push(now);
    chatTimes.set(r.key, r.list);
    globalTimes.push(now);
    return { ok: true, scope: '', retryAfterMs: 0 };
  }

  function snapshot(now = Date.now()) {
    prune(now);
    const chats = {};
    for (const [key, list] of chatTimes) chats[key] = list.length;
    return { windowMs: win, globalMax: gmax, perChatMax: cmax, globalUsed: globalTimes.length, chats };
  }

  function reset() {
    globalTimes = [];
    chatTimes.clear();
  }

  /** 运行期改限值（配置可能被改；0/非法仍按不设限处理）。 */
  function configure({ globalMax: g, perChatMax: c } = {}) {
    if (g !== undefined) gmax = normMax(g);
    if (c !== undefined) cmax = normMax(c);
  }

  return { tryConsume, peek, snapshot, reset, configure };
}
