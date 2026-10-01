// 巡检核心（改进方案 C8/#7）：供 `node src/ops.js health-check` 调用，也被
// qq-agent-health.timer 每 5 分钟触发。只读检查 + data/health.json 里的失败连击计数，
// 连续 3 次失败才通过 notify 通知 owner（抑制抖动），恢复时补发一次"已恢复"。
// fetchImpl / statfs 可注入：测试不打真实网络。
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './sqlite.js';

const OUTBOUND_STALE_MS = 6 * 60 * 60 * 1000;   // 出站水位：6 小时没有任何自己发的消息＝可疑
const DISK_MIN_BYTES = 1024 * 1024 * 1024;       // 磁盘余量：< 1GB 报警
const NOTIFY_AFTER_STREAK = 3;                   // 连续失败到第 3 次才通知

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
 *   dataDir / mode(observe|active) / consolePort / consoleToken / onebotHttpPort / onebotToken
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
    statfs = null,
    now = Date.now(),
  } = opts;

  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // ① 控制台 /healthz
  try {
    const res = await fetchImpl(`http://127.0.0.1:${consolePort}/healthz`);
    add('console-healthz', res.ok, `HTTP ${res.status}`);
  } catch (error) {
    add('console-healthz', false, error?.message ?? String(error));
  }

  // ② OneBot get_status
  try {
    const headers = { 'content-type': 'application/json' };
    if (onebotToken) headers.authorization = `Bearer ${onebotToken}`;
    const res = await fetchImpl(`http://127.0.0.1:${onebotHttpPort}/get_status`, { method: 'POST', headers, body: '{}' });
    const data = await res.json().catch(() => ({}));
    add('onebot-status', res.ok && data?.status === 'ok', res.ok ? `retcode=${data?.retcode ?? '?'}` : `HTTP ${res.status}`);
  } catch (error) {
    add('onebot-status', false, error?.message ?? String(error));
  }

  // ③ 出站消息水位：observe 模式本来就不发消息，跳过（否则每 5 分钟固定误报"收发停止"）
  if (mode === 'observe') {
    add('outbound-freshness', true, '跳过（observe 模式不发消息）');
  } else {
    try {
      const db = openDatabase(path.join(dataDir, 'messages.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT max(ts) AS m FROM messages WHERE self=1').get();
        if (!row || row.m === null) {
          add('outbound-freshness', true, '跳过（还没有出站消息记录）');
        } else {
          const age = now - Number(row.m);
          add('outbound-freshness', age <= outboundStaleMs, `最近一次出站距今 ${Math.round(age / 60000)} 分钟`);
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
