// 每日花费上限（改进方案 #8；设计决策见方案附录 J.3）。
// 口径：按**估算价**（estimateCost 的当日累计）判断，不产生任何实际扣费动作；
// 配置默认 enabled:false —— 升级不改变任何行为。跨日重置沿用 usage-today.json 的
// dayKey 惰性判定（现有机制），estimatedYuan 并入同一结构一并清零。
//
// 无价口径（J.3）：价格缺失的运行按 0 计入，但必须暴露 unpricedRuns 计数 ——
// 控制台与超限通知都要显示「有 N 次运行未计价」，防"没价＝永远不超限"的静默失效。

export function budgetStatus(cfg, usage) {
  const b = cfg?.api?.budget || {};
  const enabled = b.enabled === true;
  const dailyYuan = Number(b.dailyYuan);
  const limitYuan = Number.isFinite(dailyYuan) && dailyYuan > 0 ? dailyYuan : 0;
  const spentYuan = Number(usage?.estimatedYuan) || 0;
  const unpricedRuns = Number(usage?.unpricedRuns) || 0;
  const onExceed = b.onExceed === 'block' ? 'block' : 'degrade';   // 非法值回退默认策略
  return {
    enabled,
    limitYuan,
    spentYuan,
    unpricedRuns,
    // 限额非正数时永不判超限（宁可不管，也不能把 0 当成"零预算即封锁"）
    exceeded: enabled && limitYuan > 0 && spentYuan >= limitYuan,
    onExceed,
    notify: b.notify !== false
  };
}

export function shouldBlock(cfg, usage) {
  const s = budgetStatus(cfg, usage);
  return s.exceeded && s.onExceed === 'block';
}

export function shouldDegrade(cfg, usage) {
  const s = budgetStatus(cfg, usage);
  return s.exceeded && s.onExceed === 'degrade';
}
