// 事件流（SSE）的三条保命措施（2026-10-01 审查）：
//   ① 背压：积压超过上限的客户端直接丢掉 —— 否则 res.write 一直往内核发送缓冲里堆，
//      页面留在后台/对端不读时进程内存无上限增长；
//   ② 心跳：定期发注释行，让半开连接上的"写不进去"尽早暴露（EventSource 忽略注释行）；
//   ③ 回收：被丢掉的客户端立刻 end()，对端收得到 FIN，集合里也不再留它（后续广播不再白写）。
// 变异对照：删掉 sseSend 里的 writableLength 判定 → 背压那条必红；删掉心跳定时器 → 心跳那条必红。
// 复用 audit-api 的脚手架（临时 DATA_DIR + 真实 createApp + 随机端口）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sse-stream-'));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
}

/** 起一个真实 app（observe 模式、OneBot 指向死端口），返回端口与令牌。 */
async function bootConsole(t, options = {}) {
  const port = await freePort();
  const token = 'sse-test-console-token-0123456789';
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: options.log || (() => {}), ...options.createApp });
  t.after(async () => { await app.stop(); });
  await app.start();
  return { app, port, token };
}

/** 裸 socket 连 SSE：EventSource 优先，这里要能"故意不读"，所以手写请求。 */
function connectStream(port, token) {
  const state = { text: '', ended: false, closed: false };
  const socket = net.connect(port, '127.0.0.1');
  socket.on('data', (chunk) => { state.text += chunk.toString('utf8'); });
  socket.on('end', () => { state.ended = true; });
  socket.on('close', () => { state.closed = true; });
  socket.on('error', () => { state.closed = true; });
  socket.write(
    `GET /api/events?token=${encodeURIComponent(token)} HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`
  );
  return { socket, state };
}

test('事件流：定期发注释行心跳（EventSource 会忽略）', async (t) => {
  // 心跳只在测试里调快；生产是 20 秒一次
  const { port, token } = await bootConsole(t, { createApp: { sseHeartbeatMs: 40 } });
  const { socket, state } = connectStream(port, token);
  t.after(() => socket.destroy());

  assert.ok(await waitFor(() => state.text.includes('event: hello')), `没有收到开头事件：${state.text}`);
  assert.ok(await waitFor(() => state.text.includes(': ping')), `心跳没到：${JSON.stringify(state.text)}`);
  // 注释行格式：以 ':' 开头 + 空行结束，EventSource 规范里会被忽略
  assert.ok(state.text.includes(': ping\n\n'), '心跳必须是注释行');
  assert.equal(state.closed, false, '心跳不该把正常连接关掉');
});

test('事件流：积压超过上限的客户端被丢掉、收到 FIN、之后不再收广播', async (t) => {
  const logs = [];
  const { app, port, token } = await bootConsole(t, {
    log: (line) => logs.push(String(line)),
    // 上限调到 4KB、心跳调到很远，让背压成为唯一会触发丢弃的原因
    createApp: { sseBacklogLimit: 4096, sseHeartbeatMs: 60000 }
  });
  const { socket, state } = connectStream(port, token);
  t.after(() => socket.destroy());
  assert.ok(await waitFor(() => state.text.includes('event: hello')), `没有收到开头事件：${state.text}`);

  // 对端不再读 → 内核缓冲填满后，res.write 只能往用户态队列里堆（writableLength 才会涨）
  socket.pause();
  const blob = 'x'.repeat(512 * 1024);
  const dropped = () => logs.some((line) => line.includes('丢弃事件流客户端'));
  for (let i = 0; i < 40 && !dropped(); i++) {
    app.emit('sse-test', { blob });
    await sleep(10);
  }

  assert.ok(dropped(), `积压后必须丢掉这个客户端：${logs.join(' | ') || '(没有日志)'}`);

  // 暂停中的流不会给出 'end'，要先排空：看到 FIN 才算真的关了
  socket.resume();
  const fin = await waitFor(() => state.ended || state.closed, 5000);
  assert.ok(fin, `被丢掉的客户端必须收到 FIN：${JSON.stringify({ ended: state.ended, closed: state.closed, text: state.text.length, logs: logs.slice(0, 3) })}`);

  // 丢掉之后集合里没有它了：再广播不该产生任何写入
  const seen = state.text.length;
  app.emit('sse-test', { blob: 'y'.repeat(1024) });
  await sleep(80);
  assert.equal(state.text.length, seen, '已丢弃的客户端不该再收到广播');
});

test('事件流：对端断开后广播不报错，控制台照常服务', async (t) => {
  const { app, port, token } = await bootConsole(t);
  const { socket, state } = connectStream(port, token);
  assert.ok(await waitFor(() => state.text.includes('event: hello')), `没有收到开头事件：${state.text}`);
  socket.destroy();
  await sleep(120);   // 让服务端处理掉 close
  app.emit('sse-test', { ok: true });   // 客户端已经不在名单里，这里不该抛
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: { 'x-console-token': token }
  });
  assert.equal(response.status, 200, '一个客户端消失不该影响控制台');
  await response.json();
});
