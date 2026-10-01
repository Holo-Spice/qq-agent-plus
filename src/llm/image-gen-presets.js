// 图片生成的「服务预设」（对标 TTS / ASR 的服务预设）：把"去哪儿拿免费的图模型"写进控制台，
// 用户选一家就自动填好服务地址与默认模型，不用自己去翻各家文档。
//
// 预设里必须带 shape（请求形状），因为两种形状差很多：
//   · openai       —— POST {base}/images/generations（主流网关与自建都收敛到这个形状）
//   · pollinations —— GET  {base}/prompt/<提示词>?width=&height=（免 Key 的公共服务）
// 2026-10-01 实测的坑：pollinations 还有个长得像 OpenAI 的 POST /openai/images/generations，
// 但它**不看 body** —— 两个完全不同的提示词返回逐字节相同的图。照那个接，机器人会"不管你要
// 什么、都画同一张"。所以只认 GET 那条。
//
// creds 为空数组 = 这家不需要 Key（鉴权守卫会放行，见 image-gen.js 的 resolveImageGenAuth）。
//
// 关于"免费"：只有 pollinations 那条是**免注册免 Key**（第三方公共服务，可能限流或随时不可用）；
// 其余几家都要注册拿 Key，是否免费以各家定价页为准 —— 这里只写"去哪拿、地址填什么"。

export const IMAGEGEN_SERVICES = [
  {
    id: 'pollinations',
    label: 'Pollinations（免注册免 Key，免费但带水印）',
    shape: 'pollinations',
    creds: [],
    baseUrl: 'https://image.pollinations.ai',
    hosts: ['image.pollinations.ai'],
    models: [{ id: 'flux' }],
    note: '免注册、免 Key，填好就能画（默认模型 flux）。按官方文档：匿名档是「15 秒 1 次」按 IP 限流，图片带水印；'
      + '登录 auth.pollinations.ai 可提升额度并去水印（需注册，未实测）。'
      + '额度用完会返回空的 HTTP 402（2026-10-01 实测：同一时刻本机出口正常、云服务器出口 402，是按 IP 算的）。'
      + '提示词会经过它的服务器 —— 当作"零配置试玩"，长期用建议换有免费额度的图模型。'
  },
  {
    id: 'zhipu',
    label: '智谱 CogView-3-Flash（免费档，需注册拿 Key）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    hosts: ['open.bigmodel.cn'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [{ id: 'cogview-3-flash' }],
    note: 'CogView-3-Flash 是智谱的免费档（是否仍免费以官方定价页为准）；'
      + '服务地址要填到 /api/paas/v4 这一层，Key 用智谱开放平台的 API Key。'
      + '出图在右下角带「AI 生成」水印（2026-10-01 真机实测）—— 国内厂商按《人工智能生成合成内容'
      + '标识办法》都要打这个标识，介意水印只能换海外服务商（如 OpenAI 的图模型）。'
      + '实测：8~9 秒出一张 1024x1024，约 100 KB。'
  },
  {
    id: 'siliconflow',
    label: '硅基流动（模型广场里挑标了免费的图模型）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    hosts: ['api.siliconflow.cn'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [],
    note: '免费与否取决于选哪个模型：到「模型广场」挑标了免费的图模型（如 FLUX 系列的免费项）'
      + '填进「模型」栏，模型名必填。'
  },
  {
    id: 'modelscope',
    label: '魔搭 ModelScope API-Inference（有每日免费额度，需 Token）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    hosts: ['api-inference.modelscope.cn'],
    keyUrl: 'https://modelscope.cn/my/myaccesstoken',
    models: [],
    note: '按公开口径 API-Inference 有每日免费额度（以官网为准）；Token 在「访问令牌」页拿，'
      + '模型名填魔搭上支持推理的图模型 id（必填）。'
  },
  {
    id: 'custom',
    label: '自定义 / 自建（OpenAI 兼容）',
    shape: 'openai',
    creds: ['key'],
    baseUrl: '',
    hosts: [],
    models: [],
    note: '任何 OpenAI 兼容的 POST {服务地址}/images/generations 服务；模型名必填。'
  }
];

/** 按 id 取预设。 */
export function imageGenServiceById(id) {
  const key = String(id || '').trim();
  return IMAGEGEN_SERVICES.find((s) => s.id === key) || null;
}

/** 按服务地址认家（只按主机名比；解析失败返回 null）。 */
export function imageGenServiceOfBaseUrl(url) {
  let host = '';
  try { host = new URL(String(url || '').trim()).host.toLowerCase(); } catch { return null; }
  if (!host) return null;
  return IMAGEGEN_SERVICES.find((s) => (s.hosts || []).includes(host)) || null;
}

/** 这家预设是否需要 Key（creds 为空 = 不需要）。 */
export function imageGenServiceNeedsKey(service) {
  return Boolean(service && Array.isArray(service.creds) && service.creds.length);
}
