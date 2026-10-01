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

test('app.js 仍在业务脚本中第一个加载（classic script 的全局依赖顺序）', () => {
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const appIdx = srcs.indexOf('/app.js');
  assert.ok(appIdx !== -1, 'index.html 必须加载 /app.js');
  const otherBusiness = srcs.filter((s) => s !== '/app.js' && !s.startsWith('/i18n/') && !s.startsWith('/core/'));
  for (const s of otherBusiness) {
    assert.ok(appIdx < srcs.indexOf(s), `${s} 不能排在 app.js 之前（跨文件全局来自 app.js）`);
  }
});
