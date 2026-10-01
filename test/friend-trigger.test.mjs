import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-friend-trigger-'));
process.env.QQ_AGENT_DATA_DIR = root;
// 用例自己造的临时目录自己清（约定见 test/README.md）：以前只删 case-* 子目录，
// 根目录每跑一次漏一个，Windows 上尤其明显
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });
process.env.NODE_TEST_CONTEXT = '1';

const { ChatStore } = await import('../src/core/store.js');
const { IdentityPilotManager } = await import('../src/identity/identity-pilot.js');

function config(probability = 1) {
  return {
    runtime: { mode: 'active' },
    api: { model: 'mock-model' },
    persona: {
      botName: '测试机器人',
      roleText: '你是一个普通群友。',
      customRules: ''
    },
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        mode: 'triggered',
        ownerUin: '900001',
        cooldownDays: 30,
        maxPending: 10,
        triggered: {
          probability,
          historyDays: 30,
          minMessages: 1,
          minActiveDays: 1,
          minDirectExchanges: 1,
          maxTriggerAgeMinutes: 10,
          friendStatusMaxAgeMinutes: 15,
          drawCooldownMinutes: 30,
          maxDrawsPerUserPerDay: 6,
          maxReviewsPerDay: 10,
          skipCooldownDays: 7,
          errorCooldownMinutes: 60,
          maxQueueAgeSeconds: 120,
          scoreThreshold: 70,
          weights: {
            quality: 40,
            interest: 30,
            reciprocity: 20,
            stability: 10
          }
        }
      }
    },
    allow: { groups: [], private: ['123456', '900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
}

function toolResponse(decision = 'propose') {
  return {
    model: 'mock-model',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120
    },
    message: {
      tool_calls: [{
        id: 'friend-review',
        type: 'function',
        function: {
          name: 'submit_friend_review',
          arguments: JSON.stringify({
            decision,
            ratings: {
              quality: 4,
              interest: 4,
              reciprocity: 4,
              stability: 4
            },
            evidenceIds: [
              'message:private:123456:1',
              'message:private:123456:2'
            ],
            reasonCode: 'interest',
            reason: '双方持续有具体交流意愿',
            verificationMessage: '以后继续聊'
          })
        }
      }]
    }
  };
}


async function fixture(t, {
  probability = 1,
  friends = [],
  complete = async () => toolResponse()
} = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const store = new ChatStore(0, { dataDir: dir });
  const cfg = config(probability);
  const incoming = store.appendIncoming('private:123456', {
    mid: 1001,
    ts: Date.now() - 1000,
    senderId: '123456',
    senderName: '候选人',
    text: '继续聊刚才的话题',
    eventKind: 'message'
  });
  store.appendSelf('private:123456', {
    mid: 1002,
    ts: Date.now() - 500,
    text: '可以',
    targetUserId: '123456',
    eventKind: 'message'
  });
  const notices = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      call: async (action) => action === 'get_friend_list' ? friends : {}
    },
    random: () => 0,
    complete,
    notifyFriendProposal: async (proposal) => notices.push(proposal),
    log: () => {}
  });
  await manager.start();
  t.after(() => {
    manager.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { cfg, store, incoming, manager, notices };
}

test('friend proposal retired: successful turns never draw, review or notify', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    complete: async () => {
      calls += 1;
      return toolResponse();
    }
  });
  const result = await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊',
    repliedThisRun: true
  });
  assert.deepEqual(result, { triggered: false, reason: 'disabled' });
  assert.equal(calls, 0, '退役后不应再发起一次性的模型评审调用');
  assert.deepEqual(f.manager.listFriendOpportunities(), []);
  assert.deepEqual(f.manager.listFriendProposals(), []);
  assert.equal(f.notices.length, 0, '退役后不应再给管理员发提案私信');
});

test('an existing friend never creates a draw or model review', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    friends: [{ user_id: 123456, nickname: '已有好友' }],
    complete: async () => {
      calls += 1;
      return toolResponse();
    }
  });
  const result = await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊'
  });
  assert.equal(result.triggered, false);
  assert.equal(calls, 0);
  assert.deepEqual(f.manager.listFriendOpportunities(), []);
  assert.deepEqual(f.manager.listFriendProposals(), []);
});

test('friend proposal retired: approval is rejected even for an existing pending proposal', async (t) => {
  const f = await fixture(t, {});
  // 生成管线已随退役关闭，直接在 store 层造一条历史 pending 提案（与 identity-store.test.mjs 同款）
  const created = f.manager.identityStore.createFriendProposal({
    userId: '123456',
    sourceChatKey: 'private:123456',
    reasonCode: 'frequent',
    reason: '已经连续聊了很多次',
    verificationMessage: '以后继续聊',
    minMessageCount: 1,
    cooldownDays: 30,
    maxPending: 10
  });
  assert.equal(created.created, true);
  const proposal = created.proposal;

  // 主动好友候选已退役（Issue #10 + QQ 账号风控）：已存在的 pending 提案
  // 也不能再被批准派发，功能门硬性拦截。
  await assert.rejects(
    () => f.manager.decideFriendProposal(
      proposal.id,
      'approve',
      { decidedBy: '900001' }
    ),
    /主动好友候选功能当前未启用/
  );
  assert.equal(f.manager.listFriendProposals()[0].status, 'pending');
});
