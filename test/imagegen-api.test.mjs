// 图片生成（#21）的配置面与守卫（2026-09-30 审查补）：
//  1) GET /api/imagegen/key 存在且带 keyEndpoint 守卫（原来界面上有「显示」按钮却没这条路由，
//     点了没反应、已存的 Key 读不回来）；
//  2) 该路由无令牌时必须拒绝，且响应里不得出现明文 Key；
//  3) 提示词里的「画一张」指引与工具注入**同一道门**（imageGenAvailable）：
//     勾了开关但没填模型时，模型既拿不到工具、也不该被提示去用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, imageGenAvailable } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { buildSystemPrompt } = await import('../src/llm/prompt.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 说明：这条守卫（keyEndpointAllowed）在**合法配置**下无法构造出"绕过"场景 ——
//   · 监听非本机时 config 强制要求 server.token，而带令牌一律放行（令牌即完全管理凭据）；
//   · 监听本机时 loopback 请求被放行（本就只对管理员可见）。
// 所以本用例只断言"路由存在且有守卫"，并锁定"本机可读回明文"这一实用行为；
// 精确保住守卫语义的是 imagegen 那条与 /api/tts/key 同款的注册写法（keyEndpointAllowed 调用）。
test('GET /api/imagegen/key 存在且带密钥守卫；本机可读回明文', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' };
  cfg.imageGen = { ...cfg.imageGen, enabled: true, baseUrl: 'https://img.example.com/v1', model: 'img-1', apiKey: 'sk-img-secret-12345678' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();

  const raw = async (headers = {}) => new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/imagegen/key', method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end();
  });

  // 本机控制台：能读回明文（修复前该按钮点了没反应、Key 根本读不回来）
  const ok = await raw({ 'x-console-token': 'any', host: `127.0.0.1:${port}` });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body?.apiKey, 'sk-img-secret-12345678');

  // 守卫仍在：源码里这条路由必须调用 keyEndpointAllowed（与 /api/tts/key 同款写法）。
  // 用源码断言而不是伪造请求，是因为合法配置下构造不出"该被拒却放行"的场景（见上方说明）。
  const src = fs.readFileSync(path.resolve('src/console/app.js'), 'utf8');
  const routeStart = src.indexOf("router.add('GET', '/api/imagegen/key'");
  assert.ok(routeStart > 0, '路由必须存在');
  const routeBody = src.slice(routeStart, routeStart + 600);
  assert.match(routeBody, /keyEndpointAllowed\(req\)/, '密钥端点必须带 keyEndpointAllowed 守卫');
});

test('提示词与工具注入同一道门：勾了开关但没填模型 → 既不给工具也不提示', () => {
  // 半配置：enabled=true、model 为空 —— 正是"工具被过滤但提示还在"的那类状态
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.imageGen = { ...cfg.imageGen, enabled: true, model: '', baseUrl: '' };
  updateConfig(cfg);
  assert.equal(imageGenAvailable(cfg), false, '未填模型不算配置齐');
  const prompt = buildSystemPrompt({ persona: '测试人设' });
  assert.equal(/generate_image/.test(prompt), false, '工具拿不到时提示词不得让模型去用它');

  // 配齐之后两边都要出现
  const cfg2 = structuredClone(DEFAULT_CONFIG);
  cfg2.api = { ...cfg2.api, baseUrl: 'https://same.example.com/v1' };
  cfg2.imageGen = { ...cfg2.imageGen, enabled: true, model: 'img-1', baseUrl: '' };
  updateConfig(cfg2);
  assert.equal(imageGenAvailable(cfg2), true);
  const prompt2 = buildSystemPrompt({ persona: '测试人设' });
  assert.match(prompt2, /generate_image/, '配齐后提示词应引导使用');
});

test('GET /api/imagegen/presets 给出服务预设表（控制台下拉靠它渲染；无令牌跨源照旧 401）', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  cfg.api = { ...cfg.api, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm' };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();

  const get = async (path, headers = {}) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end();
  });

  const res = await get('/api/imagegen/presets', { host: `127.0.0.1:${port}` });
  assert.equal(res.status, 200, res.text);
  assert.ok(Array.isArray(res.body?.services) && res.body.services.length >= 3, '预设表不能是空的');
  const poll = res.body.services.find((s) => s.id === 'pollinations');
  assert.ok(poll, '免 Key 的那家必须在表里（"没有图模型"的用户只有它能开箱用）');
  assert.equal(poll.shape, 'pollinations');
  assert.deepEqual(poll.creds, []);
  assert.ok(res.body.services.every((s) => s.label && s.shape), '每条都要有 label 与 shape（前端直接渲染）');

  // 非本机来源 + 未配令牌 → 401（这条路由没有 auth:false，走默认鉴权）
  const denied = await get('/api/imagegen/presets', { host: `evil.example.com:${port}` });
  assert.equal(denied.status, 401);
});

// 2026-10-01：智谱 CogView 真机回的是 JPEG，而「试画一张」的预览 data URL 前缀写死成
// data:image/png。浏览器靠内容嗅探照样能显示，但右键「图片另存为」会存成"扩展名 .png
// 的 JPEG"。这条用例锁住"按实际字节写 MIME"。
test('POST /api/imagegen/test 的预览 data URL 用实际字节的 MIME（JPEG 不能写成 png）', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.imageGen = {
    ...cfg.imageGen,
    enabled: true,
    baseUrl: 'https://img.example.com/v1',
    model: 'cogview-3-flash',
    apiKey: 'sk-img-secret-12345678'
  };
  updateConfig(cfg);

  // 假图片服务：回 b64_json，字节是 JPEG 魔数（生成器走的是全局 fetch）
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 7)]);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ data: [{ b64_json: jpeg.toString('base64') }] })
    };
  };

  const app = createApp({ log: () => {} });
  t.after(async () => {
    globalThis.fetch = realFetch;
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();

  const res = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/imagegen/test', method: 'POST', headers: { 'content-type': 'application/json' } },
      (r) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { text += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(text) }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e.message) } }));
    req.end(JSON.stringify({ prompt: '一只橘猫' }));
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.mime, 'image/jpeg', 'MIME 必须按字节嗅探，不能写死');
  assert.match(res.body.image, /^data:image\/jpeg;base64,/, '预览 data URL 的前缀要与实际字节一致');
  assert.equal(calls[0]?.method, 'POST', 'OpenAI 形状是 POST {base}/images/generations');
});
