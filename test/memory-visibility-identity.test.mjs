// #13 记忆可见性 × IdentityStore person 视图（2026-09-30 审查 P1 的回归护栏）。
//
// 背景：`person_memory_lookup` 工具走 identityPilot.lookupPerson → IdentityStore.getPerson →
// memory-runtime-integration 的 attachGlobalMemory。该工具自述"只返回当前会话可见的旧印象"，
// 但 memory.visibility（perChat / hidePrivateInGroup）原先只在 memory_query 与 formatForPrompt
// 接线，这条路径**没接** —— 群聊里会把私聊来源的印象注入给模型。修复=把 chatKey 透传到过滤处。
//
// 变异对照：把 memory-runtime-integration 里 normalizeMemoryView 的 visibleImpressions 改回
// 未过滤的 impressions（或 attachGlobalMemory 不透传 chatKey），下面三条必红。
//
// 注意：每条用例用**独立 QQ 号** —— MemoryStore.replaceMember 是"破坏性替换"语义（同一人
// 已有当前 chatKey 来源时会用新摘要覆盖既有全局印象），共用同一人会让用例互相清空数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vis-identity-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { MemoryStore } = await import('../src/memory/memory.js');
const { IdentityStore } = await import('../src/identity/identity-store.js');
const { ChatStore } = await import('../src/core/store.js');

function withVisibility(visibility) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.visibility = visibility;
  setRuntimeConfig(cfg);
}

/**
 * 造"同一人、两个来源"：群来源一条 + 私聊来源一条（entry 级 sourceChatKeys 由写入 API 带上）。
 * 每条用例传不同的 uin / 群号，避免 replaceMember 的破坏性替换互相清空。
 * @param extraChats 额外的"该人出现过但没留下印象"的会话（用于测 perChat 的过滤分支）
 */
function seed(uin, groupKey, extraChats = []) {
  const privateKey = `private:${uin}`;
  const memory = new MemoryStore();
  memory.replaceMember(groupKey, uin, 'Alice', ['喜欢 C++']);
  memory.replaceMember(privateKey, uin, 'Alice', ['正在准备面试']);

  const chatStore = new ChatStore(0, { dataDir: root });
  const now = Date.now();
  let mid = Number(uin) * 10;
  chatStore.appendIncoming(groupKey, { mid: ++mid, ts: now - 1000, senderId: uin, senderName: 'Alice', text: '群里消息' });
  chatStore.appendIncoming(privateKey, { mid: ++mid, ts: now, senderId: uin, senderName: 'Alice', text: '私聊消息' });
  for (const extra of extraChats) {
    chatStore.appendIncoming(extra, { mid: ++mid, ts: now, senderId: uin, senderName: 'Alice', text: '别处消息' });
  }
  const identity = new IdentityStore({ dataDir: root });
  identity.rebuild({ activityRows: chatStore.identityActivityRows(), legacyMemories: [], friends: [] });
  return { chatStore, identity, privateKey };
}

test('默认策略（global + 不隐藏）：两个来源都可见 —— 与历史行为一致（回归护栏）', (t) => {
  withVisibility({ mode: 'global', hidePrivateInGroup: false });
  const { chatStore, identity } = seed('12345', 'group:100');
  t.after(() => { identity.close(); chatStore.close(); });

  const person = identity.getPerson('12345', { chatKey: 'group:100', maxMemories: 10 });
  assert.deepEqual(
    new Set(person.globalMemories.map((m) => m.content)),
    new Set(['喜欢 C++', '正在准备面试'])
  );
});

test('hidePrivateInGroup：群聊里不出现私聊来源的印象，私聊里照常可见', (t) => {
  withVisibility({ mode: 'global', hidePrivateInGroup: true });
  const { chatStore, identity, privateKey } = seed('12346', 'group:200');
  t.after(() => { identity.close(); chatStore.close(); });

  const inGroup = identity.getPerson('12346', { chatKey: 'group:200', maxMemories: 10 });
  const groupContents = inGroup.globalMemories.map((m) => m.content);
  assert.ok(groupContents.includes('喜欢 C++'), '群来源的印象应保留');
  assert.ok(!groupContents.includes('正在准备面试'), '群聊里不得注入私聊来源的印象');

  const inPrivate = identity.getPerson('12346', { chatKey: privateKey, maxMemories: 10 });
  assert.ok(inPrivate.globalMemories.map((m) => m.content).includes('正在准备面试'), '私聊里照常可见');
});

test('perChat：只留来源含当前会话的印象；在该会话出现过但无来源 → 空', (t) => {
  withVisibility({ mode: 'perChat', hidePrivateInGroup: false });
  // 该人在 group:999 里出现过（所以 getPerson 不返回 null），但印象都来自别处
  const { chatStore, identity, privateKey } = seed('12347', 'group:300', ['group:999']);
  t.after(() => { identity.close(); chatStore.close(); });

  const inGroup = identity.getPerson('12347', { chatKey: 'group:300', maxMemories: 10 });
  assert.deepEqual(inGroup.globalMemories.map((m) => m.content), ['喜欢 C++']);
  const inPrivate = identity.getPerson('12347', { chatKey: privateKey, maxMemories: 10 });
  assert.deepEqual(inPrivate.globalMemories.map((m) => m.content), ['正在准备面试']);
  const elsewhere = identity.getPerson('12347', { chatKey: 'group:999', maxMemories: 10 });
  assert.deepEqual(elsewhere.globalMemories, [], '当前会话没有来源 → 不注入任何印象');
});

test('管理视图 listPeople 不受 perChat 影响：没有"当前会话"语义，按默认策略展示', (t) => {
  withVisibility({ mode: 'perChat', hidePrivateInGroup: false });
  const { chatStore, identity } = seed('12348', 'group:400');
  t.after(() => { identity.close(); chatStore.close(); });

  const listed = identity.listPeople(50).find((p) => p.userId === '12348');
  assert.equal(listed.globalMemories.length, 2, '控制台人物列表不该被某个群的 perChat 策略清空');
});
