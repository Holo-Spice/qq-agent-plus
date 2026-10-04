// 2026-10-04 推前复审的回归用例（对应未发版提交 v0.7.7..HEAD 的审查结论）。
//
// 这一批全是"上一轮加固自己引入的漏洞"与"两套口径不一致"，逐条钉住：
//  ① TTS 单槽 Key：切服务**并**填新 Key 时，旧 Key 必须先归档（否则下一轮切回就永久丢失）；
//  ② ASR 归档槽的条目类型守卫（与目标槽同一套，之前只给目标槽加）；
//  ③ asr.providerDefaulted 在整节替换（__replace__）里也要被剥掉；
//  ④ migrateConfig 不再给"归属未知"的 imageGen Key 补钉（合并路径补 = 绑到刚被改掉的地址）；
//  ⑤ migrateConfig 把 asr.keys 的标量条目归一成 {}；
//  ⑥ updateConfig 遇到非对象的段不再 500。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-review-1004-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig, loadConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { ttsKeyFor } = await import('../src/llm/tts-presets.js');
const { imageGenKeyStale, resolveImageGenAuth } = await import('../src/llm/image-gen.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// 起一个只监听本机、observe 模式的控制台，返回请求助手
async function withConsole(t, seedConfig = () => {}) {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'ws://127.0.0.1:1';
  seedConfig(cfg);
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const disk = () => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  return { port, request, disk };
}

test('① 切服务并填新 Key：旧的那把必须先归档，不能被归属钉改绑后清掉', async (t) => {
  const { request } = await withConsole(t, (cfg) => {
    // 存量实例形态：Key 只在单槽 tts.apiKey 里，keys 映射是空的
    cfg.tts = { ...cfg.tts, enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'SK-SILICON-OLD' };
  });

  // 切到豆包并填一把新的 —— 这条路径之前完全绕过了归档分支
  let res = await request('/api/config', {
    method: 'POST',
    body: {
      tts: {
        enabled: true,
        provider: 'doubao',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
        apiKeyInput: 'SK-DOUBAO-NEW'
      }
    }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  let now = getConfig().tts;
  assert.equal(now.keys?.siliconflow, 'SK-SILICON-OLD', '切走前要把上一家的 Key 归档进它自己的槽位');
  assert.equal(ttsKeyFor(now, 'doubao'), 'SK-DOUBAO-NEW', '新服务拿到的是新填的那把');
  // 单槽与归属钉必须指向同一把（之前是"旧 Key 留在单槽、钉却指向新服务"）
  assert.equal(String(now.apiKey || ''), 'SK-DOUBAO-NEW', '单槽装的是新填的那把');
  assert.equal(now.apiKeyService, 'doubao', '归属钉与单槽内容一致');
  // 运行端真正会取的那把（不给 serviceId = 当前服务）：必须是新填的那把，不能是上一家的
  assert.equal(ttsKeyFor(now), 'SK-DOUBAO-NEW', '当前服务实际发出去的必须是新 Key');

  // 关键一步：切回硅基流动、不填 Key。修复前这里会因为"归档位已被占用"而直接置空 → 永久丢失
  res = await request('/api/config', {
    method: 'POST',
    body: { tts: { enabled: true, provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ttsKeyFor(getConfig().tts, 'siliconflow'), 'SK-SILICON-OLD', '切回原服务不用重填：归档那把自动回来了');
});

test('② asr.keys 里被手改成标量的槽位，归档时不摊成字符索引', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = {
      ...cfg.asr,
      // 讯飞：凭据按 provider 分槽（apiKeyProvider/secretIdProvider/secretKeyProvider = tencent）
      provider: 'tencent',
      apiKey: 'SK-TENCENT-OLD',
      apiKeyProvider: 'tencent',
      secretId: 'SECRET-ID-OLD',
      secretIdProvider: 'tencent',
      secretKey: 'SECRET-KEY-OLD',
      secretKeyProvider: 'tencent'
    };
  });
  // ⚠️ 坏条目必须**在路由跑之前**进内存：种子 updateConfig 自己就走 migrateConfig，
  // 那道防线会把标量先归一成 {}，路由层就永远遇不到标量条目（用例反而测不到归档守卫）。
  // 这里模拟的是"配置文件被手改坏 / 由更老的版本写出"的状态。
  const corrupted = disk();
  corrupted.asr.keys = { tencent: 'SCALAR' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(corrupted, null, 2));
  getConfig().asr.keys = { tencent: 'SCALAR' };

  // 保存一次（换服务、不带凭据）→ 归档循环要往 tencent 槽写
  const res = await request('/api/config', {
    method: 'POST',
    body: { asr: { enabled: true, provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const tencent = disk().asr.keys?.tencent;
  assert.equal(typeof tencent, 'object', '归档目标槽必须被归一成条目对象，不能是字符串摊开的字符索引');
  assert.equal(Array.isArray(tencent), false, '槽位不能是数组');
  // 旧凭据确实按它自己的槽位归档下来了（没被这次保存顺手冲掉）
  assert.equal(tencent.apiKey, 'SK-TENCENT-OLD', '归属明确的那把要归档进自己的槽位');
  assert.equal(tencent.secretKey, 'SECRET-KEY-OLD');
  assert.deepEqual(Object.keys(tencent).filter((k) => /^\d+$/.test(k)), [], '不许出现字符索引键');
});

test('③ 整节替换里的 asr.providerDefaulted 也要被剥掉', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1', providerDefaulted: true };
  });
  assert.equal(disk().asr.providerDefaulted, true, '前提：老标记确实在盘上');

  const res = await request('/api/config', {
    method: 'POST',
    body: { asr: { __replace__: { enabled: true, provider: 'openai', baseUrl: 'https://api.openai.com/v1', providerDefaulted: true } } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal('providerDefaulted' in disk().asr, false,
    '替换体里的 providerDefaulted 不许落盘（落盘就永久屏蔽 ASR_API_KEY 环境变量）');
  assert.equal(disk().asr.enabled, true, '替换体里的其它字段照常生效');
});

test('④ 合并路径不再给"归属未知"的 imageGen Key 补钉（读盘那次照旧补）', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, baseUrl: 'https://api.openai.com/v1' };
    // 老配置：单槽有 Key、没记归属
    cfg.imageGen = { ...cfg.imageGen, enabled: true, baseUrl: 'https://api.openai.com/v1', apiKey: 'SK-IMG-OLD', apiKeyHost: '' };
  });

// 前提（读盘语义）：给"有 Key 没归属"的老配置补钉，是 loadConfig 的职责，不是合并路径的
  const diskPath = path.join(root, 'config.json');
  const seedOnDisk = disk();
  seedOnDisk.imageGen.apiKeyHost = '';
  fs.writeFileSync(diskPath, JSON.stringify(seedOnDisk, null, 2));
  assert.equal(loadConfig().imageGen.apiKeyHost, 'api.openai.com',
    '读盘要给"有 Key 没归属"的老配置补上归属（migrateConfig 合并路径不做这件事）');

  // ⚠️ 落点断言：一次保存里既带新地址、又没带新 Key 时，那把"没记归属"的旧 Key **不许被补钉**
  //（补了就等于永久绑到新主机：换回原地址也对不上，用户的 Key 被锁死；
  //   而真发出去更糟 —— resolveImageGenAuth 会把它当新主机那把发出去）。
  updateConfig({
    imageGen: {
      ...getConfig().imageGen,
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'SK-IMG-OLD',
      apiKeyHost: ''
    }
  });
  assert.equal(String(getConfig().imageGen.apiKeyHost || ''), '',
    '合并路径不许认领"归属未知"的凭据（路由层刻意不认领，migrateConfig 不能替它认领）');
  assert.equal(getConfig().imageGen.apiKey, 'SK-IMG-OLD', '值本身留着（没填新 Key = 不动现有那把）');

  // 换回原来那家的地址 → 那把 Key 仍然可用（这才是"没被锁死"的用户可见结果）
  updateConfig({ imageGen: { ...getConfig().imageGen, baseUrl: 'https://api.openai.com/v1', apiKeyHost: '' } });
  const restored = getConfig().imageGen;
  assert.equal(imageGenKeyStale(restored, { baseUrl: 'https://api.openai.com/v1' }), false,
    '换回原来的地址后那把 Key 仍然可用');
  assert.equal(resolveImageGenAuth({ imageGen: restored, api: { baseUrl: 'https://api.openai.com/v1' } }).key, 'SK-IMG-OLD',
    '运行端确实会取到原来那把');

  // 而"控制台真的提交了新 Key"时归属照旧要记（别把守卫做成"永远不记归属"）。
// 注意走**路由**：归属钉由路由层按本次提交的地址算（migrateConfig 不再兜这一手）。
  const submitted = await request('/api/config', {
    method: 'POST',
    body: { imageGen: { enabled: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'SK-IMG-NEW' } }
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(disk().imageGen.apiKeyHost, 'open.bigmodel.cn', '提交新 Key 时按新地址记归属');
  assert.equal(disk().imageGen.apiKey, 'SK-IMG-NEW');
  assert.equal(disk().imageGen.keys?.['open.bigmodel.cn'], 'SK-IMG-NEW', '新 Key 也存进"这家存过的"映射');
});

test('⑤ asr.keys 的标量条目在读盘时被归一成对象', async (t) => {
  await withConsole(t, (cfg) => {
    cfg.asr = { ...cfg.asr, provider: 'openai', baseUrl: 'https://api.openai.com/v1', keys: { tencent: 'SCALAR' } };
  });
  const diskPath = path.join(root, 'config.json');
  const onDisk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  onDisk.asr.keys = { tencent: 'SCALAR', 'openai|api.openai.com': { apiKey: 'SK-X' } };
  fs.writeFileSync(diskPath, JSON.stringify(onDisk, null, 2));
  // 读盘（migrateConfig 是它的必经口）之后标量条目不该还在
  const loaded = loadConfig();
  assert.deepEqual(loaded.asr.keys.tencent, {}, '标量条目归一成空对象');
  assert.equal(loaded.asr.keys['openai|api.openai.com'].apiKey, 'SK-X', '正常条目不受影响');
});

test('⑥ 段被送成标量/数组时按"没改这一段"处理，不 500', async (t) => {
  const { request, disk } = await withConsole(t, (cfg) => {
    cfg.api = { ...cfg.api, baseUrl: 'https://api.openai.com/v1', model: 'gpt-x' };
  });
  for (const section of ['api', 'conversation', 'dailyMoments', 'qzoneInteractions']) {
    const res = await request('/api/config', { method: 'POST', body: { [section]: '__replace__x' } });
    assert.equal(res.status, 200, `${section} 送标量应被忽略而不是 500：${JSON.stringify(res.body)}`);
  }
  // 同样试数组（deepMerge 与"必须是对象"的判定都按数组另算）
  for (const section of ['api', 'asr', 'tts', 'imageGen', 'persona']) {
    const res = await request('/api/config', { method: 'POST', body: { [section]: [1, 2] } });
    assert.equal(res.status, 200, `${section} 送数组应被忽略而不是 500：${JSON.stringify(res.body)}`);
  }
  // 坏输入不能把已有配置冲掉
  assert.equal(disk().api.baseUrl, 'https://api.openai.com/v1', '坏输入不许清空整段');
  assert.equal(disk().api.model, 'gpt-x');
});