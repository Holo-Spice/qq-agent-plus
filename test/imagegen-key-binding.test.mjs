// 图片生成 Key 的归属（2026-10-01 审查 P1 + P2）：
//
//  P1：存过的 Key 要记着"是给哪家的地址存的"（imageGen.apiKeyHost）。不记的话，
//      "一键切换服务预设"（b97038f 的卖点）换个地址后，旧 Key 会以 Bearer 发给新主机 ——
//      静默事故，只会在别家后台留一条 401 或一笔意外计费。对照 asr 的 apiKeyProvider/apiKeyHost。
//  P2：/api/imagegen/key 在"同域复用模型 Key"时不能回显模型 Key 本体（否则点一次保存就把它
//      固化成 imageGen 自有 Key，"只发给同域"这条守卫从此对它失效）。留空即复用，不需要明文。
//
// 为什么必须"先写 config.json 再 import config.js"：迁移发生在读盘那一刻，
// 与其它用例共享模块实例的测试文件做不到（与 test/asr-credential-binding.test.mjs 同款）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-binding-'));
process.env.QQ_AGENT_DATA_DIR = root;

// 老配置：有 Key、但还没有归属字段（升级前形态）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  api: { provider: 'deepseek', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: 'model-key' },
  imageGen: {
    enabled: true,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: 'zhipu-key',
    model: 'cogview-3-flash'
  }
}, null, 2));

const C = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { imageGenKeyStale, resolveImageGenAuth } = await import('../src/llm/image-gen.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, method, urlPath, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' }
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, text, body: parsed });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), body: null }));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('读盘时给老配置补上"这把 Key 是给哪家地址存的"', () => {
  const cfg = C.getConfig();
  assert.equal(cfg.imageGen.apiKeyHost, 'open.bigmodel.cn', '按当前地址补记归属');
  assert.equal(imageGenKeyStale(cfg.imageGen, cfg.api), false, '刚补记的当然不算过期');
});

test('换成别家地址后：旧 Key 不生效（不算可用），界面拿得到 keyStale 说明', async (t) => {
  const port = await freePort();
  // 端口必须在 createApp/start 之前写进配置（监听地址是启动时读的）
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // 控制台的真实形态：/api/config 下发的 imageGen 里**没有** apiKey/apiKeyHost
  // （secret-keys 按字段名删掉），用户一键切换预设后点保存，body 里只有新地址。
  const view = (await request(port, 'GET', '/api/config')).body.imageGen;
  assert.equal('apiKey' in view, false, '前提：下发的配置里没有明文 Key');
  const saved = await request(port, 'POST', '/api/config', {
    imageGen: { ...view, baseUrl: 'https://api.siliconflow.cn/v1' }
  });
  assert.equal(saved.status, 200, saved.text);
  const after = C.getConfig();
  assert.equal(after.imageGen.apiKeyHost, 'open.bigmodel.cn', '发送空 Key 时不能把归属改到新地址');
  assert.equal(after.imageGen.apiKey, 'zhipu-key', '旧 Key 还在配置里（留着，但不生效）');

  // 真正的守卫：适配器拒绝把旧 Key 发到新地址
  const auth = resolveImageGenAuth({ imageGen: after.imageGen, api: after.api, apiKey: after.api.apiKey });
  assert.equal(auth.ok, false, '换地址后旧 Key 不能继续用');
  assert.equal(auth.key, '');

  // 界面拿得到"要重填"的依据
  const cfgRes = await request(port, 'GET', '/api/config');
  assert.equal(cfgRes.status, 200, cfgRes.text);
  assert.equal(cfgRes.body.imageGen.keyStale, true);
  assert.equal(cfgRes.body.imageGen.keyHost, 'open.bigmodel.cn');
  assert.equal(/zhipu-key/.test(cfgRes.text), false, '配置下发里不得出现明文 Key');
});

