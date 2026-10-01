// ESLint flat config（改进方案 C1–C3；devDependencies 实际版本见 package.json，当前 ^10）。
// 作用域：src/scripts = node ESM；test = node ESM（node:test 是 import 不是全局）；
// ui = 浏览器 ES module（2026-10-01 起跨文件引用靠 import，所以 sourceType 是 module）。
// tools/ 与 data/ 是本地未跟踪目录，不进 lint。
import globals from 'globals';

// 全部规则 error（no-unused-vars 也已在 2026-09-30 的清零批次里清到 0 ——
// 含删除 ui/app.js 的 5 个上游遗产零调用函数及其配套死代码；此后 no-unused-vars
// 是硬门禁，新增未用变量会直接红）。
// caughtErrors:'none'：catch (e) 不用 e 无罪，空 catch 由 no-empty(error) 盯住。
const baseRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true, caughtErrors: 'none' }],
  // no-empty 自 C2 起为 error：空块必须写明“有意忽略”的原因
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
  'no-prototype-builtins': 'error',
};

const nodeScope = {
  languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  rules: baseRules,
};

// ui/ 已是 ES module（2026-10-01，B 档 Step 2）：跨文件引用一律走显式 import，不再有
// "靠全局词法环境共享的名字"。原先那份 uiSharedGlobals 清单已随转化删除（它既是 lint 的
// globals，也是 test/ui-contract.test.mjs 冻结的耦合契约）；契约换成更强的一层：
// ui/**/*.js 的**未解析引用（除浏览器内建）必须为空** —— test/ui-module-graph.test.mjs。
// 有意留在 window 上的只剩两个显式赋值：core/registry.js 的 QARegistry、i18n/zh-CN.js 的 QAText。

export default [
  { ignores: ['node_modules/**', 'data/**', 'tools/**', '_staging/**'] },
  { files: ['src/**/*.js'], ...nodeScope },
  { files: ['scripts/**/*.mjs'], ...nodeScope },
  { files: ['test/**/*.mjs'], ...nodeScope },
  {
    files: ['ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // 只留浏览器内建：跨文件名字现在靠 import，no-undef 因此能真正兜住"漏 import / 拼错名字"
      // （原先被 uiSharedGlobals 清单掩盖，写错只在调用期静默 undefined）。
      globals: { ...globals.browser },
    },
    rules: baseRules,
  },
  {
    // 体积闸门（改进方案 §11）：**ui/ 下每个文件**都不得超过 1800 行。
    // 2026-10-01 现状：app.js 1019（它已从 13,130 行的单体缩成骨架，按它自己的规矩纳入约束）、
    // 最长的是 ui/pages/settings-bind.js 1756（设置页绑定：调度器 + 四段切出来的绑定块）。
    // 阈值沿革：方案原写 1500，第一次拆分时提到 1800 —— 因为按依赖层级抽出的叶子桶
    // （core/widgets.js）出来就是 1606 行；那一桶现已按调用方拆开，但设置页绑定的四段本身
    // 合计 1536 行 > 1500，再往下切只能是任意切分，所以保留 1800（仍在 13k 量级之下）。
    files: ['ui/**/*.js'],
    rules: {
      'max-lines': ['warn', { max: 1800 }],
    },
  },
];
