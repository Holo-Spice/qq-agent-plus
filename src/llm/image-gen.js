// 图片生成适配器：OpenAI 兼容的 POST {base}/images/generations（2026-09 主流网关与自建都收敛到这个形状）。
// 与 TTS 侧同构：只做兼容端点，原生厂商适配器等有需求再加。
//
// 响应两种形态（各网关不一，都要吃）：
//   · b64_json —— 图片本体直接给（省一次下载，首选）
//   · url      —— 给临时链接，由调用方走 safeFetchBinary 拉（本项目已有 SSRF 防护）
//
// Key 归属是这里的重点（见 resolveImageGenAuth）：配置指向别家却留空 Key 时，
// **绝不能**回退用聊天模型那把 Key —— 那是"把 A 家的密钥发给 B 家"的经典事故。
//
// 下载器（url 形态）直接 import safeFetchBinary 而不是当参数传：函数当参数会被 ops scan
// 当成"未定义调用点"误报（与 tts-http.js 里记的同一类）。
import { watchTimeWindow } from '../core/time-gate.js';
import { safeFetchBinary } from './safe-fetch.js';

export const MAX_PROMPT_CHARS = 800;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 与表情库落盘上限一致

export function imageGenConfigured(cfg) {
  const g = cfg?.imageGen || {};
  return g.enabled === true
    && String(g.baseUrl || '').trim() !== ''
    && String(g.model || '').trim() !== '';
}

/** 取主机名（比较"是不是同一家"用；解析失败返回空串）。 */
function hostOf(url) {
  try { return new URL(String(url || '').trim()).host.toLowerCase(); } catch { return ''; }
}

/** 实际要打的地址：imageGen 没填就跟聊天模型同一家（很多网关同域就带 images 端点）。 */
export function imageGenBaseUrl(imageGen, api) {
  const own = String(imageGen?.baseUrl || '').trim();
  if (own) return own.replace(/\/+$/, '');
  return String(api?.baseUrl || '').trim().replace(/\/+$/, '');
}

/**
 * 决定用哪把 Key、以及能不能复用聊天模型那把。
 * 规则（2026-09-30 定的守卫）：
 *   1. imageGen 自己填了 Key → 用它；
 *   2. 没填，但实际地址与聊天模型 api.baseUrl **同域**（含"没填地址=跟模型同一家"）→ 复用；
 *   3. 没填且不同域 → 拒绝，返回明确错误（要求显式填 Key），绝不把模型 Key 发给外部地址。
 * 返回值：{ ok, key, reused, error }
 */
export function resolveImageGenAuth({ imageGen, api, apiKey } = {}) {
  const own = String(imageGen?.apiKey || '').trim();
  if (own && own !== '******') return { ok: true, key: own, reused: false, error: '' };
  const gHost = hostOf(imageGenBaseUrl(imageGen, api));
  const aHost = hostOf(api?.baseUrl);
  if (gHost && aHost && gHost === aHost) {
    const modelKey = String(apiKey || '').trim();
    if (modelKey && modelKey !== '******') return { ok: true, key: modelKey, reused: true, error: '' };
    return { ok: true, key: '', reused: false, error: '' };   // 同域但模型也没 Key：让请求自己去撞 401
  }
  return {
    ok: false,
    key: '',
    reused: false,
    error: '图片生成没有可用的 API Key：这里填的服务地址与聊天模型不是同一家，'
      + '不会把模型那把 Key 发给它。请在「图片生成」里单独填 Key，或把地址改成与模型相同的主机。'
  };
}

/**
 * 生成一张图。cfg：{ baseUrl, apiKey, model, size, timeoutMs, extraBody }
 * 返回 { buffer, format?, revisedPrompt? }；url 形态的图片在这里就下载好（调用方只拿到字节）。
 * 失败抛带可读原因的错。
 */
export async function generateImage({
  cfg,
  apiCfg = null,
  apiKey = '',
  prompt,
  signal = null,
  fetchFn = fetch
} = {}) {
  const g = cfg?.imageGen || cfg || {};
  const base = imageGenBaseUrl(g, apiCfg);
  const model = String(g.model || '').trim();
  const body = String(prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!base) throw new Error('未配置图片生成的服务地址（设置 → 图片生成；留空表示与聊天模型同一家，那边也要有地址）');
  if (!model) throw new Error('未配置图片生成的模型（如 gpt-image-1 / seedream-3.0）');
  if (!body) throw new Error('生图提示词为空');

  const auth = resolveImageGenAuth({ imageGen: g, api: apiCfg, apiKey });
  if (!auth.ok) throw new Error(auth.error);

  const size = String(g.size || '').trim();
  // response_format 默认**不发送**：新版 OpenAI（gpt-image-1）会因未知参数直接 400，
  // 而老接口不传也有默认行为；两种响应形态下面都吃，所以不传最兼容。
  // 想强制某一种的用户可以自己填 b64_json / url（填别的值当没填）。
  const wantFormat = String(g.responseFormat || '').trim();
  const formatParam = (wantFormat === 'b64_json' || wantFormat === 'url') ? { response_format: wantFormat } : {};
  const extra = g.extraBody && typeof g.extraBody === 'object' && !Array.isArray(g.extraBody)
    ? g.extraBody
    : {};

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(g.timeoutMs) || 120000);   // 生图比对话慢，默认给 2 分钟
  const timer = setTimeout(() => controller.abort(new Error('图片生成超时')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('Run cancelled'));
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error));
  try {
    const res = await fetchFn(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {})
      },
      body: JSON.stringify({
        model,
        prompt: body,
        n: 1,
        ...formatParam,
        ...(size ? { size } : {}),
        ...extra
      }),
      signal: controller.signal
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 下面按原文报错 */ }
    if (!res.ok) {
      const detail = String(parsed?.error?.message || parsed?.message || text || '').slice(0, 300);
      throw new Error(`图片生成失败 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    const item = Array.isArray(parsed?.data) ? parsed.data[0] : null;
    if (!item) throw new Error(`图片生成没有返回图片：${String(text).slice(0, 200)}`);

    const revisedPrompt = String(item.revised_prompt || '').trim();
    // ① b64_json：常见网关即便要 url 也会带上，优先用
    const b64 = String(item.b64_json || item.image || '').trim();
    if (b64) {
      const buffer = Buffer.from(b64, 'base64');
      if (!buffer.length) throw new Error('图片生成返回了空的 base64 数据');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('生成的图片过大（>8 MiB）');
      return { buffer, revisedPrompt };
    }
    // ② url：走内置的 SSRF 防护下载后再返回（调用方只拿到字节，不存会过期的临时链接）
    const url = String(item.url || '').trim();
    if (!url) throw new Error('图片生成既没有 b64_json 也没有 url');
    const { buffer } = await safeFetchBinary(url, MAX_IMAGE_BYTES, controller.signal);
    if (!buffer?.length) throw new Error('从生成结果 URL 下载到的图片为空');
    return { buffer, revisedPrompt };
  } finally {
    clearTimeout(timer);
    releaseTimeGuard();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
