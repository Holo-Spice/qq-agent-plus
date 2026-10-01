// 路由迁移收尾的静态断言（改进方案 #2，J.1 的"不重复注册"与 auth 显式化）：
// 迁移完成的契约 —— 源码里不得再出现 if 链形态的 /api/ 判定；所有 API 路由都走 router。
// 这两条断言同时是"防回退"：以后有人往 handleHttp 里加 if 分支会被直接拦下。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const src = fs.readFileSync(path.resolve('src/console/app.js'), 'utf8');

test('if 链形态的 /api/ 判定已清零（不重复注册：路由只存在于路由表）', () => {
  const literal = [...src.matchAll(/pathname === '\/api\/[^']*'/g)].map((m) => m[0]);
  const regexExec = [...src.matchAll(/\.exec\(pathname\)/g)].map((m) => m[0]);
  assert.deepEqual(literal, [], `handleHttp 里仍有字面量路由判定：${literal.join(', ')}`);
  assert.deepEqual(regexExec, [], `handleHttp 里仍有正则路由判定：${regexExec.length} 处`);
});

test("源码里没有残留的 '/api/' 前缀总闸（鉴权统一由路由表的 auth 默认 true 执行）", () => {
  assert.ok(!/pathname\.startsWith\('\/api\/'\)/.test(src), '总闸应已拆除');
});

test('每个 router.add 的显式 auth:false 都在白名单之内（auth 显式化的收口断言）', () => {
  // 按 `router.add(` 切块后逐块判定（不能用跨块的无界正则：那会跨过任意多条路由去
  // 找下一个 { auth: false }，归属不可靠 —— 2026-09-30 审查 P3）。
  const marker = String.fromCharCode(10) + '  router.add(';
  const blocks = src.split(marker).slice(1);
  const explicitFalse = [];
  for (const block of blocks) {
    if (!block.includes('{ auth: false }')) continue;
    const m = block.match(/^'\w+',\s*('([^']+)'|(\/(?:[^\n]*?)\/[a-z]*))/);
    assert.ok(m, `无法从 auth:false 路由块提取路径：${block.slice(0, 60)}`);
    explicitFalse.push(m[2] || m[3]);
  }
  const allowed = new Set(['/healthz', '/api/login']);
  const offenders = explicitFalse.filter((p) => !allowed.has(p));
  assert.deepEqual(offenders, [], `白名单外的 auth:false：${offenders.join(', ')}`);
  assert.equal(explicitFalse.length, 2, '当前应恰好两处 auth:false（/healthz、/api/login）');
});
