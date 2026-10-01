// 本地回归：sender 只对"能确认未送达"的错误重试一次；结果未知的错误不自动重发。
// 用例里的错误用**生产真实形态**（undici: TypeError('fetch failed', { cause })，真因在 cause 上）。
//
// 背景（真实缺陷）：超时 / 连接被重置 / socket hang up / fetch failed 都可能发生在
// "对方已经收下并发出去了"之后；自动重发会让群里出现两条一样的消息，而 outbox 只记一条。
// 所以这类一律按结果未知走 held 人工核对，只有"连不上/被拒"这类确定没送达的才重试。
//
// 用法：
//   T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-sender-retry.mjs
//
// 重要：必须用临时 QQ_AGENT_DATA_DIR（本用例会往里面写 config.json），
//       绝不能指向生产数据目录，否则会覆盖线上配置。
//       下面先给临时 DATA_DIR 种一份放行的 config.json（access.js 的 assertCanSend
//       会按它拦截发送），再动态 import 模块。
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.QQ_AGENT_DATA_DIR;
if (!dataDir) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 指向一个临时目录，例如：T=$(mktemp -d); QQ_AGENT_DATA_DIR=$T node test/local/test-sender-retry.mjs');
  process.exit(2);
}
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  // canRun 三要素：runtime.active + allow 放行 + 时间门放行
  runtime: { mode: 'active', paused: false },
  allow: { private: ['100000001'] },
  allowAllWhenEmpty: true
}));
const { SendQueue } = await import(new URL('../../src/onebot/sender.js', import.meta.url).href);

function makeStore() {
  const sent = [];
  return {
    sent,
    beginSend: () => 'op-' + Math.random().toString(36).slice(2, 8),
    finishSend: (id, info) => sent.push(info && info.messageId ? 'ok' : 'fail'),
    hasUncertainEffects: () => false,
    appendSelf: () => {},
    findByMid: () => null
  };
}

const store = makeStore();

// 用例 1：第一次连接被拒（可确认未送达），第二次成功 → 应该重试并发出
let calls1 = 0;
const onebot1 = {
  async sendText() {
    calls1 += 1;
    // 真实形态：undici 的网络错误 message 恒为 fetch failed，真因在 cause 上
    if (calls1 === 1) {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3390'), { code: 'ECONNREFUSED' })
      });
    }
    return { message_id: 999 };
  }
};
const q1 = new SendQueue({ onebot: onebot1, store });
const r1 = await q1.sendTextBatch('private:100000001', ['网络抖动测试'], {});
console.log('用例1（fetch failed 后重试）: 调用次数=%d 结果=%s', calls1, JSON.stringify(r1.sent));

// 用例 2：非网络错误（限频/参数）不该重试
let calls2 = 0;
const onebot2 = {
  async sendText() {
    calls2 += 1;
    throw new Error('发送频率超限（每分钟最多 80 条），请等一会再发');
  }
};
const q2 = new SendQueue({ onebot: onebot2, store });
let err2 = '';
try { await q2.sendTextBatch('private:100000001', ['限频不该重试'], {}); } catch (e) { err2 = String(e.message); }
console.log('用例2（非网络错误）: 调用次数=%d 报错=%s', calls2, err2.slice(0, 40));

// 用例 3：两次都连接被拒 → 只重试一次，最终抛错
let calls3 = 0;
const onebot3 = {
  async sendText() {
    calls3 += 1;
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3390'), { code: 'ECONNREFUSED' })
    });
  }
};
const q3 = new SendQueue({ onebot: onebot3, store });
let err3 = '';
try { await q3.sendTextBatch('private:100000001', ['一直失败'], {}); } catch (e) { err3 = String(e.message); }
console.log('用例3（连续网络失败）: 调用次数=%d 报错=%s', calls3, err3.slice(0, 40));

// 用例 4：超时（结果未知）不该自动重发——对方可能已经发出去了
let calls4 = 0;
const onebot4 = {
  async sendText() {
    calls4 += 1;
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('The operation was aborted due to timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    });
  }
};
const q4 = new SendQueue({ onebot: onebot4, store });
try { await q4.sendTextBatch('private:100000001', ['超时不该重发'], {}); } catch { /* 预期抛错 */ }
console.log('用例4（超时=结果未知）: 调用次数=%d（应为 1）', calls4);

// 用例 5：协议端 5xx —— 对方可能已经收下请求，属"结果未知"，不该自动重发
let calls5 = 0;
const onebot5 = { async sendText() { calls5 += 1; throw new Error('OneBot send_group_msg HTTP 502'); } };
const q5 = new SendQueue({ onebot: onebot5, store });
try { await q5.sendTextBatch('private:100000001', ['5xx 不该重发'], {}); } catch { /* 预期抛错 */ }
console.log('用例5（5xx=结果未知）: 调用次数=%d（应为 1）', calls5);

console.log(
  (calls1 === 2 && r1.sent.length === 1 ? 'PASS' : 'FAIL') + ' 可确认未送达的错误重试一次; ' +
  (calls2 === 1 ? 'PASS' : 'FAIL') + ' 非网络错误不重试; ' +
  (calls3 === 2 ? 'PASS' : 'FAIL') + ' 最多重试一次; ' +
  (calls4 === 1 ? 'PASS' : 'FAIL') + ' 超时（结果未知）不自动重发; ' +
  (calls5 === 1 ? 'PASS' : 'FAIL') + ' 5xx（结果未知）不自动重发'
);
