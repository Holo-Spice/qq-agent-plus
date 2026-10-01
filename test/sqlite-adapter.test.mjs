// core/sqlite 适配层测试（改进方案 C5/#11）：
// 打开/只读/统一 PRAGMA/能力探测/在线备份入口。
// 变异对照：删掉 sqlite.js 里的顶层 try/catch（改回静态 import）会让本文件的
// "能力探测"用例在加载期直接崩 —— 用例真实守护"缺内建模块给人话错误"这条契约。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sqlite-adapter-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  server: { port: 22498, host: '127.0.0.1' }
}));
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { openDatabase, backup, assertSqliteAvailable } = await import('../src/core/sqlite.js');

const dbFile = path.join(dataDir, 'adapter.sqlite');

test('openDatabase：打开 + 统一 PRAGMA（busy_timeout / foreign_keys；不碰 journal_mode——备份一致性，见 sqlite.js）', () => {
  const db = openDatabase(dbFile);
  try {
    const pragma = (name) => db.prepare(`PRAGMA ${name}`).get();
    assert.equal(pragma('busy_timeout').timeout, 5000);
    assert.equal(pragma('foreign_keys').foreign_keys, 1);
    db.exec('CREATE TABLE t (a TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run('x');
    assert.equal(db.prepare('SELECT a FROM t').get().a, 'x');
  } finally { db.close(); }
});

test('openDatabase：只读打开不设写类 PRAGMA，能读既有库、写被拒', () => {
  const ro = openDatabase(dbFile, { readOnly: true });
  try {
    assert.equal(ro.prepare('SELECT a FROM t').get().a, 'x');
    // 只读连接上 journal_mode 只能读到、写不进去：busy_timeout 仍被设置
    assert.equal(ro.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    // readOnly 真的只读：写入必须在 sqlite 层被拒（而不是适配层漏传 readOnly）
    assert.throws(() => ro.exec("INSERT INTO t VALUES ('y')"), /readonly|read-only/i);
  } finally { ro.close(); }
});

test('assertSqliteAvailable：当前环境可用时不抛', () => {
  assert.doesNotThrow(() => assertSqliteAvailable());
});

test('openDatabase：对不可写路径抛错（错误来自 sqlite 层而非适配层静默）', () => {
  const badDir = path.join(dataDir, 'no-such-dir', 'x.sqlite');
  assert.throws(() => openDatabase(badDir), /unable to open|ENOENT|sqlite/i);
});

test('backup：在线备份产出可打开的一致快照', async () => {
  const db = openDatabase(dbFile);
  const target = path.join(dataDir, 'backup-out.sqlite');
  try {
    await backup(db, target);
    assert.ok(fs.existsSync(target));
    const ro = openDatabase(target, { readOnly: true });
    try {
      assert.equal(ro.prepare('SELECT a FROM t').get().a, 'x');
      assert.equal(ro.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { ro.close(); }
  } finally { db.close(); }
});

test('integrity_check：适配层打开的库通过完整性检查', () => {
  const db = openDatabase(dbFile);
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { db.close(); }
});
