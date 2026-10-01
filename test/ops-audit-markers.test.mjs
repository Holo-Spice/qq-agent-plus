// 体检（ops audit）「关键补丁标记」的护栏：每条标记在本地代码树上必须命中期望条数。
//
// 背景：normalizeMid 的定义标记写的是 `^function normalizeMid\(value\)`，而文件早已是 ESM
// （`export function normalizeMid(value)`），行首锚点于是永远匹配不上 —— 体检在服务器上
// 常驻一条假 NG（2026-10-01 实测）。这类漂移只有在"有人跑一次体检"时才看得见，而体检不是
// 每天跑的动作，所以把同一张标记表拿来对本地代码树过一遍：实现改名、文件挪走、正则写错、
// 忘了带上 export 前缀，都会在这里立刻变红。
//
// 标记表本身没有导出（ops.js 是 CLI 脚本），所以从源码里取；数组元素是纯字符串，直接求值。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve('.');
const opsSource = fs.readFileSync(path.join(repo, 'src/ops.js'), 'utf8');

function loadMarkers() {
  const decl = opsSource.indexOf('const AUDIT_MARKERS = [');
  assert.ok(decl >= 0, 'src/ops.js 里应能找到 AUDIT_MARKERS 定义');
  const bodyStart = opsSource.indexOf('[', decl);
  const bodyEnd = opsSource.indexOf('\n];', bodyStart);
  assert.ok(bodyEnd > bodyStart, 'AUDIT_MARKERS 数组应以行首 `];` 收尾');
  const body = opsSource.slice(bodyStart, bodyEnd + 2);
  // 数组里允许有 `//` 行注释（正是本文件的修复处），直接求值即可。
  return Function(`return ${body}`)();
}

// 与 ops.js 的 checkMarker 同一套读法：按行判定，先归一化 CRLF。
function hitCount(file, pattern) {
  const regex = new RegExp(pattern);
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
    .filter((line) => regex.test(line)).length;
}

test('AUDIT_MARKERS 结构合法（名字/条数/文件/正则四元组）', () => {
  const markers = loadMarkers();
  assert.ok(markers.length >= 20, `标记表应至少 20 条，实际 ${markers.length}`);
  for (const row of markers) {
    assert.ok(Array.isArray(row) && row.length === 4, `标记行应为四元组：${JSON.stringify(row)}`);
    const [name, want, relative, pattern] = row;
    assert.equal(typeof name, 'string');
    assert.ok(Number.isInteger(want) && want >= 1, `${name} 的期望条数应为正整数`);
    assert.equal(typeof relative, 'string');
    assert.doesNotThrow(() => new RegExp(pattern), `${name} 的正则应能编译：${pattern}`);
  }
});

test('每条补丁标记在本地代码树上都命中期望条数（否则体检会常驻假 NG）', () => {
  const bad = [];
  for (const [name, want, relative, pattern] of loadMarkers()) {
    const file = path.join(repo, relative);
    if (!fs.existsSync(file)) { bad.push(`${name}: 文件缺失（${relative}）`); continue; }
    const count = hitCount(file, pattern);
    if (count < want) bad.push(`${name}: 期望≥${want} 实际 ${count}（${relative}）`);
  }
  assert.deepEqual(bad, [], `体检的补丁标记与当前实现脱节：\n${bad.join('\n')}`);
});

// 变异护栏：把 normalizeMid 定义标记改回没带 export 的旧写法，上面那条用例必须变红。
test('ESM 定义标记必须容忍 export 前缀（本次漂移的直指回归）', () => {
  const row = loadMarkers().find(([name]) => name === 'normalizeMid 定义');
  assert.ok(row, '应仍有 normalizeMid 定义这条标记');
  const [, want, relative, pattern] = row;
  const file = path.join(repo, relative);
  assert.ok(hitCount(file, pattern) >= want, '带 export 的实现行应被算作命中');
  assert.equal(hitCount(file, '^function normalizeMid\\(value\\)'), 0,
    '旧写法（无 export 前缀）在 ESM 文件上确实命中 0 —— 这正是那条假 NG 的成因');
});
