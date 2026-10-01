// UI 静态资源的缓存策略：
//  - 下发的 index.html 里，**非 js** 的自家资源（css/svg/png）带内容哈希（?v=<sha256 前 12 位>），
//    带对令牌的请求回 immutable 长缓存，令牌对不上/没带的退回回源校验（旧 URL 钉不住旧文件）；
//  - **js 不带版本令牌**（2026-10-01，ui/ 转 ES module）：浏览器按 URL 认模块，HTML 里带 ?v= 的
//    /core/dom.js 与模块内相对 import（./dom.js）解析出的 /core/dom.js 是两个 URL、两份实例
//    （同一份 state 变成两份，页面正常但状态不共享）。所以 js 走 no-cache + 内容哈希 ETag
//    回源校验，真 304 照样生效。
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

test('下发的 index.html：css/svg/png 带内容哈希令牌，js 一个令牌都不许带', async (t) => {
  const { raw } = await boot(t);
  const res = await raw('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'HTML 本身必须回源校验（否则改不动）');
  const html = await res.text();

  // 脚本清单：路径与顺序原样，**且不带 ?v=**
  const served = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const onDisk = [...fs.readFileSync(path.join(UI, 'index.html'), 'utf8').matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(served.length, onDisk.length, '改写不能多出/少掉脚本');
  assert.deepEqual(served, onDisk, 'js 的 URL 必须逐字不变（模块身份靠它，见文件头注释）');
  assert.ok(!served.some((s) => s.includes('?v=')), `脚本 URL 不许带版本令牌：${served.filter((s) => s.includes('?v=')).join(', ')}`);

  // 样式/图标：带内容哈希（令牌 = 该文件内容的 sha256 前 12 位）
  assert.ok(html.includes(`/style.css?v=${sha12('style.css')}`), '样式表要带内容哈希令牌');
  const tokens = [...html.matchAll(/\/(?:style\.css|mark\.svg)\?v=([0-9a-f]{12})/g)].map((m) => m[1]);
  assert.ok(tokens.length >= 2, `css/svg 都应带令牌，实际 ${tokens.length} 个`);

  // 每个改写后的 URL 都要真的取得到（别把路径改坏）
  for (const url of [...served, `/style.css?v=${sha12('style.css')}`]) {
    const r = await raw(url);
    assert.equal(r.status, 200, `${url} 应可取回`);
  }
});

test('css/svg：带对令牌 = immutable 长缓存 + 强 ETag；没带/带错 = 回源校验', async (t) => {
  const { raw } = await boot(t);
  const token = sha12('style.css');

  const good = await raw(`/style.css?v=${token}`);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(good.headers.get('etag'), `"${token}"`, '内容哈希可以给强 ETag');
  assert.equal(await good.text(), fs.readFileSync(path.join(UI, 'style.css'), 'utf8'), '内容不许被改写');

  for (const route of ['/style.css', '/style.css?v=000000000000']) {
    const r = await raw(route);
    assert.equal(r.status, 200, `${route} 仍要能取到（老书签不能 404）`);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${route} 不许拿长缓存（旧 URL 会钉住旧文件）`);
  }
});

test('js：就算 URL 上带了内容哈希令牌，也不给 immutable（模块 URL 必须唯一）', async (t) => {
  const { raw } = await boot(t);
  const token = sha12('core/format.js');
  const r = await raw(`/core/format.js?v=${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache', 'js 一律回源校验');
  assert.equal(await r.text(), fs.readFileSync(path.join(UI, 'core/format.js'), 'utf8'), 'js 内容不许被改写');
});

test('真 304：资产与 HTML 都要能回 304（此前一律 200 全文）', async (t) => {
  const { raw } = await boot(t);
  const token = sha12('style.css');

  const first = await raw(`/style.css?v=${token}`);
  const etag = first.headers.get('etag');
  const again = await raw(`/style.css?v=${token}`, { 'if-none-match': etag });
  assert.equal(again.status, 304, '内容没变就该 304');
  assert.equal((await again.text()).length, 0, '304 不带正文');

  // js 的回源校验路径（内容哈希强 ETag）也要能 304
  const js = await raw('/pages/usage.js');
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  const jsEtag = js.headers.get('etag');
  assert.equal(jsEtag, `"${sha12('pages/usage.js')}"`, 'js 用内容哈希做 ETag');
  assert.equal((await raw('/pages/usage.js', { 'if-none-match': jsEtag })).status, 304);

  // 没有任何校验头时不能回 304
  assert.equal((await raw(`/style.css?v=${token}`)).status, 200);
  assert.equal((await raw('/pages/usage.js')).status, 200);

  // HTML：ETag 必须是**改写后字节**的哈希 —— 这样"资源变了、HTML 自己没变"也会换 ETag，
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
  const asset = await raw('/style.css');
  const lm = asset.headers.get('last-modified');
  assert.ok(lm, '要有 Last-Modified');
  assert.equal((await raw('/style.css', { 'if-modified-since': lm })).status, 304);

  const html = await raw('/');
  const htmlLm = html.headers.get('last-modified');
  assert.equal((await raw('/', { 'if-modified-since': htmlLm })).status, 200,
    'HTML 的 ETag 是"改写后内容"的哈希，资源变了它就得变 —— 不能用文件时间做 304');
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
