// 共享 DOM/转义内核（改进方案 #1 A 档）：esc / $ / $$ 的**单一实现**。
// classic script、无 import —— 顶层 const 处在"全局词法环境"里、跨脚本共享
// （后续加载的 app.js 与 8 个外挂文件都能直接使用），所以本文件必须在 app.js 之前加载。
// 替换的重复副本：app.js 原定义，以及 global-memory / relationship-pilot /
// auto-update-network 里各一份逐字相同（或等义）的 esc。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
