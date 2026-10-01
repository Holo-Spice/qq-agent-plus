// #6 结构化日志 + trace id：级别/格式/脱敏/trace 传播/永不抛。
// 变异对照：去掉级别过滤（过滤用例必红）、去掉 redactText（脱敏用例必红）、
// withTrace 不 run 直接调用 fn（传播用例必红）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, currentTraceId, lastTraceId, newTraceId, withTrace } from '../src/core/logger.js';

/** 捕获 console 四方法的调用；无论同步/异步 fn 都还原。 */
async function capture(fn) {
  const calls = [];
  const orig = {};
  for (const m of ['log', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...args) => { calls.push({ m, args }); };
  }
  try { await fn(); } finally { for (const m of Object.keys(orig)) console[m] = orig[m]; }
  return calls;
}

/** 临时改环境变量跑 fn（logger 按调用时读 env）。 */
function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('text 模式（默认）无 trace：与 console 直通一致，scope 不进正文', async () => {
  const calls = await capture(() => createLogger('orchestrator').info('[run] 开始', { a: 1 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].m, 'log');
  assert.deepEqual(calls[0].args, ['[run] 开始', { a: 1 }], '无 trace 时必须逐参数直通（迁移前观感）');
});

test('级别过滤：默认 info 不吐 debug；设 error 只剩 error', async () => {
  assert.equal((await capture(() => createLogger('x').debug('hidden'))).length, 0);
  const shown = await capture(() => withEnv({ QQ_AGENT_LOG_LEVEL: 'debug' }, () => createLogger('x').debug('shown')));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].m, 'debug');
  const err = await capture(() => createLogger('x').error('e'));
  assert.equal(err[0].m, 'error');
  const warn = await capture(() => createLogger('x').warn('w'));
  assert.equal(warn[0].m, 'warn');
  const onlyErr = await capture(() => withEnv({ QQ_AGENT_LOG_LEVEL: 'error' }, () => {
    const l = createLogger('x');
    l.warn('w');
    l.info('i');
    l.error('e');
  }));
  assert.equal(onlyErr.length, 1);
  assert.equal(onlyErr[0].m, 'error');
});

test('脱敏：令牌与裸密钥过 redactText；Error 转脱敏堆栈；首尾空白不动', async () => {
  const calls = await capture(() => createLogger('llm').warn('失败: https://x/?access_token=tok-abc\n'));
  assert.ok(!calls[0].args[0].includes('tok-abc'), '查询串令牌必须脱敏');
  assert.ok(calls[0].args[0].includes('[redacted]'));
  assert.ok(calls[0].args[0].endsWith('\n'), '结尾换行必须保留（text 模式保原样）');
  const err = new Error('bad key sk-abcdefgh12345678');
  const calls2 = await capture(() => createLogger('llm').error('[x]', err));
  assert.equal(typeof calls2[0].args[1], 'string', 'Error 以与 console 相同的堆栈文本输出');
  assert.ok(calls2[0].args[1].includes('bad key sk-[redacted]'), '裸密钥必须脱敏');
  assert.ok(calls2[0].args[1].includes('Error: '), '堆栈文本形态保留');
});

test('json 模式：单行可解析、字段齐全、msg 已脱敏、child 的 scope 是 a:b', async () => {
  const calls = await capture(() => withEnv({ QQ_AGENT_LOG_FORMAT: 'json' }, () =>
    createLogger('orchestrator').child('wake').info('token=?access_token=s3cr3t')));
  assert.equal(calls.length, 1);
  const rec = JSON.parse(calls[0].args[0]);
  assert.equal(rec.level, 'info');
  assert.equal(rec.scope, 'orchestrator:wake');
  assert.equal(rec.traceId, '');
  assert.ok(rec.ts, 'ts 必须存在');
  assert.ok(!rec.msg.includes('s3cr3t'), 'json 的 msg 必须脱敏');
  assert.ok(rec.msg.includes('[redacted]'));
});

test('withTrace：上下文可见、跨 await/setTimeout 传播、text 行带前缀、remember 可控', async () => {
  assert.equal(currentTraceId(), '');
  let inside = '';
  const calls = await capture(async () => {
    await withTrace('abcd1234', async () => {
      inside = currentTraceId();
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      createLogger('x').info('t1');
      await Promise.resolve();
      createLogger('x').info('t2');
    });
  });
  assert.equal(inside, 'abcd1234');
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(String(c.args[0]).startsWith('[abcd1234] '), 'text 行必须带 trace 前缀');
  assert.equal(currentTraceId(), '', '出了 withTrace 就该是空');
  assert.equal(lastTraceId(), 'abcd1234');
  await capture(() => withTrace('ffff0000', () => {}, { remember: false }));
  assert.equal(lastTraceId(), 'abcd1234', 'remember:false 不得覆盖 lastTraceId');
  let auto = '';
  await capture(() => withTrace('', () => { auto = currentTraceId(); }));
  assert.match(auto, /^[0-9a-f]{8}$/, '不给 id 时自动生成 8 位');
  assert.match(newTraceId(), /^[0-9a-f]{8}$/);
});

test('日志失败不许影响业务：console 抛错时咽掉不冒泡', () => {
  const orig = console.log;
  console.log = () => { throw new Error('console broken'); };
  try {
    assert.doesNotThrow(() => createLogger('x').info('boom'));
    withEnv({ QQ_AGENT_LOG_FORMAT: 'json' }, () => {
      assert.doesNotThrow(() => createLogger('x').info('boom'));
    });
  } finally { console.log = orig; }
});
