// 每日花费上限（改进方案 #8）：budgetStatus / shouldBlock / shouldDegrade 的边界全测。
// 纯函数，无 IO；跨日重置沿用 usage-today.json 的 dayKey 惰性判定（由 todayUsage 保证，
// 不在这里重复测）。变异对照：把 exceeded 的 >= 改成 > 或用 <= 忽略 enabled，用例必红。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { budgetStatus, shouldBlock, shouldDegrade } = await import('../src/core/budget.js');

const cfg = (budget) => ({ api: { budget } });
const usage = (estimatedYuan, unpricedRuns = 0) => ({ estimatedYuan, unpricedRuns });

test('未超限：exceeded=false，block/degrade 都不生效', () => {
  const c = cfg({ enabled: true, dailyYuan: 20, onExceed: 'block' });
  assert.equal(budgetStatus(c, usage(5)).exceeded, false);
  assert.equal(shouldBlock(c, usage(5)), false);
  assert.equal(shouldDegrade(c, usage(5)), false);
});

test('超限 + degrade：shouldDegrade=true、shouldBlock=false', () => {
  const c = cfg({ enabled: true, dailyYuan: 20, onExceed: 'degrade' });
  assert.equal(budgetStatus(c, usage(25)).exceeded, true);
  assert.equal(shouldDegrade(c, usage(25)), true);
  assert.equal(shouldBlock(c, usage(25)), false);
});

test('超限 + block：shouldBlock=true、shouldDegrade=false', () => {
  const c = cfg({ enabled: true, dailyYuan: 20, onExceed: 'block' });
  assert.equal(shouldBlock(c, usage(20.01)), true);
  assert.equal(shouldDegrade(c, usage(20.01)), false);
});

test('enabled:false（默认口径）：金额再高也不生效——升级零行为变化', () => {
  const c = cfg({ enabled: false, dailyYuan: 1, onExceed: 'block' });
  const s = budgetStatus(c, usage(9999));
  assert.equal(s.exceeded, false);
  assert.equal(shouldBlock(c, usage(9999)), false);
  assert.equal(shouldDegrade(c, usage(9999)), false);
});

test('恰好等于限额：按 >= 判超限（边界含等号）', () => {
  const c = cfg({ enabled: true, dailyYuan: 20, onExceed: 'degrade' });
  assert.equal(budgetStatus(c, usage(20)).exceeded, true);
});

test('限额为 0/非法/缺失：永不判超限（不把 0 当"零预算即封锁"）', () => {
  for (const dailyYuan of [0, -5, Number.NaN, undefined, 'abc']) {
    const c = cfg({ enabled: true, dailyYuan, onExceed: 'block' });
    assert.equal(budgetStatus(c, usage(100)).exceeded, false, `dailyYuan=${dailyYuan} 不应超限`);
  }
});

test('unpricedRuns 透传（防"没价＝永远不超限"的静默失效口径）', () => {
  const c = cfg({ enabled: true, dailyYuan: 20, onExceed: 'degrade' });
  const s = budgetStatus(c, usage(3, 7));
  assert.equal(s.unpricedRuns, 7);
  assert.equal(s.spentYuan, 3);
  assert.equal(s.limitYuan, 20);
});

test('onExceed 非法值回退 degrade；缺配置整个 budget 段时不抛', () => {
  assert.equal(budgetStatus(cfg({ enabled: true, dailyYuan: 20, onExceed: 'whatever' }), usage(30)).onExceed, 'degrade');
  assert.equal(shouldDegrade(cfg({ enabled: true, dailyYuan: 20, onExceed: 'whatever' }), usage(30)), true);
  assert.doesNotThrow(() => budgetStatus({}, {}));
  assert.equal(shouldBlock({}, {}), false);
});
