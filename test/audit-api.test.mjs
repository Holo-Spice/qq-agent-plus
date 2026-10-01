// #5 端到端：写接口埋点 → data/audit-log 落盘 → GET /api/audit 查得到；密钥不落盘、tokenFp 可对账。
// 复用 asr-config-api 的脚手架（临时 DATA_DIR + 真实 createApp + 随机端口）。
// 变异对照：把 /api/config 的 auditWrite 摘掉（本文件必红）；把 tokenFp 摘掉（指纹断言必红）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-api-'));
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

const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

test('写接口留痕：POST /api/config 落审计（无明文 Key）、GET /api/audit 可查、tokenFp 与令牌一致', async (t) => {
  const port = await freePort();
  const token = 'e2e-console-token-0123456789';
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
  const request = async (route, { method = 'GET', body, withToken = true } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(withToken ? { 'x-console-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  // 1) 未授权拿不到审计（新路由默认 auth:true）
  assert.equal((await request('/api/audit', { withToken: false })).status, 401);

  // 2) 写配置（带一个假 Key）→ 审计文件出现 config.update，且明文不落盘
  const wrote = await request('/api/config', {
    method: 'POST',
    body: { api: { apiKey: 'sk-e2e-secret-001', baseUrl: 'https://example.invalid/v1' } }
  });
  assert.equal(wrote.status, 200);
  const auditDir = path.join(root, 'audit-log');
  const files = fs.readdirSync(auditDir);
  assert.equal(files.length, 1, `应只有一个审计文件，实际 ${files.join(',')}`);
  const raw = fs.readFileSync(path.join(auditDir, files[0]), 'utf8');
  assert.ok(!raw.includes('sk-e2e-secret-001'), '明文 Key 不得落审计');
  assert.ok(raw.includes('config.update'));

  // 3) GET /api/audit 查得到，字段齐、tokenFp = sha256(令牌) 前 8 位
  const seen = await request('/api/audit?limit=10');
  assert.equal(seen.status, 200);
  const rec = seen.body.entries.find((e) => e.action === 'config.update');
  assert.ok(rec, 'config.update 必须能查到');
  assert.equal(rec.ok, true);
  assert.equal(rec.tokenFp, sha8(token), 'tokenFp 必须与本次鉴权用的令牌一致');
  assert.ok(rec.changed.includes('api'), `changed 应含 api，实际 ${JSON.stringify(rec.changed)}`);
  assert.ok(rec.after?.api?.hasApiKey === true, 'after 快照保留 hasApiKey 语义');
  assert.equal(rec.after?.api?.apiKey, undefined, 'after 快照不得含明文 Key');

  // 4) 接口层 limit 兜底：超限请求不炸、返回数组
  const capped = await request('/api/audit?limit=99999');
  assert.equal(capped.status, 200);
  assert.ok(Array.isArray(capped.body.entries));
});
