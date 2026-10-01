# ADR 0004：UI 保持 classic script；跨文件接管走 QARegistry；不抽 `core/lifecycle.js`

- 状态：已定（含一次实测推翻原设计）
- 日期：2026-09-30

## 背景

改进方案 §11 原本要把 `ui/app.js` 里被 `status-refresh.js` 用到的 18 个符号
（`refreshStatus`、`renderLifecycleOverview`、`loadXxxFeaturePage`、`lifecycleStateOf` 等）
搬到新的 `ui/core/lifecycle.js`，目标写的是：

> 把 status-refresh.js 依赖的 18 个符号从「13k 行单体」搬到「一个小而稳的 core 文件」，
> 它从此不依赖 app.js 内部实现。

同时要把 `stable-features.js` / `status-refresh.js` 的"改写全局"换成显式注册（去插件化）。

## 实测（2026-09-30，espree 解析 `ui/app.js`）

- `ui/app.js` 顶层声明 **357** 个（281 个函数 + 76 个 `const/let/var`）。
- 那 18 个种子符号的**传递依赖闭包 = 327 个顶层声明（91.6%）**。
  也就是说：要搬走这 18 个，实际得把几乎整个 `app.js` 搬走 —— 换的只是文件名。
- 反例佐证：`lifecycleAggregate` 依赖 `lifecycleRunsFor`；`refreshStatus` 依赖 `renderBanner`、
  `onebotIssueText`、`setStatusLabel`、`loadTimeControlStatus`…；`loadDailyMomentsStatus`
  一个函数就有 122 行并牵出更多。

## 决策

1. **不抽 `core/lifecycle.js`**。方案 §11 的 C1 前提（"18 个符号可以独立成一个小文件"）不成立
   —— 按它做只是把 13k 行换个文件名，没有解耦，却要承担一次大搬迁的风险。
   §11.1 自己的结论「拆文件本身不解耦」在这里正好适用。
2. **保留 classic script 的加载方式**（见 [ADR 0001](0001-no-build-tools.md)），
   `ui/app.js` 仍是业务主体。
3. **去插件化照做**，落成 `ui/core/registry.js`：
   - `QARegistry.register(name, impl)` —— app.js 在载入时登记 8 个入口的**底座**（`*Impl` 后缀）；
   - `onTransform` / `onAfter` —— `stable-features.js` 的「摘控件 / 渲染后补面板」改走这里；
   - `override(name, fn)` + `base(name)` —— `status-refresh.js` 的三处接管改走这里，
     原实现用 `base(name)` 取回（不再靠 `const x = 全局名` 抓当前值，那种写法序号一错就自递归）；
   - 钩子抛错只记 warn、继续渲染（异常隔离）。
4. **契约冻死**：`test/ui-contract.test.mjs` 断言外挂文件引用的每个跨文件全局都在
   `eslint.config.mjs` 的 `uiSharedGlobals` 里、清单里每个名字都还有定义且确实被别的文件用到；
   同一文件还断言再没有 `window[...] =` / 裸赋值的改写。新增耦合必须显式改清单，会当场红。

## 后果

- 这几个入口的**名字仍在全局**（classic script 的跨文件作用域不变），只是不再被谁改写；
  单点分发的代价是：新增接管者必须用 `QARegistry.override`，直接改全局会被契约用例判红。
- 真正的解耦（把状态渲染与页面渲染分家）没有做，属于**后续要单独设计**的事，
  不是"把函数搬到另一个文件"能解决的。B 档（ESM 化 + 按页面域拆分）的触发条件见改进方案 §11.4，
  且它的第一步（去插件化）已经完成。
- 以后若要再提"抽 lifecycle.js"，先重跑这次测量：闭包没降到可接受规模（比如 < 50），
  就说明前提仍然不成立。

## 补记（2026-10-01）：按域拆完 ui/app.js 后，顺手拆了 core/widgets.js；新增的
`core/lifecycle-labels.js` 与本 ADR 不冲突

这一天 ui/app.js 从 13,130 行拆到 1,019 行（core/* + pages/*，逐声明字节守恒），随后又把这套
拆分里唯一名不副实的文件 `ui/core/widgets.js`（1,606 行）按"谁在用它"拆开：chat 列表与消息渲染
归 `pages/chat.js`、用量页归 `pages/usage.js`、动态与空间状态加载归 `pages/moments.js`、价格弹窗归
`pages/settings.js`、实验功能状态拉取归 `pages/features.js`。它当初是"零依赖叶子"的统一桶，
于是把好几个域的整块渲染装到了一起 —— **教训：按依赖层级分桶会得到"按名字看不出内容"的文件，
按调用方分域才对**。

拆剩 5 个声明（`triggerKindOf`/`triggerKindLabel`/`lifecycleStateOf`/`lifecycleRemainingText`/
`lifecycleRunsFor`）放进新的 `ui/core/lifecycle-labels.js`（40 行）。**它不违反本 ADR 的决策 1**，
按本 ADR 自己给的判据重新量过（声明级引用闭包，2026-10-01，全 ui 379 个顶层声明）：

| 种子 | 闭包规模 |
|---|---|
| 那 5 个叶子 | **8 / 379（2%）** —— 含 `state` 与 `TRIGGER_KIND_LABEL`、`fmtRemainingMs` |
| 本 ADR 当年那批 18 个符号（取 6 个代表） | 329 / 379（87%）—— 与当年记录的 327/357 同量级 |

即：判据是"闭包 < 50 才成立"，5 个叶子（8）成立，当年那 18 个（329）不成立。它们留在 core 层是因为
`core/state.js` 也在用（调用期解析），且被 `pages/status.js`、`pages/sessions.js` 与外挂
`status-refresh.js` 共用。**别再往这个文件里加东西** —— 它不是 lifecycle 域，只是"几个标签/换算
小件"的落脚点。
