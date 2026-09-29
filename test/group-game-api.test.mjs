// 群游戏的管理台接口（2026-09-29 新增）：面板要能列出进行中的局，也要能就地结束。
// 这里只覆盖 HTTP 那一层（参数校验、空列表、开关状态）；真正的"结束"行为在
// test/group-game.test.mjs 的"管理台视角"一条里（status 列表 + stop 播报）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-game-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('群游戏接口：chatKey 写错 400、没有局时 404、status 报告开关与空列表', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' };
  cfg.groupGame = { ...cfg.groupGame, enabled: true, chats: ['group:1'] };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const status0 = await request('/api/group-game/status');
  assert.equal(status0.status, 200);
  assert.equal(status0.body.enabled, true, '开关状态要如实报告');
  assert.deepEqual(status0.body.running, [], '还没有局时列表为空');

  const bad = await request('/api/group-game/stop', { method: 'POST', body: { chatKey: 'private:1' } });
  assert.equal(bad.status, 400, JSON.stringify(bad));
  assert.match(bad.body.error, /group:/, bad.body.error);

  const missing = await request('/api/group-game/stop', { method: 'POST', body: { chatKey: 'group:1' } });
  assert.equal(missing.status, 404, JSON.stringify(missing));
  assert.match(missing.body.error, /没有进行中的游戏/, missing.body.error);

  const emptyBody = await request('/api/group-game/stop', { method: 'POST', body: {} });
  assert.equal(emptyBody.status, 400, JSON.stringify(emptyBody));
});

test('群游戏接口：管理员能真的停掉一局（成功路径），列表随即为空', async (t) => {
  // 背景（2026-09-29 独立审查 P2）：原用例只覆盖 400/404 失败路径，
  // 成功路径完全没断言 —— 路由把 chatKey 传错、或有局时不真调 stop，套件仍会全绿。
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' };
  cfg.groupGame = { ...cfg.groupGame, enabled: true, chats: ['group:1'] };
  updateConfig(cfg);
  // 先落一局：GroupGameManager 在 createApp 时用 #load() 把它恢复出来
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'games.json'), JSON.stringify({
    games: {
      'group:1': {
        gameId: 'number-bomb',
        state: { phase: 'playing', low: 0, high: 100, guesses: 0 },
        startedAt: Date.now(),
        lastSeenId: 0
      }
    },
    daily: {}
  }));
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  const before = await request('/api/group-game/status');
  assert.equal(before.body.running.length, 1, '先要能看到这局：' + JSON.stringify(before.body));
  assert.equal(before.body.running[0].chatKey, 'group:1');

  const stopped = await request('/api/group-game/stop', { method: 'POST', body: { chatKey: 'group:1' } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped));
  assert.equal(stopped.body.ok, true);

  const after = await request('/api/group-game/status');
  assert.deepEqual(after.body.running, [], '停掉之后列表必须为空（真调到了 stop）');
});
