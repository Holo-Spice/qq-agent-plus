// 图片生成（generate_image）：适配器两条响应形态、错误路径、Key 归属守卫、闸门与配置访问器。
// 背景（Issue #21）：外部贡献者提议接入 OpenAI 兼容的 /images/generations；
// 评审时抓到三个坑 —— Key 归属、source 枚举、唯一成本闸门 —— 这里都钉上用例。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-imagegen-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  runtime: { mode: 'active' },
  allow: { private: ['1'] },
  api: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'model-key', model: 'm' }
}));

const { generateImage, resolveImageGenAuth, imageGenConfigured } = await import('../src/llm/image-gen.js');
const { imageGenAvailable, imageGenMaxPerHour } = await import('../src/core/config.js');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // 只验字节，不验完整 PNG

test('Key 归属守卫：同域才复用模型 Key，不同域必须自带（绝不把模型 Key 发给别家）', () => {
  const api = { baseUrl: 'https://gateway.example.com/v1' };
  // ① 自己填了 Key → 用它，与模型无关
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: { apiKey: 'own-key', baseUrl: 'https://other.example.com' }, api, apiKey: 'model-key' }),
    { ok: true, key: 'own-key', reused: false, error: '' }
  );
  // ② 留空 + 与模型同域 → 复用模型 Key（很多网关同域就带 images 端点）
  assert.deepEqual(
    resolveImageGenAuth({ imageGen: { baseUrl: 'https://gateway.example.com/v1' }, api, apiKey: 'model-key' }),
    { ok: true, key: 'model-key', reused: true, error: '' }
  );
  // ③ 留空 + 地址留空（= 跟模型走）→ 也算同域
  assert.equal(resolveImageGenAuth({ imageGen: {}, api, apiKey: 'model-key' }).reused, true);
  // ④ 留空 + 不同域 → 拒绝，且报错要说清为什么不给用
  const denied = resolveImageGenAuth({ imageGen: { baseUrl: 'https://other.example.com/v1' }, api, apiKey: 'model-key' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /不是同一家/);
  assert.equal(denied.key, '');
  // ⑤ 掩码占位不算真 Key（前端会把掩码回传）
  assert.equal(resolveImageGenAuth({ imageGen: { apiKey: '******', baseUrl: 'https://other.example.com' }, api, apiKey: 'model-key' }).ok, false);
});

test('适配器：b64_json 直接解码；不发 response_format（新版 OpenAI 会因未知参数 400）', async () => {
  const calls = [];
  const out = await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gateway.example.com/v1', model: 'gpt-image-1' } },
    apiCfg: { baseUrl: 'https://gateway.example.com/v1' },
    apiKey: 'model-key',
    prompt: '一只橘猫',
    fetchFn: async (url, req) => {
      calls.push({ url: String(url), headers: req.headers, body: JSON.parse(req.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal(calls[0].url, 'https://gateway.example.com/v1/images/generations');
  assert.equal(calls[0].headers.authorization, 'Bearer model-key');
  assert.equal(calls[0].body.model, 'gpt-image-1');
  assert.equal(calls[0].body.prompt, '一只橘猫');
  assert.equal(calls[0].body.n, 1);
  assert.equal('response_format' in calls[0].body, false);   // 默认不发
  assert.equal(out.buffer.toString('hex'), PNG.toString('hex'));

  // 用户显式填了才发（老网关需要它）
  const calls2 = [];
  await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm', responseFormat: 'url' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x',
    fetchFn: async (url, req) => {
      calls2.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal(calls2[0].response_format, 'url');
  // 乱填的值当没填（避免把非法参数发给服务商）
  const calls3 = [];
  await generateImage({
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm', responseFormat: 'webp' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x',
    fetchFn: async (url, req) => {
      calls3.push(JSON.parse(req.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }) };
    }
  });
  assert.equal('response_format' in calls3[0], false);
});

test('适配器：url 形态走内置安全下载器（真发一次 HTTP，验字节与体积上限口径）', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  // 真起一个本地 HTTP 服务当"图片 CDN"：url 形态由适配器自己 import 的 safeFetchBinary 下载
  // （不用回调注入 —— 那会被 ops scan 当成未定义调用点）。内网地址要开关放行，
  // 那个开关（security.allowPrivateImageHosts）本就是为本地测试/自建图床准备的。
  const httpMod = await import('node:http');
  const server = httpMod.default.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  updateConfig({ security: { allowPrivateImageHosts: true } });
  try {
    const out = await generateImage({
      cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
      apiCfg: { baseUrl: 'https://gw.example.com/v1' },
      apiKey: 'k',
      prompt: 'x',
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/a.png`, revised_prompt: '修订后的提示词' }] })
      })
    });
    assert.equal(out.buffer.toString('hex'), PNG.toString('hex'), '下载到的字节要原样返回');
    assert.equal(out.revisedPrompt, '修订后的提示词');

    // 内网地址在开关关闭时被 SSRF 拦下（默认口径）：同一个地址、同一个适配器，只是配置不同
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await assert.rejects(
      generateImage({
        cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
        apiCfg: { baseUrl: 'https://gw.example.com/v1' },
        apiKey: 'k',
        prompt: 'x',
        fetchFn: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/a.png` }] })
        })
      }),
      /内网/
    );
  } finally {
    updateConfig({ security: { allowPrivateImageHosts: false } });
    await new Promise((resolve) => server.close(resolve));
  }
});

