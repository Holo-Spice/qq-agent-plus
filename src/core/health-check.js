// 巡检核心（改进方案 C8/#7）：供 `node src/ops.js health-check` 调用，也被
// qq-agent-health.timer 每 5 分钟触发。只读检查 + data/health.json 里的失败连击计数，
// 连续 3 次失败才通过 notify 通知 owner（抑制抖动），恢复时补发一次"已恢复"。
// fetchImpl / statfs 可注入：测试不打真实网络。
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './sqlite.js';

const OUTBOUND_STALE_MS = 6 * 60 * 60 * 1000;   // 出站水位：6 小时没有任何自己发的消息＝可疑
const STUCK_INBOUND_MS = 30 * 60 * 1000;        // 入站到期未处理的宽限：一轮会话运行只要几分钟，
                                                // 到期 30 分钟还停在 pending 就是管道死了
const DISK_MIN_BYTES = 1024 * 1024 * 1024;       // 磁盘余量：< 1GB 报警
const NOTIFY_AFTER_STREAK = 3;                   // 连续失败到第 3 次才通知
// 两个本机探测必须带超时（2026-10-01 审查）：原来一次 fetch 用 undici 的默认上限（约 5 分钟），
// 控制台半死不活（接受连接但不响应）时，一轮巡检会被它拖住整个超时窗口 ——
// 而 qq-agent-health.timer 是 5 分钟一次，等于巡检自己叠在一起排不上。
const FETCH_TIMEOUT_MS = 10 * 1000;

function loadState(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'health.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : { streaks: {} };
  } catch {
    return { streaks: {} };
  }
}

