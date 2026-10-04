// 群日报（group-digest）门禁：读消息与调模型**之前**就该挡住观察模式/白名单外的群。
// 原来只在最后 sendTextBatch 时才被 access 挡 —— 于是每天照样读 400 条消息 + 调一次模型
// 才被拒（白花钱，还把群消息送出了网）。2026-10-03 全量审查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-digest-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { GroupDigestManager } = await import('../src/features/group-digest.js');
const { updateConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

function fixture({ mode = 'active', allow = ['1'] } = {}) {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    mid: `m${i}`, ts: Date.now() - 60_000, self: false,
    sender: { uin: 100 + i, nickname: `群友${i}` }, text: `第 ${i} 条消息`
  }));
  const stats = { modelCalls: 0, sent: 0 };
  const manager = new GroupDigestManager({
    store: { recent: () => rows, listChats: () => ['group:1'] },
    sender: { sendTextBatch: async () => { stats.sent += 1; return { sent: [] }; } }
  });
  updateConfig({
    ...DEFAULT_CONFIG,
    runtime: { ...DEFAULT_CONFIG.runtime, mode },
    allow: { groups: allow },
    groupDigest: { ...DEFAULT_CONFIG.groupDigest, enabled: true, chats: ['group:1'] }
  });
  // 群日报用 llm.chatCompletion（全局 fetch）→ 用 fetch 桩数调用次数
  globalThis.fetch = async () => {
    stats.modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '群里在聊啥' } }], usage: { total_tokens: 5 } });
  };
  return { manager, stats };
}

test('观察模式：群日报不调模型也不发', async () => {
  const f = fixture({ mode: 'observe' });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '观察模式不该花钱');
  assert.equal(f.stats.sent, 0);
});

test('白名单之外的群：群日报不调模型', async () => {
  const f = fixture({ mode: 'active', allow: ['999'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 0, '不在白名单的群不该花钱（门禁要放在调模型之前）');
});

test('正常放行时仍会调模型并发送（门禁没把功能打死）', async () => {
  const f = fixture({ mode: 'active', allow: ['1'] });
  await f.manager.runOnce();
  assert.equal(f.stats.modelCalls, 1, '白名单 + active 模式要照常跑');
  assert.equal(f.stats.sent, 1);
});