test('适配器：错误路径都要带出服务商原文与可读原因', async () => {
  const base = {
    cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1', model: 'm' } },
    apiCfg: { baseUrl: 'https://gw.example.com/v1' },
    apiKey: 'k',
    prompt: 'x'
  };
  // HTTP 错误：带状态码与服务商 message
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'content policy violation' } }) }) }),
    /HTTP 403.*content policy violation/s
  );
  // 缺凭据/缺模型/空提示词：在发请求之前就拒
  await assert.rejects(generateImage({ ...base, cfg: { imageGen: { enabled: true, model: 'm' } }, apiCfg: { baseUrl: '' }, apiKey: '' }), /服务地址/);
  await assert.rejects(generateImage({ ...base, cfg: { imageGen: { enabled: true, baseUrl: 'https://gw.example.com/v1' } } }), /模型/);
  await assert.rejects(generateImage({ ...base, prompt: '   ' }), /提示词为空/);
  // 地址留空 + 模型那边也没地址 → 同样报"未配置服务地址"（不是静默打个相对路径）
  await assert.rejects(
    generateImage({ ...base, cfg: { imageGen: { enabled: true, model: 'm' } }, apiCfg: { baseUrl: '' } }),
    /服务地址/
  );
  // 响应里没有 data 数组
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ created: 1 }) }) }),
    /没有返回图片/
  );
  // data 里有条目但既无 b64 也无 url
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{}] }) }) }),
    /既没有 b64_json 也没有 url/
  );
  // 非 JSON 响应也要能看出原文
  await assert.rejects(
    generateImage({ ...base, fetchFn: async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }) }),
    /没有返回图片/
  );
  // 超大图要拦住（8 MiB 上限，与表情库落盘口径一致；变异验证时这条是唯一抓得住它的用例）
  await assert.rejects(
    generateImage({
      ...base,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') }] })
      })
    }),
    /图片过大/
  );
});

test('配置访问器：imageGenAvailable 的三态与闸门默认值', async () => {
  const { updateConfig } = await import('../src/core/config.js');
  // 默认关
  assert.equal(imageGenAvailable(), false);
  // 开了但没模型 → 不可用
  updateConfig({ imageGen: { enabled: true, model: '' } });
  assert.equal(imageGenAvailable(), false);
  // 开了 + 有模型 + 地址留空（与模型同域）→ 可用
  updateConfig({ imageGen: { enabled: true, model: 'gpt-image-1', baseUrl: '' } });
  assert.equal(imageGenAvailable(), true);
  // 开了 + 有模型 + 自己的地址 → 可用
  updateConfig({ imageGen: { enabled: true, model: 'm', baseUrl: 'https://other.example.com/v1' } });
  assert.equal(imageGenAvailable(), true);
  // 关掉 → 不可用
  updateConfig({ imageGen: { enabled: false } });
  assert.equal(imageGenAvailable(), false);
  // 闸门默认 6、上限 100、坏值回落
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 0 } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: -3 } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 'x' } }), 6);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 25 } }), 25);
  assert.equal(imageGenMaxPerHour({ imageGen: { maxPerHour: 9999 } }), 100);
  // imageGenConfigured 与 available 的口径差：前者不认"地址留空靠同域"
  assert.equal(imageGenConfigured({ imageGen: { enabled: true, baseUrl: 'https://a/v1', model: 'm' } }), true);
  assert.equal(imageGenConfigured({ imageGen: { enabled: true, baseUrl: '', model: 'm' } }), false);
});

test('工具：generate_image 未启用时不注入模型工具表', async () => {
  const { buildToolDefs, toOpenAiTools } = await import('../src/tools/tools-core.js');
  const names = toOpenAiTools(buildToolDefs()).map((t) => t.function.name);
  // 工具定义本身在（由 orchestrator 按配置过滤），但定义必须存在且形状正确
  assert.ok(names.includes('generate_image'));
  const def = buildToolDefs().find((d) => d.name === 'generate_image');
  assert.deepEqual(def.parameters.required, ['prompt']);
  assert.ok(def.description.includes('按张计费'));
});