test('提交新 Key 时记归属（这是"重填一次"的正路）', async (t) => {
  const port = await freePort();
  // 端口必须在 createApp/start 之前写进配置（监听地址是启动时读的）
  C.updateConfig({ server: { ...C.getConfig().server, host: '127.0.0.1', port, token: '' } });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const saved = await request(port, 'POST', '/api/config', {
    imageGen: {
      ...C.getConfig().imageGen,
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sf-key-new'
    }
  });
  assert.equal(saved.status, 200, saved.text);
  const after = C.getConfig();
  assert.equal(after.imageGen.apiKey, 'sf-key-new');
  assert.equal(after.imageGen.apiKeyHost, 'api.siliconflow.cn', '归属跟着新地址走');

  const auth = resolveImageGenAuth({ imageGen: after.imageGen, api: after.api, apiKey: after.api.apiKey });
  assert.deepEqual(auth, { ok: true, key: 'sf-key-new', reused: false, error: '' });
});

test('/api/imagegen/key：同域复用时不回显模型 Key（P2）', async (t) => {
  const port = await freePort();
  const cfg = C.getConfig();
  // 清掉自有 Key，改成"与聊天模型同域"：这时才会走复用那条（都在 start 之前设好）
  C.updateConfig({
    server: { ...cfg.server, host: '127.0.0.1', port, token: '' },
    imageGen: { ...cfg.imageGen, baseUrl: 'https://gateway.example.com/v1', apiKey: '' },
    api: { ...cfg.api, baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key' }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  const res = await request(port, 'GET', '/api/imagegen/key');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.reused, true, '确实是复用模型 Key 那种情形');
  assert.equal(res.body.apiKey, '', '复用时不回显模型 Key —— 留空即生效，回显会被保存固化成自有 Key');
  assert.equal(/model-key/.test(res.text), false, '响应里不得出现模型 Key 明文');
});

test('老配置"地址留空（跟模型同域）+ 有 Key"：归属落到模型主机，升级不改行为', () => {
  // 空 baseUrl 是最常见的老形态（"跟聊天模型同域"就是它的默认值）。归属记成模型主机，
  // 换地址后照样不生效 —— 但升级那一刻不会突然把一直好用的 Key 判成"要重填"。
  // 迁移发生在读盘那一刻，所以必须换一个数据目录、换一个进程。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-legacy-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    api: { provider: 'deepseek', baseUrl: 'https://gateway.example.com/v1', model: 'm', apiKey: 'model-key' },
    imageGen: { enabled: true, baseUrl: '', apiKey: 'legacy-key', model: 'gpt-image-1' }
  }, null, 2));
  const configUrl = new URL('../src/core/config.js', import.meta.url).href;
  const code = [
    `process.env.QQ_AGENT_DATA_DIR = ${JSON.stringify(dir)};`,
    `const { getConfig } = await import(${JSON.stringify(configUrl)});`,
    'const g = getConfig().imageGen;',
    'console.log(JSON.stringify({ host: g.apiKeyHost, baseUrl: g.baseUrl }));'
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr || out.stdout);
  assert.deepEqual(JSON.parse(out.stdout.trim()), { host: 'gateway.example.com', baseUrl: '' });
});

test('保存时剔掉 GET 的派生字段：视图别名 keyHost 不落盘', async (t) => {
  const port = await freePort();
  const cfg = C.getConfig();
  C.updateConfig({
    server: { ...cfg.server, host: '127.0.0.1', port, token: '' },
    imageGen: {
      ...cfg.imageGen,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'zhipu-key',
      apiKeyHost: 'open.bigmodel.cn'
    }
  });
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  await app.start();

  // 前端形态：GET 的视图整份展开回传（含 keyHost / available / keyStale / hasApiKey）
  const view = (await request(port, 'GET', '/api/config')).body.imageGen;
  assert.equal(view.keyHost, 'open.bigmodel.cn', '前提：GET 确实下发了视图别名 keyHost');
  assert.equal(view.keyStale, false);
  const saved = await request(port, 'POST', '/api/config', { imageGen: { ...view } });
  assert.equal(saved.status, 200, saved.text);

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).imageGen;
  assert.equal('keyHost' in onDisk, false, '视图别名不落盘（真身是 apiKeyHost，两个说法会互相打架）');
  assert.equal('keyStale' in onDisk, false);
  assert.equal('available' in onDisk, false);
  assert.equal(onDisk.apiKeyHost, 'open.bigmodel.cn', '真身还在，归属没被洗掉');
  assert.equal(onDisk.apiKey, 'zhipu-key', 'Key 本身不受影响');
});
