import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { IdentityPilotManager } from '../src/identity/identity-pilot.js';
import {
  parseRelationshipResponse,
  RelationshipPilotManager,
  relationshipPilotConfig
} from '../src/pilots/relationship-pilot.js';
import { relationshipDatabasePath } from '../src/pilots/relationship-pilot-store.js';
import { ChatStore } from '../src/core/store.js';
import '../src/pilots/relationship-runtime-integration.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-shadow-'));
  dirs.push(dir);
  return dir;
}

function config({ relationship = false } = {}) {
  return {
    api: { model: 'test-model' },
    allowAllWhenEmpty: true,
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    blocklist: {},
    identityPilot: {
      enabled: true,
      friendProposal: { enabled: false },
      incomingFriendRequest: { enabled: false }
    },
    relationshipPilot: {
      enabled: relationship,
      shadowMode: false
    }
  };
}

function response(argumentsValue) {
  return {
    message: {
      tool_calls: [{
        id: 'rel-1',
        type: 'function',
        function: {
          name: 'submit_relationship_events',
          arguments: JSON.stringify(argumentsValue)
        }
      }]
    }
  };
}

test('V1 shadowMode cannot be disabled by config', () => {
  const settings = relationshipPilotConfig(config({ relationship: true }));
  assert.equal(settings.enabled, true);
  assert.equal(settings.shadowMode, true);
});

test('disabled pilot creates no relationship database', () => {
  const dataDir = tempDir();
  const pilot = new RelationshipPilotManager({
    identityPilot: { active: true },
    store: {},
    dataDir,
    config: () => config({ relationship: false })
  });
  const status = pilot.start();
  assert.equal(status.enabled, false);
  assert.equal(status.active, false);
  assert.equal(fs.existsSync(relationshipDatabasePath(dataDir)), false);
});

test('evaluator accepts only evidence ids from NEW_EVIDENCE', () => {
  const evidence = [{ evidenceId: 'group:1#10', chatKey: 'group:1' }];
  const parsed = parseRelationshipResponse(response({
    events: [{
      type: 'warm_exchange',
      strength: 0.5,
      confidence: 0.8,
      evidenceIds: ['group:1#10'],
      summary: '用户主动延续此前共同话题'
    }]
  }), evidence);
  assert.equal(parsed.events.length, 1);
  assert.deepEqual(parsed.events[0].sourceChatKeys, ['group:1']);

  assert.throws(() => parseRelationshipResponse(response({
    events: [{
      type: 'trust_signal',
      strength: 0.8,
      confidence: 0.9,
      evidenceIds: ['memory:invented'],
      summary: '非法引用长期记忆'
    }]
  }), evidence), /不存在或不可计数/);
});

test('ordinary interaction may explicitly produce zero relationship events', () => {
  const parsed = parseRelationshipResponse(response({
    events: [],
    noChangeReason: '普通问答，没有明显关系变化'
  }), [{ evidenceId: 'private:12345#1', chatKey: 'private:12345' }]);
  assert.deepEqual(parsed.events, []);
  assert.match(parsed.noChangeReason, /普通问答/);
});

test('runtime patch keeps relationship state out of agent lookupPerson path', () => {
  const manager = Object.create(IdentityPilotManager.prototype);
  manager.config = () => config({ relationship: true });
  manager.identityStore = {
    hasSource: () => true,
    getPerson: (uin) => ({ userId: String(uin), primaryName: '测试用户' })
  };
  const person = manager.lookupPerson('12345', { chatKey: 'group:1' });
  assert.deepEqual(person, { userId: '12345', primaryName: '测试用户' });
  assert.equal(Object.hasOwn(person, 'relationship'), false,
    'Shadow Mode must not expose affinity/friction to person_memory_lookup');
});

