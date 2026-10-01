// 共享请求封装（改进方案 #1 A 档）：以 app.js 原实现为**唯一真源整体拷出**，逐字一致
// （含 401 时打开登录弹窗、隐藏 loading 壳）。替换 5 份重复副本：app.js 一份、
// global-memory / relationship-pilot / multimodal-context-pilot / tool-scheduler-pilot
// 各一份（它们只有 token 常量名不同 MARKER vs CONSOLE_MARKER，值同为 'qq-agent-console'；
// auto-update-network 的副本还少一层 401 处理 —— 收敛后统一获得该处理，属行为增强）。
//
// 依赖 core/dom.js（见文首 import）；app.js 与外挂模块都 import 这里的 api()。
// token 常量随实现一起搬来（原在 app.js；值从未变过，外挂副本的 MARKER 同值）——
// 放这里后 app.js 不再需要它，全项目单一出处。

import { $ } from './dom.js';
const CONSOLE_MARKER = 'qq-agent-console';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    // headers 必须排在 `...options` **之后**：放前面的话调用方只要传一次 headers，
    // 整个对象就被顶掉，x-console-token 跟着丢（2026-10-01 审查，属埋雷）。
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const dialog = $('#console-login');
    if (dialog && !dialog.open) dialog.showModal();
    $('#loading-overlay')?.classList.add('hidden');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}


export { api };