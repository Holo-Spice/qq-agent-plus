// 结构化日志 + trace id（改进方案 #6，施工图见方案附录 J.6.2）。
// 约束（重要）：**默认观感与迁移前一致** —— text 模式下无 trace 时输出与直接 console.* 逐字节相同、
// 文案不改；级别/格式/trace 都是叠加能力，不是替换观感。
//   QQ_AGENT_LOG_LEVEL=error|warn|info|debug（默认 info；按调用时读，测试可改环境变量）
//   QQ_AGENT_LOG_FORMAT=text|json（默认 text；json 供 journald 过滤，单行一条）
// 所有输出过 redactText：text 模式对字符串与 Error 参数逐个脱敏（保留首尾空白），json 模式整行脱敏。
// 日志永远不许影响业务：emit 内部全 try/catch，连 console 抛错也咽掉。
import crypto from 'node:crypto';
import util from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redactText } from './redact.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const METHODS = { error: 'error', warn: 'warn', info: 'log', debug: 'debug' };
const store = new AsyncLocalStorage();
let last = '';

function levelLimit() {
  const wanted = String(process.env.QQ_AGENT_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[wanted] ?? LEVELS.info;
}

function jsonMode() {
  return String(process.env.QQ_AGENT_LOG_FORMAT || '').toLowerCase() === 'json';
}

/** 8 位十六进制 trace id。 */
export function newTraceId() {
  return crypto.randomBytes(4).toString('hex');
}

/** 当前异步上下文里的 trace id（不在 trace 内为空串）。 */
export function currentTraceId() {
  return store.getStore()?.traceId || '';
}

/**
 * 最近一次"被记住"的 trace id（业务入口用 withTrace 记）。HTTP 层用 remember:false 不记，
 * 否则 /api/status 读到的永远是它自己那次请求 —— 这个字段的用途是"拿着最后一次运行的 id 去捞日志"。
 */
export function lastTraceId() {
  return last;
}

/**
 * 在 trace 上下文里执行 fn（同步/异步都行：AsyncLocalStorage 随 await / setTimeout 传播）。
 * remember=true（默认）时同时记为"最近一次 trace"，供 /api/status 回显。
 */
export function withTrace(traceId, fn, { remember = true } = {}) {
  const id = String(traceId || '').trim() || newTraceId();
  if (remember) last = id;
  return store.run({ traceId: id }, fn);
}

/** 脱敏但保留首尾空白：redactText 自带 trim/slice，text 模式要保原样输出（如结尾的换行）。 */
function redactKeepPad(text) {
  const value = String(text ?? '');
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
  if (!m) return value;
  return m[1] + redactText(m[2], 100000) + m[3];
}

function emit(level, scope, args) {
  const method = METHODS[level] || 'log';
  try {
    if (LEVELS[level] > levelLimit()) return;
    const traceId = currentTraceId();
    if (jsonMode()) {
      console[method](JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: scope || '',
        traceId,
        msg: redactText(util.format(...args), 4000)
      }));
      return;
    }
    // text：字符串与 Error 逐个脱敏（Error 转成与 console 相同的堆栈文本），其余参数原样直通；
    // scope 不带进 text（现有文案自带 [xxx] 前缀，再拼一层就是重复）
    const safe = args.map((a) => {
      if (typeof a === 'string') return redactKeepPad(a);
      if (a instanceof Error) return redactKeepPad(util.format(a));
      return a;
    });
    if (traceId) console[method](`[${traceId}] ${util.format(...safe)}`);
    else console[method](...safe);
  } catch {
    // 日志失败不许影响业务：连 console 都抛错也咽掉
  }
}

/**
 * 建一个 scope 固定的 logger；`child(sub)` 在 json 模式下输出 `scope:sub`。
 * createLogger('') / 省略 scope 时不带 scope。
 */
export function createLogger(scope = '') {
  const make = (current) => ({
    error: (...args) => emit('error', current, args),
    warn: (...args) => emit('warn', current, args),
    info: (...args) => emit('info', current, args),
    debug: (...args) => emit('debug', current, args),
    child: (sub) => make(current ? `${current}:${String(sub ?? '')}` : String(sub ?? ''))
  });
  return make(String(scope || ''));
}