function saveState(dataDir, state) {
  const file = path.join(dataDir, 'health.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 跑一轮巡检。
 * @param {object} opts
 *   dataDir / mode(observe|active) / consolePort / onebotHttpPort / onebotToken
 *   notify: async (text) => void|null   通知通道（ops.js 里接 core/notify-owner）
 *   fetchImpl / statfs                  注入点（测试）
 * @returns {{ healthy: boolean, checks: Array, notified: string[], code: number }}
 */
export async function runHealthCheck(opts = {}) {
  const {
    dataDir,
    mode = 'active',
    consolePort = 3210,
    onebotHttpPort = 3390,
    onebotToken = '',
    outboundStaleMs = OUTBOUND_STALE_MS,
    notify = null,
    fetchImpl = globalThis.fetch,
    fetchTimeoutMs = FETCH_TIMEOUT_MS,
    statfs = null,
    now = Date.now(),
  } = opts;

  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  // AbortSignal.timeout 覆盖整次请求（含读 body）：挂死的服务在 fetchTimeoutMs 内必被中止，
  // 巡检不会为它多等一个 undici 默认超时。
  const probeSignal = () => AbortSignal.timeout(fetchTimeoutMs);

  // ① 控制台 /healthz
  try {
    const res = await fetchImpl(`http://127.0.0.1:${consolePort}/healthz`, { signal: probeSignal() });
    add('console-healthz', res.ok, `HTTP ${res.status}`);
  } catch (error) {
    add('console-healthz', false, error?.message ?? String(error));
  }

  // ② OneBot get_status
  try {
    const headers = { 'content-type': 'application/json' };
    if (onebotToken) headers.authorization = `Bearer ${onebotToken}`;
    const res = await fetchImpl(`http://127.0.0.1:${onebotHttpPort}/get_status`, { method: 'POST', headers, body: '{}', signal: probeSignal() });
    const data = await res.json().catch(() => ({}));
    add('onebot-status', res.ok && data?.status === 'ok', res.ok ? `retcode=${data?.retcode ?? '?'}` : `HTTP ${res.status}`);
  } catch (error) {
    add('onebot-status', false, error?.message ?? String(error));
  }

  // ③ 入站处理水位：判据是"**到期的入站消息有没有被处理**"，而不是"入站新 → 出站必须新"，
  //    也不是"bot 一直没说话"。
  // - observe 模式本来就不发消息 → 跳过（否则每 5 分钟固定误报）。
  // - 窗口内没有入站消息（深夜/冷清时段）→ 静默期，出站为空是正常行为 → 记 ok。
  //   2026-10-01 实测踩到：凌晨 00:13 部署后群里没人说话，出站水位在 05:40 越过 6 小时，
  //   连击到 3 次就私聊 owner 报"收发停止" —— 纯误报，判据本身把静默期排除掉。
  // - 2026-10-02 08:15 第二种误报：入站很新，但编排器按响应概率**决定不回**（日志：
  //   「未命中触发条件（概率 60%，未触发），已标记已读、不响应」），旧判据"入站新 → 出站必须新"
  //   把这种合法沉默当成收发停止，又弹了一次告警。实际上对每条入站消息，编排器要么发起回复、
  //   要么决定不回并标记已读（state='acked'），补课窗口外的入库时更是直接 acked —— 两者都算
  //   "处理过"。time-gate 的 held（故意延迟）和发送失败重试的 backoff（available_at 在未来）
  //   也都不是卡住。所以真正的故障信号只剩一个：**有消息到期了却一直停在 pending**——管道死掉
  //   才会出现这种堆积（STUCK_INBOUND_MS 宽限覆盖一轮正常运行与一次退避重试）。
  if (mode === 'observe') {
    add('outbound-freshness', true, '跳过（observe 模式不发消息）');
  } else {
    try {
      const db = openDatabase(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
      try {
        const out = db.prepare('SELECT max(ts) AS m FROM messages WHERE self=1').get();
        const inbound = db.prepare('SELECT max(ts) AS m FROM messages WHERE self=0').get();
        const outAge = out === undefined || out.m === null ? null : now - Number(out.m);
        const inAge = inbound === undefined || inbound.m === null ? null : now - Number(inbound.m);
        if (outAge === null) {
          add('outbound-freshness', true, '跳过（还没有出站消息记录）');
        } else if (inAge === null) {
          add('outbound-freshness', true, '静默期：还没有入站消息记录（没有人在说话，出站为空属正常）');
        } else if (inAge > outboundStaleMs) {
          add('outbound-freshness', true, `静默期：最近一次入站距今 ${Math.round(inAge / 60000)} 分钟（超过 ${Math.round(outboundStaleMs / 60000)} 分钟没人说话，出站为空属正常）`);
        } else {
          // 卡住的判据：self=0、仍停在 pending、**已到期**（max(ts, available_at) 已过宽限线
          // —— available_at 在未来的是显式排期/退避重试，不是卡住）、且落在观察窗口内
          // （窗口外的历史遗留 pending 不追打）。held 不在 pending 里，天然不算。
          const stuck = db.prepare(
            "SELECT count(*) AS c, min(ts) AS oldest FROM messages" +
            " WHERE self=0 AND state='pending' AND max(ts, available_at) <= ? AND ts > ?"
          ).get(now - STUCK_INBOUND_MS, now - outboundStaleMs);
          if (stuck.c > 0) {
            add('outbound-freshness', false,
              `有 ${stuck.c} 条入站消息到期超过 ${Math.round(STUCK_INBOUND_MS / 60000)} 分钟未被处理` +
              `（最早一条距今 ${Math.round((now - Number(stuck.oldest)) / 60000)} 分钟）—— 收发链路可能停滞`);
          } else if (inAge < STUCK_INBOUND_MS) {
            add('outbound-freshness', true,
              `最近入站处理中（${Math.round(inAge / 60000)} 分钟前收到；出站距今 ${Math.round(outAge / 60000)} 分钟）`);
          } else {
            add('outbound-freshness', true,
              `最近入站均已处理（最后一条距今 ${Math.round(inAge / 60000)} 分钟；出站距今 ${Math.round(outAge / 60000)} 分钟）`);
          }
        }
      } finally { db.close(); }
    } catch (error) {
      add('outbound-freshness', false, `出站水位读不了: ${error?.message ?? error}`);
    }
  }

  // ④ 磁盘余量
  try {
    const st = typeof statfs === 'function' ? statfs(dataDir) : fs.statfsSync(dataDir);
    const avail = Number(st.bavail) * Number(st.bsize);
    add('disk-space', avail >= DISK_MIN_BYTES, `可用 ${(avail / 1024 / 1024 / 1024).toFixed(2)} GB`);
  } catch (error) {
    add('disk-space', false, `磁盘余量读不了: ${error?.message ?? error}`);
  }

  // ⑤ 自动更新状态
  try {
    const upd = JSON.parse(fs.readFileSync(path.join(dataDir, 'auto-update.json'), 'utf8'));
    add('auto-update', upd?.status !== 'failed', upd?.status === 'failed' ? `status=failed（${String(upd?.error || '').slice(0, 120)}）` : `status=${upd?.status ?? 'unknown'}`);
  } catch {
    add('auto-update', true, '跳过（无 auto-update.json）');
  }

  // ⑥ 部署中断标记（36c649a 加固项）：存在＝上次部署被 SIGKILL/OOM 打断且未收尾
  const marker = path.join(dataDir, '.deploy-in-progress');
  add('deploy-interrupted', !fs.existsSync(marker), fs.existsSync(marker) ? '存在中断标记，按 docs/LINUX.md「部署被中断后怎么恢复」处理' : '');

  // ⑦ messages 库完整性（适配层只读打开）
  try {
    const db = openDatabase(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get();
      add('sqlite-integrity', row?.integrity_check === 'ok', row?.integrity_check ?? '');
    } finally { db.close(); }
  } catch (error) {
    add('sqlite-integrity', false, error?.message ?? String(error));
  }

  const healthy = checks.every((c) => c.ok);

  // ── 抑制与通知：按类别计连击；连续 NOTIFY_AFTER_STREAK 次失败才通知，恢复补发一次 ──
  const state = loadState(dataDir);
  state.streaks = state.streaks || {};
  state.lastRunAt = now;
  state.healthy = healthy;
  state.lastResults = checks;
  const notified = [];
  if (typeof notify === 'function') {
    for (const c of checks) {
      const prev = state.streaks[c.name] || { count: 0 };
      if (!c.ok) {
        const count = prev.count + 1;
        // 保留上一轮的送达痕迹：整体重写会把 lastNotifiedAt/notifyError 抹掉，
        // 于是"这轮到底发出去没有"再也查不到（2026-09-30 审查 P1）。
        const next = { count, lastDetail: c.detail };
        // 用 != null 而不是真值判断：注入的 now 允许为 0（测试造时间），
        // 真值判断会把已送达的 0 当成"没送过"从而每轮重发（2026-09-30 复审）。
        if (prev.lastNotifiedAt != null) next.lastNotifiedAt = prev.lastNotifiedAt;
        if (prev.notifyError) next.notifyError = prev.notifyError;
        state.streaks[c.name] = next;
        // 到达阈值后**每轮都重试直到送达成功**：告警通道正是 OneBot HTTP，
        // 最需要告警的故障场景下最容易发不出去；原来只在 count===3 那一次尝试，
        // 一次瞬时失败就等于整段故障期静默（2026-09-30 审查 P1）。
        if (count >= NOTIFY_AFTER_STREAK && next.lastNotifiedAt == null) {
          const sent = await tryNotify(notify, `【QQ Agent 健康告警】${c.name} 连续 ${count} 次检查失败：${c.detail || '无详情'}（每 5 分钟巡检一次，恢复后会通知）`);
          if (sent.ok) {
            state.streaks[c.name].lastNotifiedAt = now;
            delete state.streaks[c.name].notifyError;
            notified.push(`告警:${c.name}`);
          } else {
            state.streaks[c.name].notifyError = sent.detail;
          }
        }
      } else if (prev.count >= NOTIFY_AFTER_STREAK) {
        // 恢复通知同样看结果：发失败了照常清零连击（已经恢复是事实），但记下失败痕迹 ——
        // 成功后要把痕迹清掉，否则留一条"上次恢复没发出去"的陈旧诊断（2026-09-30 复审）。
        const sent = await tryNotify(notify, `【QQ Agent 健康恢复】${c.name} 已恢复正常`);
        if (sent.ok) {
          notified.push(`恢复:${c.name}`);
          delete state.recoveryNotifyError;
        } else {
          state.recoveryNotifyError = sent.detail;
        }
        state.streaks[c.name] = { count: 0 };
      } else if (prev.count) {
        state.streaks[c.name] = { count: 0 };
      }
    }
  }
  try { saveState(dataDir, state); } catch { /* health.json 写失败不影响巡检结论 */ }

  return { healthy, checks, notified, code: healthy ? 0 : 1 };
}

/**
 * 调用注入的通知器并归一化结果。
 * 生产注入的是 notify-owner 的 sendOwnerText：它**失败时返回 { ok:false, detail } 而不抛**，
 * 所以只 try/catch 会把"没发出去"当成"已送达"。两种失败都要认（2026-09-30 审查 P1）。
 * 返回 undefined（旧测试里的式样 `async (text) => { notes.push(text) }`）按成功处理。
 */
async function tryNotify(notify, text) {
  try {
    const r = await notify(text);
    if (r && typeof r === 'object' && r.ok === false) {
      return { ok: false, detail: String(r.detail || r.error || '通知发送失败') };
    }
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}
