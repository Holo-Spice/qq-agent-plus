// #6 trace 入口：HTTP 响应头 x-trace-id（含 401）+ /api/status 的 lastTraceId 字段。
// 变异对照：去掉 router 的 setHeader（头断言必红）；去掉 status 的 lastTraceId（字段断言必红）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trace-'));
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

test('HTTP 请求带 x-trace-id（每次不同、8 位十六进制、401 也有）；/api/status 回显 lastTraceId', async (t) => {
  const port = await freePort();
  const token = 'trace-test-token-0123456789';
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const get = (route, withToken = true) => fetch(`http://127.0.0.1:${port}${route}`, {
    headers: withToken ? { 'x-console-token': token } : {}
  });

  // 1) 每个请求一个 8 位 id，两次不同
  const r1 = await get('/healthz', false);
  const t1 = r1.headers.get('x-trace-id') || '';
  const r2 = await get('/healthz', false);
  const t2 = r2.headers.get('x-trace-id') || '';
  assert.match(t1, /^[0-9a-f]{8}$/);
  assert.match(t2, /^[0-9a-f]{8}$/);
  assert.notEqual(t1, t2, '每个请求一个 id');

  // 2) 未授权的 /api/*（401）也带头 —— 失败请求同样能按 id 捞日志
  const denied = await get('/api/status', false);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('x-trace-id') || '', /^[0-9a-f]{8}$/);

  // 3) /api/status 回显 lastTraceId 字段（HTTP 请求不得覆盖它：应为字符串，默认空）
  const status = await get('/api/status');
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.ok(Object.prototype.hasOwnProperty.call(body, 'lastTraceId'), 'status 必须回显 lastTraceId');
  assert.equal(typeof body.lastTraceId, 'string');
  assert.notEqual(body.lastTraceId, t1, 'HTTP 层的 trace 不得写进 lastTraceId（remember:false）');
});
