// 控制台响应压缩与贴纸图片长缓存（2026-10-02）：
//  - json() 对 >1KB 的响应按 Accept-Encoding 做 gzip：sessions 全量约 1.4MB、经隧道
//    裸传要 3.4 秒，而控制台每次初始化都拉它 —— 这是"每个页面加载都慢"的主因；
//  - 贴纸图片（本地图库）按 id 长缓存 + 强 ETag：重复浏览不再每张重下 126KB。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-compress-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { StickerManager } = await import('../src/onebot/sticker-manager.js');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// 种一张带图的贴纸，供图片端点用例使用
const sticker = new StickerManager(null).addManual({
  imageBuffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  ),
  desc: '压缩测试图'
});

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 原始 http 请求：undici fetch 会自动解压并藏掉 content-encoding，这里要看真实响应头
function req(port, route, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}

async function boot(t) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();
  return { port };
}

test('大 JSON 走 gzip，小 JSON 不压，二者都带 Vary', async (t) => {
  const { port } = await boot(t);
  const big = await req(port, '/api/status', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(big.status, 200);
  assert.equal(big.headers['content-encoding'], 'gzip', '/api/status 超过 1KB，应被 gzip');
  assert.equal(big.headers.vary, 'Accept-Encoding');
  const parsed = JSON.parse(zlib.gunzipSync(big.body).toString('utf8'));
  assert.ok(parsed && typeof parsed === 'object' && 'onebot' in parsed, 'gzip 解出来应是完整的 status JSON');

  const plain = await req(port, '/api/status', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok('onebot' in JSON.parse(plain.body.toString('utf8')), '不接受压缩的客户端仍拿到明文');

  const small = await req(port, '/api/memory', { headers: { 'accept-encoding': 'gzip' } });
  assert.ok(small.body.length < 1024, '该响应本就小于 1KB');
  assert.equal(small.headers['content-encoding'], undefined, '小响应不该压');
  assert.equal(small.headers.vary, 'Accept-Encoding', '小响应也要带 Vary（缓存协商正确性）');

  // 显式拒绝（q=0）不应被压缩；大小写不敏感
  const refuses = await req(port, '/api/status', { headers: { 'accept-encoding': 'gzip;q=0' } });
  assert.equal(refuses.headers['content-encoding'], undefined, 'q=0 视为拒绝');
  const upper = await req(port, '/api/status', { headers: { 'accept-encoding': 'GZIP' } });
  assert.equal(upper.headers['content-encoding'], 'gzip', '大小写不敏感');
});

test('贴纸图片：长缓存 + 强 ETag，重复请求 304 空体', async (t) => {
  const { port } = await boot(t);
  const first = await req(port, `/api/assets/stickers/image?id=${sticker.id}`);
  assert.equal(first.status, 200);
  assert.match(String(first.headers['cache-control']), /immutable/, '本地贴纸图片应长缓存');
  const etag = first.headers.etag;
  assert.ok(etag, '应返回 ETag');

  const second = await req(port, `/api/assets/stickers/image?id=${sticker.id}`, {
    headers: { 'if-none-match': etag }
  });
  assert.equal(second.status, 304, '命中 ETag 应回 304');
  assert.equal(second.body.length, 0);
});
