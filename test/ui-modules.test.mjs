// UI 模块清单防漂移（改进方案 #12-5）：ui/index.html 的 script 清单与 ui/ 下实际
// .js 文件必须一一对应 —— 拆/加模块（含 i18n 子目录）时最容易漏的就是这个。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const uiDir = path.resolve('ui');
const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [path.relative(uiDir, full).split(path.sep).join('/')] : [];
  });
}

test('index.html 的 script 清单与 ui/ 实际 .js 文件一一对应（双向）', () => {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
  const files = listJs(uiDir).sort();
  const missing = files.filter((f) => !srcs.includes(f));
  const dangling = srcs.filter((s) => !files.includes(s));
  assert.deepEqual(missing, [], `ui/ 下这些文件没被 index.html 加载：${missing.join(', ')}`);
  assert.deepEqual(dangling, [], `index.html 引用了不存在的文件：${dangling.join(', ')}`);
});

test('每个 <script src> 都被标成 type="module"（2026-10-01 ESM 化）', () => {
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)].map((m) => m[0]);
  assert.ok(tags.length >= 30, `script 标签数应等于 ui/ 文件数，实际 ${tags.length}`);
  const offenders = tags.filter((t) => !/type="module"/.test(t));
  assert.deepEqual(offenders, [], `这些标签没标 type="module"（浏览器会按 classic script 跑，撞上 import 直接 SyntaxError）：\n${offenders.join('\n')}`);
});

test('index.html 里内联的两段脚本必须**保持 classic**', () => {
  // 首屏防闪的"主题预置"与"启动提示兜底"必须在外链脚本之前、且在首帧之前执行；
  // ES module 是 defer 语义（解析完才跑），一旦被改成 module 就会先白/黑屏一下再上色。
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
  assert.equal(inline.length, 2, `内联脚本应恰好两段（boot 兜底 + 主题预置），实际 ${inline.length}`);
  const offenders = inline.filter((attrs) => /type="module"/.test(attrs));
  assert.deepEqual(offenders, [], '内联脚本不能改成 module（defer 语义会让首屏先闪一下）');
});

// 清单顺序：/i18n/** → /core/** → /pages/** → /app.js → 8 个外挂插件
//
// **顺序不再影响正确性**（2026-10-01 ESM 化之后）：跨文件依赖由 import 图决定，谁先求值
// 由模块图算出来，不再靠"标签先后"。这条用例守的是**可读性分层** —— 清单本身就是这份
// 代码的目录，把"内核 → 页面 → 骨架 → 外挂"的层次钉在文档里，免得以后有人以为
// 顺序是必需的、或者随手把外挂挪到中间让结构看起来是平的。
test('清单顺序仍是分层顺序（可读性约定，不再是正确性要求）', () => {
  const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const appIdx = srcs.indexOf('/app.js');
  assert.ok(appIdx !== -1, 'index.html 必须加载 /app.js');
  const offenders = [];
  for (const [idx, s] of srcs.entries()) {
    if (s === '/app.js') continue;
    const first = s.startsWith('/i18n/') || s.startsWith('/core/') || s.startsWith('/pages/');
    if (first && idx > appIdx) offenders.push(`${s} 应该排在 app.js 之前（内核/页面 → 骨架的分层）`);
    if (!first && idx < appIdx) offenders.push(`${s} 应该排在 app.js 之后（外挂插件在最外层）`);
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
