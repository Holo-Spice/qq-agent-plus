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
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
  const files = listJs(uiDir).sort();
  const missing = files.filter((f) => !srcs.includes(f));
  const dangling = srcs.filter((s) => !files.includes(s));
  assert.deepEqual(missing, [], `ui/ 下这些文件没被 index.html 加载：${missing.join(', ')}`);
  assert.deepEqual(dangling, [], `index.html 引用了不存在的文件：${dangling.join(', ')}`);
});

// 2026-10-01 拆模块后的加载分层（classic script 的全局依赖顺序）：
//   /i18n/** → /core/** → /pages/** → /app.js → 8 个外挂插件
// app.js 在**加载时**就执行 QARegistry.register('renderSettings', renderSettingsImpl) 之类的
// 注册（把底座实现登记进注册表），所以 core/pages 必须已经先声明过那些名字；反过来，
// 外挂插件在加载时读 app.js 暴露的全局、并往同一个注册表上挂 transform，必须在 app.js 之后。
test('业务脚本加载顺序：i18n/core/pages 先于 app.js，外挂插件在其后', () => {
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const appIdx = srcs.indexOf('/app.js');
  assert.ok(appIdx !== -1, 'index.html 必须加载 /app.js');
  const offenders = [];
  for (const [idx, s] of srcs.entries()) {
    if (s === '/app.js') continue;
    const first = s.startsWith('/i18n/') || s.startsWith('/core/') || s.startsWith('/pages/');
    if (first) {
      if (idx > appIdx) offenders.push(`${s} 必须排在 app.js 之前（app.js 加载时的 QARegistry.register 要用到它）`);
    } else if (idx < appIdx) {
      offenders.push(`${s} 必须排在 app.js 之后（外挂插件依赖 app.js 已声明的全局与注册表）`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
