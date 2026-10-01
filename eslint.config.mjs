// ESLint flat config（改进方案 C1–C3；devDependencies 实际版本见 package.json，当前 ^10）。
// 作用域：src/scripts = node ESM；test = node ESM（node:test 是 import 不是全局）；
// ui = classic script 的浏览器环境（无 import/export，sourceType 必须是 script）。
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

// classic script 时代跨文件共享的全局（定义在 ui/app.js，被 8 个外挂文件引用）。
// 显式声明“这些是有意共享的全局”，而不是豁免规则 —— 改进方案 §1.3 的 25 符号清单。
// B 档 ESM 化完成后这批声明应随之删除（改为显式 import）。
const uiSharedGlobals = {
  // core/api.js 引用它（app.js 顶层 const，经全局词法环境共享）
  CONSOLE_MARKER: 'readonly',
  $$: 'readonly',
  state: 'readonly',
  api: 'readonly',
  esc: 'readonly',
  $: 'readonly',
  fmtTime: 'readonly',
  mulOf: 'readonly',
  fmtTokens: 'readonly',
  setStatusLabel: 'readonly',
  updateOnebotStatusLine: 'readonly',
  onebotIssueText: 'readonly',
  saveMemberNote: 'readonly',
  renderBanner: 'readonly',
  refreshStatus: 'readonly',
  renderLifecycleOverview: 'readonly',
  lifecycleAggregate: 'readonly',
  lifecycleStateOf: 'readonly',
  modelModalShell: 'readonly',
  closeModelModal: 'readonly',
  loadTimeControlStatus: 'readonly',
  loadDailyMomentsStatus: 'readonly',
  loadQzoneInteractionStatus: 'readonly',
  loadExperimentalFeatureStatuses: 'readonly',
  loadIdentityFeaturePage: 'readonly',
  loadIncidentFeaturePage: 'readonly',
  loadFriendFeaturePage: 'readonly',
};

export default [
  { ignores: ['node_modules/**', 'data/**', 'tools/**', '_staging/**'] },
  { files: ['src/**/*.js'], ...nodeScope },
  { files: ['scripts/**/*.mjs'], ...nodeScope },
  { files: ['test/**/*.mjs'], ...nodeScope },
  {
    files: ['ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...uiSharedGlobals },
    },
    rules: baseRules,
  },
  {
    // 共享内核/文案表：定义就是给后续 script 用的，单文件视角必然报"未用"——关掉；
    // max-lines 在此落实（改进方案 #1 A 档第 3 步）：新文件不得超过 1500 行，
    // 老的 ui/app.js 由"只约束 core/pages/features/i18n"这一范围设计天然豁免。
    files: ['ui/core/**/*.js', 'ui/i18n/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
      'max-lines': ['warn', { max: 1500 }],
    },
  },
];
