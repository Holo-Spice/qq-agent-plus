// ESLint 9 flat config（改进方案 C1–C3）。
// 作用域：src/scripts = node ESM；test = node ESM（node:test 是 import 不是全局）；
// ui = classic script 的浏览器环境（无 import/export，sourceType 必须是 script）。
// tools/ 与 data/ 是本地未跟踪目录，不进 lint。
import globals from 'globals';

// C3 起升 error 的规则。no-unused-vars 有意保持 warn：79 条里既有真死代码也有疑似
// 漏接线（ui/app.js 的 renderHealthCard/bindModelDdDismiss/renderProviderColumn/
// renderModelColumn/applyProviderPick 五个零调用函数，要人工判断是删还是补绑定），
// 不适合随 lint 批机械处理；清单独行推进（见 C3 commit 说明）。
// caughtErrors:'none'：catch (e) 不用 e 无罪，空 catch 由 no-empty(error) 盯住。
const baseRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'after-used', ignoreRestSiblings: true, caughtErrors: 'none' }],
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
];
