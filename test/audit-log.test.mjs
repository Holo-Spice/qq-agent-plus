// #5 审计日志：落盘脱敏/追加/轮转/截断/分页/旁路语义全测。
// 变异对照：把 prepareValue 里的 redactSecretFields 摘掉（明文用例必红）；
// 把 queryAudit 的 500 上限改成 9999（上限用例必红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { appendAudit, queryAudit, pruneAudit } = await import('../src/core/audit-log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-'));
const readAll = (dir) => fs.readdirSync(dir).sort()
  .map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');

test('含密钥的载荷落盘后全文无明文，标记 [redacted]', () => {
  const dir = tmp();
  appendAudit({
    dir,
    action: 'config.update',
    target: 'config',
    before: { api: { apiKey: 'sk-secret-abc' }, providerKeys: { p1: 'sk-p1' }, tts: { keys: { siliconflow: 'sk-tts' } } },
    after: { api: { apiKey: 'sk-secret-abc2' }, password: 'hunter2' },
    ok: true
  });
  const text = readAll(dir);
  for (const plain of ['sk-secret-abc', 'sk-p1', 'sk-tts', 'hunter2']) {
    assert.ok(!text.includes(plain), `明文不得落盘：${plain}`);
  }
  assert.ok(text.includes('[redacted]'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('追加写，不覆盖（两次写入 = 两行，顺序保持）', () => {
  const dir = tmp();
  appendAudit({ dir, action: 'a1', ok: true, at: 1700000000000 });
  appendAudit({ dir, action: 'a2', ok: true, at: 1700000001000 });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).action, 'a1');
  assert.equal(JSON.parse(lines[1]).action, 'a2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('按自然月切文件；pruneAudit 按保留月数删除（dry-run 不删；未来月份不误删）', () => {
  const dir = tmp();
  appendAudit({ dir, action: 'old', ok: true, at: Date.UTC(2026, 0, 15, 12) });    // 2026-01
  appendAudit({ dir, action: 'new', ok: true, at: Date.UTC(2026, 2, 15, 12) });    // 2026-03
  appendAudit({ dir, action: 'future', ok: true, at: Date.UTC(2026, 4, 15, 12) }); // 2026-05（未来）
  assert.deepEqual(fs.readdirSync(dir).sort(),
    ['audit-202601.jsonl', 'audit-202603.jsonl', 'audit-202605.jsonl']);
  const now = Date.UTC(2026, 2, 20, 12);   // 以 2026-03 为"当下"
  const dry = pruneAudit({ dir, keepMonths: 2, now, dryRun: true });
  assert.deepEqual(dry.removed, ['audit-202601.jsonl']);
  assert.ok(fs.existsSync(path.join(dir, 'audit-202601.jsonl')), 'dry-run 不得删文件');
  const real = pruneAudit({ dir, keepMonths: 2, now });
  assert.deepEqual(real.removed, ['audit-202601.jsonl']);
  assert.ok(!fs.existsSync(path.join(dir, 'audit-202601.jsonl')));
  assert.deepEqual(real.kept.sort(), ['audit-202603.jsonl', 'audit-202605.jsonl'], '未来月份保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('文件权限：目录 0700、文件 0600（win32 跳过）', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  appendAudit({ dir, action: 'perm', ok: true, at: Date.UTC(2026, 5, 5, 12) });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'audit-202606.jsonl')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('queryAudit：新→旧分页、before 游标、limit 硬上限 500', () => {
  const dir = tmp();
  const base = Date.UTC(2026, 6, 1, 12);
  for (let i = 0; i < 510; i++) appendAudit({ dir, action: `a${i}`, ok: true, at: base + i * 1000 });
  const cap = queryAudit({ dir, limit: 9999 });
  assert.equal(cap.entries.length, 500, 'limit 硬上限 500（不做全量导出）');
  assert.equal(cap.entries[0].action, 'a509', '新→旧');
  const p1 = queryAudit({ dir, limit: 3 });
  assert.deepEqual(p1.entries.map((e) => e.action), ['a509', 'a508', 'a507']);
  assert.equal(p1.nextBefore, p1.entries[2].ts);
  const p2 = queryAudit({ dir, limit: 3, beforeTs: p1.nextBefore });
  assert.deepEqual(p2.entries.map((e) => e.action), ['a506', 'a505', 'a504'], '游标翻页不重不漏');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('单字段超 4KB 截断并标 truncated；未超的字段原样', () => {
  const dir = tmp();
  appendAudit({
    dir, action: 'big', ok: true, at: Date.UTC(2026, 7, 1, 12),
    after: { note: 'x'.repeat(5000), small: 'ok' }
  });
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.truncated, true);
  assert.ok(rec.after.note.endsWith('…[截断]'));
  assert.equal(rec.after.note.length, 4096 + '…[截断]'.length);
  assert.equal(rec.after.small, 'ok');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('整条 before+after 超 256KB：降级为仅 changed 顶层键并标 partial', () => {
  const dir = tmp();
  const wide = (tag) => Object.fromEntries(
    Array.from({ length: 90 }, (_, i) => [`f${i}`, `${tag}-${'z'.repeat(4096)}`])
  );
  appendAudit({
    dir, action: 'huge', ok: true, at: Date.UTC(2026, 8, 1, 12),
    before: { keepme: 'small-before', ...wide('b') },
    after: { keepme: 'small-after', ...wide('a') },
    changed: ['keepme']
  });
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.partial, true);
  assert.deepEqual(Object.keys(rec.before), ['keepme']);
  assert.equal(rec.before.keepme, 'small-before');
  assert.equal(rec.after.keepme, 'small-after');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('旁路语义：落盘失败不抛（返回 null），只 console.warn', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'x');   // 文件挡在目录位置上 → mkdir 必失败
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  let r;
  try { r = appendAudit({ dir: path.join(blocker, 'audit-log'), action: 'x', ok: true }); }
  finally { console.warn = orig; }
  assert.equal(r, null);
  assert.equal(warns.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脱敏链：循环引用标 [circular] 且不丢记录；error 走 redactText 不落令牌', () => {
  const dir = tmp();
  const cyclic = { name: 'n' };
  cyclic.self = cyclic;
  appendAudit({
    dir, action: 'cyc', ok: false, at: Date.UTC(2026, 9, 1, 12),
    before: cyclic,
    error: 'fetch failed: https://x/?access_token=tok-9f8e7d'
  });
  const text = readAll(dir);
  assert.ok(!text.includes('tok-9f8e7d'), '错误文本里的令牌必须脱敏');
  const rec = queryAudit({ dir, limit: 1 }).entries[0];
  assert.equal(rec.before.self, '[circular]');
  assert.equal(rec.ok, false);
  assert.equal(rec.truncated, true, '配置形态脱敏在循环上失败 → 标 truncated');
  assert.ok(rec.error.includes('[redacted]'));
  fs.rmSync(dir, { recursive: true, force: true });
});
