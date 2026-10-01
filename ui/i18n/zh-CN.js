// 控制台文案框架（改进方案 #12-4）：classic script 形态，挂 window.QAText。
// 约定：**新代码必须走 QAText.t(key)**，旧文案每批迁移一部分（先搬设置页 sidebar 做样板）。
// 未登记的 key 原样返回（便于发现漏登记），支持 {var} 插值。
(function () {
  'use strict';
  const table = {
    // 样板迁移**尚未开始**（2026-09-30 审查修正：此前注释声称"已迁移的调用点见
    // renderSettingsSidebar/switchTab"，实际全仓 QAText 调用为 0，注释在骗人）。
    // 约定：新代码必须走 t()；迁移旧文案时在此登记 key，并从调用点删掉硬编码文本。
  };

  function t(key, vars) {
    let text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  window.QAText = { t, table, locale: 'zh-CN' };
})();
