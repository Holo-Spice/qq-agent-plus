// 共享小件：触发来源与生命周期状态的标签/换算（由 ui/core/widgets.js 机械拆出，2026-10-01）。
// 它们被 pages/status.js、pages/sessions.js 与外挂 status-refresh.js 共用，且 core/state.js 也在用（调用期解析），
// 所以留在 core 层；原来的文件名 widgets 名不副实（里面混装了 chat/usage 的整块渲染），故改名。
// ⚠ 这不是 ADR 0004 否掉的那个 core/lifecycle.js：那批 18 个符号的闭包 329/379，这 5 个叶子只有
// 8/379（符合该 ADR 的"< 50 才成立"判据，见 docs/adr/0004 的 2026-10-01 补记）。**别再往这里加东西。**
// classic script：顶层声明仍处全局词法环境、跨脚本共享；只切不改。
function triggerKindOf(value) {
  if (typeof value === 'string') return value || 'unknown';
  if (value?.triggerKind) return value.triggerKind;
  const reason = String(value?.triggerReason || value?.contextReason || '');
  if (reason === '被艾特') return 'mention';
  if (reason === '关键词命中') return 'keyword';
  if (reason.startsWith('随机命中')) return 'probability';
  if (reason === '全部响应') return 'all';
  if (/生命周期：(?:活跃|监听)状态/.test(reason)) return 'lifecycle';
  if (/硬上限后的任意消息续接/.test(reason)) return 'rollover';
  if (/引用机器人/.test(reason)) return 'reply';
  if (reason === '私聊') return 'private';
  if (reason === '控制台主动唤醒') return 'manual';
  if (reason === '失败批次重试') return 'retry';
  return 'unknown';
}

function triggerKindLabel(value) {
  const kind = triggerKindOf(value);
  return TRIGGER_KIND_LABEL[kind] || TRIGGER_KIND_LABEL.unknown;
}

function lifecycleStateOf(s) {
  return s?.lifecycle?.state || s?.threadState || (s?.threadId ? 'closed' : 'starting');
}

function lifecycleRemainingText(deadline, lifecycleState) {
  if (lifecycleState === 'closed') return '已结束';
  if (lifecycleState === 'starting') return '建立中';
  if (!Number(deadline)) return '-';
  const remaining = Number(deadline) - Date.now();
  return remaining > 0 ? fmtRemainingMs(remaining) : '状态更新中';
}

function lifecycleRunsFor(s) {
  if (s?.conversationMode !== 'lifecycle' || !s?.threadId) return [];
  return (state.sessions || [])
    .filter((entry) =>
      entry.conversationMode === 'lifecycle'
      && entry.chatKey === s.chatKey
      && entry.threadId === s.threadId)
    .slice()
    .sort((a, b) => Number(a.startedAt) - Number(b.startedAt));
}
