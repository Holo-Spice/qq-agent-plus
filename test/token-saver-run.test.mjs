// 省 Token 模式**在真跑一轮时**的生效点：单次运行轮数上限、token 预算、私聊读多少条历史。
// 单测（test/token-saver.test.mjs）只覆盖纯函数；这里验证这些上限确实接在运行链路上 ——
// 否则把调用点删掉，纯函数测试照样是绿的。
// 单独一个文件：要一个干净的数据目录（同进程多个用例共用 DATA_DIR 会串状态）。
import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-token-saver-run-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能被句柄占着 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { SessionRegistry } = await import('../src/core/sessions.js');
const { SendQueue } = await import('../src/onebot/sender.js');
const { Orchestrator } = await import('../src/core/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/core/config.js');

function makeRunner({ mode, atCount = 300, allCount = 300, maxRounds = 12, maxRunTokens = 160000 }) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.allow.private = ['42'];
  cfg.api = { ...cfg.api, model: 'test', baseUrl: 'https://model.invalid', apiKey: 'k', maxRounds, maxRunTokens };
  cfg.store = { ...cfg.store, atCount, allCount, randomPercent: 100 };
  cfg.tokenSaver = { mode };
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const onebot = { getGroupInfo: async () => ({ group_name: 'test' }), sendText: async () => ({ message_id: 1 }) };
  const sender = new SendQueue({ store, onebot });
  const runner = new Orchestrator({ store, sessions, sender, onebot,
    stickers: {}, memory: { formatForPrompt: () => '', formatHandoffForPrompt: () => '' } });
  return { runner, store, sessions };
}

/** 桩模型：永远只读历史、不 finish —— 只能靠轮数/预算护栏收尾。 */
function stubToolOnly() {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { tool_calls: [{ id: `c${calls}`, function: { name: 'get_recent_messages', arguments: '{"limit":5}' } }] } }],
      usage: { total_tokens: 10 }
    });
  };
  return () => calls;
}

/** 取该会话最近一次运行的完整记录（listSummaries 只给摘要，可能混着别的用例的会话）。 */
function latestSessionRecord(chatKey) {
  const files = fs.readdirSync(path.join(dir, 'sessions'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, at: fs.statSync(path.join(dir, 'sessions', f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of files) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', f), 'utf8'));
    if (rec.chatKey === chatKey || String(rec.chatKey || '').endsWith(chatKey)) return rec;
  }
  throw new Error(`找不到 ${chatKey} 的会话记录`);
}

it('轮数上限：很省模式 5 轮就收尾，关闭模式跑满用户设的 12 轮', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const rounds = {};
  for (const mode of ['off', 'aggressive']) {
    const { runner, store } = makeRunner({ mode });
    const calls = stubToolOnly();
    store.appendIncoming('group:1', { mid: mode === 'off' ? 1 : 2, text: '在吗', senderId: '42' });
    await runner.wake('group:1');
    rounds[mode] = calls();
    const rec = latestSessionRecord('group:1');
    assert.equal(rec.roundBudgetStopped, true, `${mode}：这轮应该是"轮次用尽"收尾`);
    await runner.abortAll();
    store.close();
  }
  assert.equal(rounds.off, 12, `关闭模式应跑满 12 轮（实际 ${rounds.off}）`);
  assert.equal(rounds.aggressive, 5, `很省模式应在 5 轮收尾（实际 ${rounds.aggressive}）`);
});

it('单次运行预算：很省（5 万）比关闭（16 万）更早停', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const rounds = {};
  for (const mode of ['off', 'aggressive']) {
    let seq = 0;
  const { runner, store } = makeRunner({ mode, maxRunTokens: 160000 });
    let calls = 0;
    // 每次调用都报 2 万 token：关模式要攒到 16 万才停，很省模式 5 万就到线
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { tool_calls: [{ id: `c${calls}`, function: { name: 'get_recent_messages', arguments: '{"limit":5}' } }] } }],
        usage: { total_tokens: 20000 }
      });
    };
    seq += 1;
    store.appendIncoming('group:1', { mid: 3000 + seq, text: '在吗', senderId: '42' });
    await runner.wake('group:1');
    rounds[mode] = calls;
    await runner.abortAll();
    store.close();
  }
  assert.ok(rounds.aggressive <= 4, `很省模式应在 4 轮内因预算停下（实际 ${rounds.aggressive}）`);
  assert.ok(rounds.off >= 6, `关闭模式能跑到 6 轮以上（实际 ${rounds.off}）`);
  assert.ok(rounds.off > rounds.aggressive, '省 Token 模式必须真的更早停');
});

it('私聊也吃档位上限：很省模式下 contextLimit 被夹到 40', async (t) => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const limits = {};
  for (const mode of ['off', 'aggressive']) {
    const { runner, store } = makeRunner({ mode, atCount: 300 });
    globalThis.fetch = async () => Response.json({
      choices: [{ message: { tool_calls: [{ id: 'f1', function: { name: 'finish', arguments: '{"summary":"ok"}' } }] } }],
      usage: { total_tokens: 5 }
    });
    store.appendIncoming('private:42', { mid: 2000 + (mode === 'off' ? 1 : 2), text: '在吗', senderId: '42' });
    await runner.wake('private:42');
    limits[mode] = latestSessionRecord('private:42').contextLimit;
    await runner.abortAll();
    store.close();
  }
  assert.equal(limits.off, 300, `关闭模式私聊仍读 300 条（实际 ${limits.off}）`);
  assert.equal(limits.aggressive, 40, `很省模式私聊读 40 条（实际 ${limits.aggressive}）`);
});
