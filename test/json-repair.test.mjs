// JSON 修复共享 util 测试（Issue #6 ③）：四类瑕疵 + 组合 + 不可恢复。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { repairJsonObject } = await import('../src/core/json-repair.js');

test('瑕疵 1：代码围栏（```json … ```）', () => {
  const raw = '```json\n{"events":[{"type":"warm_exchange"}]}\n```';
  assert.deepEqual(repairJsonObject(raw), { events: [{ type: 'warm_exchange' }] });
  // 无语言标记的围栏也要剥
  assert.deepEqual(repairJsonObject('```\n{"a":1}\n```'), { a: 1 });
});

test('瑕疵 2：前后缀文本（只取首尾大括号之间）', () => {
  const raw = '好的，评估结果如下：{"events":[]}以上，请查收。';
  assert.deepEqual(repairJsonObject(raw), { events: [] });
});

test('瑕疵 3：尾随逗号（字符串内部的 ",}" 不能被误改）', () => {
  assert.deepEqual(repairJsonObject('{"a":[1,2,],"b":{},}'), { a: [1, 2], b: {} });
  // 字符串里含 ",}" 序列：修复必须字符串感知，不能把内容改坏
  const raw = '{"note":"他说过,}这种话","count":3,}';
  assert.deepEqual(repairJsonObject(raw), { note: '他说过,}这种话', count: 3 });
});

test('瑕疵 4a：单引号包字符串', () => {
  const raw = "{'events':[{'type':'trust_signal','strength':0.5}]}";
  assert.deepEqual(repairJsonObject(raw), { events: [{ type: 'trust_signal', strength: 0.5 }] });
});

test('瑕疵 4b：字符串内未转义双引号（长输出引用原话时高发）', () => {
  const raw = '{"summary":"他说"你好"之后就走了","ok":true}';
  assert.deepEqual(repairJsonObject(raw), { summary: '他说"你好"之后就走了', ok: true });
});

test('组合：围栏 + 尾随逗号 + 单引号 + 未转义引号一次修好', () => {
  const raw = '```json\n{\'events\':[{\'type\':\'repair\',\'summary\':\'他说"算了"\',},],}\n```';
  assert.deepEqual(
    repairJsonObject(raw),
    { events: [{ type: 'repair', summary: '他说"算了"' }] }
  );
});

test('不可修复：返回 null 而不是编造数据', () => {
  assert.equal(repairJsonObject('这不是 JSON'), null);
  assert.equal(repairJsonObject(''), null);
  assert.equal(repairJsonObject(null), null);
  assert.equal(repairJsonObject('{"a":'), null);            // 截断
  assert.deepEqual(repairJsonObject('[1,2,3]'), [1, 2, 3]); // 数组是合法 JSON 容器，原样返回
  assert.equal(repairJsonObject('"just a string"'), null);  // 标量不算
});
