// 共享 DOM/转义内核（改进方案 #1 A 档）：esc / $ / $$ 的**单一实现**。
// 内核最底层：只依赖浏览器内建，不 import 任何兄弟模块（反过来谁都 import 它）。
// 替换的重复副本：app.js 原定义，以及 global-memory / relationship-pilot /
// auto-update-network 里各一份逐字相同（或等义）的 esc。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}


export { $, $$, esc };