// 补课（catchup）回复窗口的判断与日志（Issue #22 的影响 2）。
//
// 报告人指出：超过窗口的消息被 recordOnly 落库、永远不回复，而日志只说"补进 N 条"，
// 用户看到"补进来了"却等不到回应。窗口现在可配，日志要把"其中 N 条只补记录"写出来。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CATCHUP_REPLY_WINDOW_MS,
  MAX_CATCHUP_REPLY_WINDOW_MS,
  catchupReplyWindowMs,
  catchupLogLine,
  isFreshForReply
} from '../src/core/catchup-policy.js';

const repo = path.resolve('.');

test('窗口取值：默认 30 分钟、0 是显式值、非法值回落、超过一天截断', () => {
  assert.equal(catchupReplyWindowMs({}), DEFAULT_CATCHUP_REPLY_WINDOW_MS);
  assert.equal(catchupReplyWindowMs({ onebot: {} }), 30 * 60 * 1000);
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 0 } }), 0, '0 = 一律只补记录，必须是显式生效的值');
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 5 * 60 * 1000 } }), 5 * 60 * 1000);
  // 非法值一律回落默认（和配置里别的数值字段同一口径）
  for (const bad of ['abc', -1, NaN, null, '', {}]) {
    assert.equal(
      catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: bad } }),
      DEFAULT_CATCHUP_REPLY_WINDOW_MS,
      `非法值 ${JSON.stringify(bad)} 应回落默认`
    );
  }
  assert.equal(catchupReplyWindowMs({ onebot: { catchupReplyWindowMs: 7 * 24 * 3600 * 1000 } }), MAX_CATCHUP_REPLY_WINDOW_MS);
});

test('isFreshForReply：正好等于窗口算新（边界），窗口 0 一律不算', () => {
  const now = 1_000_000_000;
  const windowMs = 30 * 60 * 1000;
  assert.equal(isFreshForReply(now - windowMs, now, windowMs), true);
  assert.equal(isFreshForReply(now - windowMs - 1, now, windowMs), false);
  assert.equal(isFreshForReply(now, now, windowMs), true);
  assert.equal(isFreshForReply(now - 1, now, 0), false);
});

test('日志行：有只补记录的条数时两个数都写出来；0 条返回空串', () => {
  assert.equal(catchupLogLine('group:1', 0, 0), '', '没有补进任何消息时不打日志');
  const plain = catchupLogLine('group:1', 3, 0);
  assert.match(plain, /补进 3 条（重启\/断线期间漏掉的）$/);
  const mixed = catchupLogLine('group:1', 5, 2);
  assert.match(mixed, /补进 5 条/);
  assert.match(mixed, /其中 2 条超过回复窗口，只补记录、不回复/);
  assert.match(catchupLogLine('group:1', 5, 5), /全部超过回复窗口，只补记录、不回复/,
    '全都超窗时说"全部"，不是"其中 5 条"');
});

test('app.js 的补课路径确实走这三个函数（不是又写死一套）', () => {
  const source = fs.readFileSync(path.join(repo, 'src/console/app.js'), 'utf8');
  const start = source.indexOf('async function catchUpMissedMessages()');
  assert.ok(start > 0, 'catchUpMissedMessages 应还在（结构变了就更新这条用例）');
  const body = source.slice(start, source.indexOf('\n  }', start));
  assert.match(body, /catchupReplyWindowMs\(cfgNow\)/, '窗口要从配置读，不能写死 30 分钟');
  assert.match(body, /isFreshForReply\(ts, Date\.now\(\), windowMs\)/);
  assert.match(body, /catchupLogLine\(chatKey, added, recordedOnly\)/);
  assert.doesNotMatch(body, /30 \* 60 \* 1000/, '不许在补课路径里留写死的半小时');
  const imports = source.slice(0, source.indexOf('const router'));
  assert.match(imports, /catchupReplyWindowMs, catchupLogLine, isFreshForReply/);
});
