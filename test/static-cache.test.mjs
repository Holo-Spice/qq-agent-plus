// UI 静态资源的缓存策略（改进方案 §11「给 core/* 加内容哈希长缓存」）：
//  - 下发的 index.html 里，自家脚本/样式的 URL 带内容哈希（?v=<sha256 前 12 位>）；
//  - 带对令牌的请求回 immutable 长缓存，令牌对不上/没带的退回回源校验（旧 URL 钉不住旧脚本）；
//  - 顺带补上真正的 304：此前只发 ETag/Last-Modified 却不判 If-None-Match，
//    no-cache 强制回源 + 每次 200 全文（线上实测 core/format.js 带 etag 仍回 200/26740 字节），
//    等于每开一次控制台就把全部脚本重下一遍。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UI = path.join(ROOT, 'ui');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-static-cache-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');

const sha12 = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(UI, file))).digest('hex').slice(0, 12);

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
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
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const raw = (route, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, { headers, redirect: 'manual' });
  return { port, raw };
}

test('下发的 index.html 里自家资源都带内容哈希令牌，且脚本清单与磁盘一致', async (t) => {
  const { raw } = await boot(t);
  const res = await raw('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'HTML 本身必须回源校验（否则改不动）');
  const html = await res.text();

  const served = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const onDisk = [...fs.readFileSync(path.join(UI, 'index.html'), 'utf8').matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(served.length, onDisk.length, '改写不能多出/少掉脚本');
  assert.deepEqual(served.map((s) => s.replace(/\?v=[0-9a-f]+$/, '')), onDisk, '改写只许加 ?v=，不许改路径或顺序');
  assert.ok(served.every((s) => /\?v=[0-9a-f]{12}$/.test(s)), `每个脚本都要带 12 位内容哈希：${served.filter((s) => !/\?v=[0-9a-f]{12}$/.test(s)).join(', ')}`);
  // 令牌 = 该文件内容的 sha256 前 12 位（证明是**内容**哈希：内容变则令牌变）
  assert.equal(served.find((s) => s.startsWith('/app.js?v=')), `/app.js?v=${sha12('app.js')}`);
  assert.equal(served.find((s) => s.startsWith('/core/format.js?v=')), `/core/format.js?v=${sha12('core/format.js')}`);
  // 每个改写后的 URL 都要真的取得到（别把路径改坏）
  for (const src of served) {
    const r = await raw(src);
    assert.equal(r.status, 200, `${src} 应可取回`);
  }
});

test('带对令牌 = immutable 长缓存 + 强 ETag；没带/带错令牌 = 回源校验', async (t) => {
  const { raw } = await boot(t);
  const token = sha12('core/format.js');

  const good = await raw(`/core/format.js?v=${token}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(good.headers.get('etag'), `"${token}"`, '内容哈希可以给强 ETag');
  assert.equal(await good.text(), fs.readFileSync(path.join(UI, 'core/format.js'), 'utf8'), '内容不许被改写');

  for (const route of ['/core/format.js', '/core/format.js?v=000000000000']) {
    const r = await raw(route);
    assert.equal(r.status, 200, `${route} 仍要能取到（老书签不能 404）`);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${route} 不许拿长缓存（旧 URL 会钉住旧脚本）`);
  }
});

test('真 304：带对令牌的资产与 HTML 都要能回 304（此前一律 200 全文）', async (t) => {
  const { raw } = await boot(t);
  const token = sha12('core/format.js');

  const first = await raw(`/core/format.js?v=${token}`);
  const etag = first.headers.get('etag');
  const again = await raw(`/core/format.js?v=${token}`, { 'if-none-match': etag });
  assert.equal(again.status, 304, '内容没变就该 304');
  assert.equal((await again.text()).length, 0, '304 不带正文');

  // 按体积+时间算的弱 ETag 走回源校验路径时也要能 304
  const plain = await raw('/pages/usage.js');
  const weak = plain.headers.get('etag');
  assert.match(weak, /^W\//);
  assert.equal((await raw('/pages/usage.js', { 'if-none-match': weak })).status, 304);

  // 没有任何校验头时不能回 304
  assert.equal((await raw(`/core/format.js?v=${token}`)).status, 200);

  // HTML：ETag 必须是**改写后字节**的哈希 —— 这样"脚本变了、HTML 自己没变"也会换 ETag，
  // 浏览器不会攥着旧 HTML 里的旧令牌不放。
  const html1 = await raw('/');
  const htmlEtag = html1.headers.get('etag');
  const htmlBody = await html1.text();
  assert.equal(htmlEtag, `W/"${crypto.createHash('sha256').update(htmlBody).digest('hex').slice(0, 16)}"`,
    'HTML 的 ETag 要等于下发内容（含令牌）的哈希');
  assert.equal((await raw('/', { 'if-none-match': htmlEtag })).status, 304, 'HTML 没变要 304');
  assert.equal((await raw('/', { 'if-none-match': 'W/"deadbeefdeadbeef"' })).status, 200, 'HTML 变了要给新内容');
});

test('If-Modified-Since 也能 304（非 HTML 文件），但 HTML 只认 ETag', async (t) => {
  const { raw } = await boot(t);
  const asset = await raw('/core/format.js');
  const lm = asset.headers.get('last-modified');
  assert.ok(lm, '要有 Last-Modified');
  assert.equal((await raw('/core/format.js', { 'if-modified-since': lm })).status, 304);

  const html = await raw('/');
  const htmlLm = html.headers.get('last-modified');
  assert.equal((await raw('/', { 'if-modified-since': htmlLm })).status, 200,
    'HTML 的 ETag 是"改写后内容"的哈希，脚本变了它就得变 —— 不能用文件时间做 304');
});

test('改写不碰外链，路径穿越与缺文件仍按原样拒绝/404', async (t) => {
  const { raw } = await boot(t);
  const html = await raw('/').then((r) => r.text());
  assert.ok(!/https?:\/\/[^"']*\?v=/.test(html), '外链不该被加令牌');

  for (const bad of ['/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await raw(bad);
    assert.ok(r.status === 403 || r.status === 404, `${bad} 应被拒（实得 ${r.status}）`);
  }
  assert.equal((await raw('/pages/does-not-exist.js?v=000000000000')).status, 404, '缺文件仍 404');
});