function evaluationFixture(t, complete) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-evaluation-'));
  const store = new ChatStore(0, { dataDir });
  const entries = Array.from({ length: 8 }, (_, index) => store.appendIncoming('group:1', {
    mid: index + 1, senderId: '12345', text: `测试消息 ${index + 1}`
  }));
  let session;
  const cfg = config({ relationship: true });
  const pilot = new RelationshipPilotManager({
    identityPilot: { active: true, onebot: { selfId: '99' } },
    store, dataDir, config: () => cfg, complete, log: () => {},
    sessions: {
      create: (value) => (session = { id: 'evaluation', messages: [], ...value }),
      update: () => {},
      finish: (_id, status) => { session.status = status; }
    }
  });
  pilot.start();
  t.after(() => { pilot.stop(); store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {
    pilot, cfg,
    session: () => session,
    run: async () => {
      pilot.handleSuccessfulTurn({ chatKey: 'group:1', triggerEntries: entries });
      await pilot.queue;
    },
    evaluation: () => pilot.relationshipStore.db.prepare('SELECT * FROM relationship_evaluations').get()
  };
}

function withUsage(value, finishReason, completionTokens) {
  return { ...value, finishReason, raw: { choices: [{ finish_reason: finishReason }] },
    usage: { prompt_tokens: 100, completion_tokens: completionTokens, total_tokens: 100 + completionTokens } };
}

test('truncated evaluations retry once, retain both responses and apply only the complete result', async (t) => {
  const requests = [];
  const f = evaluationFixture(t, async (request) => {
    requests.push(request);
    if (requests.length === 1) return withUsage({ message: { reasoning_content: '仍在分析' } }, 'length', 4096);
    return withUsage(response({ events: [], noChangeReason: '无变化' }), 'tool_calls', 200);
  });
  await f.run();
  assert.deepEqual(requests.map((r) => r.maxTokens), [4096, 8192]);
  assert.ok(requests.every((r) => r.purpose === 'judge'));
  assert.equal(f.evaluation().status, 'done');
  assert.equal(f.session().status, 'done');
  assert.equal(f.session().usage.calls, 2);
  assert.equal(f.session().usage.completionTokens, 4296);
  assert.equal(f.session().messages.length, 2);
  assert.equal(f.session().messages[0].finishReason, 'length');
  assert.equal(f.session().messages[0].reasoning_content, '仍在分析');
  assert.deepEqual(f.session().callUsage.map((call) => call.round), [1, 2]);
  assert.ok(f.pilot.relationshipStore.cursors('12345')['group:1'] > 0);
});

test('a second truncation is rejected even with valid JSON and never advances evidence cursors', async (t) => {
  let calls = 0;
  const f = evaluationFixture(t, async () => {
    calls++;
    return withUsage(response({ events: [{ type: 'warm_exchange', strength: 0.4,
      confidence: 0.8, evidenceIds: ['group:1#1'], summary: '完整但被截断标记的事件' }] }),
    'length', calls === 1 ? 4096 : 8192);
  });
  await f.run();
  assert.equal(calls, 2);
  assert.equal(f.evaluation().status, 'failed');
  assert.equal(f.session().status, 'error');
  assert.match(f.session().error, /Token 上限.*截断/);
  assert.equal(f.session().usage.completionTokens, 12288);
  assert.equal(f.session().messages.length, 2);
  assert.deepEqual(f.pilot.relationshipStore.cursors('12345'), {});
  assert.equal(f.pilot.relationshipStore.recentEvents('12345').length, 0);
});

test('non-truncation validation failures preserve response and usage without retrying', async (t) => {
  let calls = 0;
  const f = evaluationFixture(t, async () => {
    calls++;
    return withUsage({ message: { content: '没有调用工具' } }, 'stop', 42);
  });
  await f.run();
  assert.equal(calls, 1);
  assert.equal(f.evaluation().status, 'failed');
  assert.equal(f.session().usage.completionTokens, 42);
  assert.equal(f.session().messages[0].content, '没有调用工具');
  assert.match(f.session().error, /未提交唯一/);
  assert.deepEqual(f.pilot.relationshipStore.cursors('12345'), {});
});

test('disabling the pilot during a truncated call prevents a retry and any relationship writes', async (t) => {
  let calls = 0;
  const f = evaluationFixture(t, async () => {
    calls++;
    f.cfg.relationshipPilot.enabled = false;
    return withUsage(response({ events: [] }), 'length', 4096);
  });
  await f.run();
  assert.equal(calls, 1);
  assert.match(f.session().error, /已停止/);
  assert.deepEqual(f.pilot.relationshipStore.cursors('12345'), {});
});
