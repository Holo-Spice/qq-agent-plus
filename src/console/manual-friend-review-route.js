
const MANUAL_FRIEND_REVIEW_PATH = '/api/identity-pilot/friend-review/manual';
const MANUAL_ARGUMENT_NORMALIZER = Symbol('manualFriendReviewArgumentNormalizer');

async function readJsonBody(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error('请求体必须是 JSON');
  }
}

function json(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

/**
 * OpenAI-compatible 网关并不都严格遵循 function.arguments:string：
 * 有些会直接返回已经解码的对象；另一些模型偶尔会把 JSON 包在代码块中，
 * 或输出一个 harmless trailing comma。好友评估的下游校验仍要求标准 JSON，
 * 所以这里只做保守的“转成标准 JSON 字符串”，绝不 eval 任意文本。
 */
export function normalizeManualToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }
  if (typeof raw !== 'string') return raw;

  const original = raw.trim();
  const unfenced = original
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  const extracted = firstBrace >= 0 && lastBrace > firstBrace
    ? unfenced.slice(firstBrace, lastBrace + 1)
    : unfenced;
  const candidates = [...new Set([original, unfenced, extracted])].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch { /* try the next conservative repair */ }

    const withoutTrailingComma = candidate.replace(/,\s*([}\]])/g, '$1');
    if (withoutTrailingComma === candidate) continue;
    try {
      const value = JSON.parse(withoutTrailingComma);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch { /* leave the original value for the strict downstream validator */ }
  }
  return raw;
}

function normalizeManualReviewResponse(response) {
  const message = response?.message;
  if (!message || !Array.isArray(message.tool_calls)) return response;
  return {
    ...response,
    message: {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        if (!call?.function) return call;
        return {
          ...call,
          function: {
            ...call.function,
            arguments: normalizeManualToolArguments(call.function.arguments)
          }
        };
      })
    }
  };
}

function ensureManualArgumentNormalizer(manager) {
  if (!manager || manager[MANUAL_ARGUMENT_NORMALIZER]) return;
  const complete = manager.manualFriendReviewComplete;
  if (typeof complete !== 'function') return;
  manager.manualFriendReviewComplete = async (...args) =>
    normalizeManualReviewResponse(await complete(...args));
  Object.defineProperty(manager, MANUAL_ARGUMENT_NORMALIZER, {
    value: true,
    enumerable: false,
    configurable: false
  });
}

async function handleManualFriendReview(app, req, res) {
  const manager = app.identityPilot;
  if (!manager?.active || typeof manager.manualFriendReview !== 'function') {
    json(res, 409, { error: '主动好友候选功能未启用' });
    return;
  }
  ensureManualArgumentNormalizer(manager);
  try {
    const body = await readJsonBody(req);
    const result = await manager.manualFriendReview({
      userId: body.userId,
      chatKey: body.chatKey,
      requestedBy: 'console'
    });
    // 审计（#5）：例外路由走 app.auditWrite 留痕，与内部埋点同一套旁路语义（写失败不影响响应）
    app.auditWrite?.('friend-review.manual', String(body.userId ?? ''), { req, after: result });
    json(res, 200, result);
  } catch (error) {
    app.auditWrite?.('friend-review.manual', '', { req, ok: false, error: String(error?.message ?? error) });
    json(res, 409, { error: String(error?.message ?? error) });
  }
}

/**
 * 例外路由收口（改进方案 #2 / J.1）：2026-09-30 起这是往路由表注册的一条普通路由
 * （此前靠"摘掉 server 的 request 监听再包一层"实现，见 git 历史）。
 * 鉴权由路由表的 auth 默认 true 统一执行（本文件内的私有 authorize 副本已删）。
 */
export function installManualFriendReviewRoute(app) {
  if (typeof app?.addRoute !== 'function') {
    throw new Error('manual friend review route requires app.addRoute（createApp 的路由入口）');
  }
  app.addRoute('POST', MANUAL_FRIEND_REVIEW_PATH, (req, res) => handleManualFriendReview(app, req, res));
  return app;
}
