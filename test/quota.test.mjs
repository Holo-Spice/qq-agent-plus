// #9 配额双闸（src/core/quota.js）：会话隔离 / 全局共享 / 滑窗 / peek 只查不记 / configure。
// 变异对照：perChatMax 判定改成用 globalTimes（会话隔离用例必红）；peek 改成 tryConsume（只查不记用例必红）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createQuota } = await import('../src/core/quota.js');

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);

test('每会话闸门：A 用满不影响 B；超限返回 scope=chat 与 retryAfterMs', () => {
  const q = createQuota({ windowMs: 3600_000, globalMax: 100, perChatMax: 2 });
  assert.equal(q.tryConsume('group:1', T0).ok, true);
  assert.equal(q.tryConsume('group:1', T0 + 1000).ok, true);
  const denied = q.tryConsume('group:1', T0 + 2000);
  assert.equal(denied.ok, false);
  assert.equal(denied.scope, 'chat');
  assert.equal(denied.retryAfterMs, 3600_000 - 2000, '最早那次滑出窗口还需多久');
  assert.equal(q.tryConsume('group:2', T0 + 2000).ok, true, 'B 的额度不受 A 影响');
});

test('全局闸门：合计到全局上限时两个会话都受限（scope=global）', () => {
  const q = createQuota({ windowMs: 3600_000, globalMax: 3, perChatMax: 10 });
  assert.equal(q.tryConsume('a', T0).ok, true);
  assert.equal(q.tryConsume('b', T0 + 1).ok, true);
  assert.equal(q.tryConsume('c', T0 + 2).ok, true);
  const denied = q.tryConsume('d', T0 + 3);
  assert.equal(denied.ok, false);
  assert.equal(denied.scope, 'global');
  assert.equal(q.tryConsume('a', T0 + 4).scope, 'global', '已消费过的会话同样受全局限制');
});

test('滑动窗口：满窗即恢复；retryAfterMs 递减到 0', () => {
  const q = createQuota({ windowMs: 1000, globalMax: 10, perChatMax: 1 });
  q.tryConsume('g', T0);
  const mid = q.tryConsume('g', T0 + 999);
  assert.equal(mid.scope, 'chat');
  assert.equal(mid.retryAfterMs, 1);
  assert.equal(q.tryConsume('g', T0 + 1000).ok, true, '满窗即恢复');
});

test('peek 只查不记；snapshot 反映用量；reset 清零', () => {
  const q = createQuota({ windowMs: 3600_000, globalMax: 5, perChatMax: 1 });
  assert.equal(q.peek('g', T0).ok, true);
  assert.equal(q.peek('g', T0).ok, true, 'peek 不消耗额度');
  assert.equal(q.snapshot(T0).globalUsed, 0);
  q.tryConsume('g', T0);
  assert.equal(q.snapshot(T0).globalUsed, 1);
  assert.deepEqual(q.snapshot(T0).chats, { g: 1 });
  const denied = q.peek('g', T0);
  assert.equal(denied.ok, false, 'peek 能看到已满');
  assert.equal(denied.scope, 'chat');
  q.reset();
  assert.equal(q.peek('g', T0).ok, true);
  assert.equal(q.snapshot(T0).globalUsed, 0);
});

test('限值 0/非法 → 不设限；configure 运行期改限值', () => {
  const q = createQuota({ windowMs: 3600_000, globalMax: 0, perChatMax: 'abc' });
  for (let i = 0; i < 50; i++) assert.equal(q.tryConsume('g', T0 + i).ok, true, '限值非法＝不设限');
  q.reset();
  q.configure({ perChatMax: 2, globalMax: 3 });
  assert.equal(q.tryConsume('g', T0).ok, true);
  assert.equal(q.tryConsume('g', T0 + 1).ok, true);
  assert.equal(q.tryConsume('g', T0 + 2).scope, 'chat');
  assert.equal(q.tryConsume('h', T0 + 3).ok, true);
  assert.equal(q.tryConsume('i', T0 + 4).scope, 'global', '全局 3 已满');
});
