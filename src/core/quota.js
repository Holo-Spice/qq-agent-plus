// 配额双闸（改进方案 #9，施工图见方案附录 J.6.3）：同一动作同时受"每会话"与"全局"两个滑动窗口限制。
// 用途：ASR 转写、贴纸收藏、提醒容量 —— 既防"一个群刷爆全局额度"，也防"全局被刷满后别人全不能用"。
//
// 语义约定：
// - tryConsume 记录一次；peek 只查不记（调用方想"先判闸、成功后才扣"时用它）；
//   **并发下要封顶就得用"事前 tryConsume + 失败 refund"**：peek→干活→consume 的组合里，
//   两个并发调用会双双通过 peek（2026-10-01 审查，生图配额就踩在这里）；
// - refund：撤掉指定时间戳那一次记录（与 tryConsume 配对用）；
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

  /**
   * 退一次量（tryConsume 的对偶）：把 `at` 那次记录撤掉。
   *
   * 用途是"事前原子消费 + 失败退还"：先 tryConsume 把额度**原子**占住（并发下才不会超限），
   * 真正干活失败时再退回来 —— 既有 peek 的"失败不扣"，又没有 peek 的竞态。
   * 只撤掉一条与 `at` 相等的记录（各列表里的时间戳可能相同，撤一条即可）。
   */
  function refund(chatKey = '', at = 0) {
    const ts = Number(at);
    if (!Number.isFinite(ts)) return false;
    const drop = (list) => {
      const index = list.indexOf(ts);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    };
    const key = String(chatKey ?? '');
    const list = chatTimes.get(key);
    let removed = false;
    if (list) {
      removed = drop(list) || removed;
      if (!list.length) chatTimes.delete(key);
    }
    removed = drop(globalTimes) || removed;
    return removed;
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

  return { tryConsume, peek, refund, snapshot, reset, configure };
}
