// owner 私聊通知通道（改进方案 C8/#7）。
// 供 **独立进程**（ops.js health-check 定时器）使用：它没有主进程的 OneBot WS 连接，
// 只能走 OneBot HTTP API（127.0.0.1:3390）直发。主进程内的通知（auto-update / 异常告警）
// 仍走各自的 WS 通道，不经这里。
// ownerUin 的读取口径与 src/auto-update.js 的 autoUpdateOwner 保持一致（admin 一节存在时
// 是唯一真相，老字段仅做无 admin 一节时的回退）。这里有意不 import auto-update.js：
// 本模块会被 ops 定时器在任意环境加载，不背它的部署依赖。

export function readOwnerUin(config = {}) {
  const hasAdmin = Boolean(
    config.admin
    && typeof config.admin === 'object'
    && !Array.isArray(config.admin)
  );
  if (hasAdmin) return String(config.admin.ownerUin || '').trim();
  return String(
    config.autoUpdate?.ownerUin
    || config.incidentPilot?.ownerUin
    || config.identityPilot?.friendProposal?.ownerUin
    || ''
  ).trim();
}

/**
 * 给 owner 发一条 QQ 私聊。
 * @returns {{ ok: boolean, detail: string }} 失败时 detail 带原因（供 health-check 记录）。
 */
export async function sendOwnerText({ httpPort = 3390, token = '', ownerUin, text, fetchImpl = globalThis.fetch } = {}) {
  const owner = String(ownerUin || '').trim();
  if (!/^\d{5,15}$/.test(owner)) return { ok: false, detail: '未配置有效的全局管理员 QQ（admin.ownerUin）' };
  if (typeof fetchImpl !== 'function') return { ok: false, detail: '运行环境没有 fetch' };
  try {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`http://127.0.0.1:${httpPort}/send_private_msg`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: Number(owner), message: text })
    });
    if (!res.ok) return { ok: false, detail: `OneBot HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    if (data?.status && data.status !== 'ok') return { ok: false, detail: `OneBot retcode ${data.retcode ?? data.status}` };
    return { ok: true, detail: '' };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}
