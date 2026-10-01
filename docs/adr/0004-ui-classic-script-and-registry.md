# ADR 0004：UI 保持 classic script；跨文件接管走 QARegistry；不抽 `core/lifecycle.js`

- 状态：**决策 2（保留 classic script）已被 [ADR 0005](0005-ui-es-modules.md) 取代**（2026-10-01 ui/ 全量转 ES module）；
  决策 1（不抽 `core/lifecycle.js`）、决策 3（去插件化走 QARegistry）、决策 4（契约冻死）继续有效
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
   （2026-10-01 更新：`test/ui-contract.test.mjs` 与 `uiSharedGlobals` 已随 ESM 化删除，契约升级为
   `test/ui-module-graph.test.mjs`，详见文末补记与 [ADR 0005](0005-ui-es-modules.md)；
   "契约冻死"这条决策本身继续有效。）

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
`lifecycleRunsFor`）放进新的 `ui/core/lifecycle-labels.js`（40 行；2026-10-01 ESM 化后 56 行）。**它不违反本 ADR 的决策 1**，
按本 ADR 自己给的判据重新量过（声明级引用闭包，2026-10-01，全 ui 379 个顶层声明）：

| 种子 | 闭包规模 |
|---|---|
| 那 5 个叶子 | **8 / 379（2%）** —— 含 `state` 与 `TRIGGER_KIND_LABEL`、`fmtRemainingMs` |
| 本 ADR 当年那批 18 个符号（取 6 个代表） | 329 / 379（87%）—— 与当年记录的 327/357 同量级 |

即：判据是"闭包 < 50 才成立"，5 个叶子（8）成立，当年那 18 个（329）不成立。它们留在 core 层是因为
`core/state.js` 也在用（调用期解析），且被 `pages/status.js`、`pages/sessions.js` 与外挂
`status-refresh.js` 共用。**别再往这个文件里加东西** —— 它不是 lifecycle 域，只是"几个标签/换算
小件"的落脚点。

## 补记（2026-10-01）：决策 2 被推翻 —— ui/ 已全量转 ES module

同一天稍晚，ui/ 的 30 个文件全部转成 ES module（每个文件独立 module、index.html 保留 30 个
`<script type="module">`、按引用生成 import/export）。决策与实测见
[ADR 0005](0005-ui-es-modules.md)。

触发条件按本仓库改进方案 §11.4 自己的口径核对：「① 要新加第三个以上页面/大区块」在拆分与
外挂外迁里反复发生、「② UI 改动的 review/diff 开始花超过 10 分钟」也已发生（13k 行的拆分 diff
要靠独立核对逐字节守恒才敢确认）—— 两条都成立，即"早该做"。

本 ADR 里仍然成立的几条，别连带推翻：

- **决策 1（不抽 `core/lifecycle.js`）与上面那张闭包表**照旧：判据是"声明级引用闭包 < 50 才成立"，
  ESM 化不改变这个测量本身；`core/lifecycle-labels.js` 依然是"几个标签/换算小件"的落脚点。
- **决策 3（接管走 QARegistry）**：转换后更是唯一通道 —— 模块的绑定是只读的，`window[name] = wrapped`
  和裸赋值连"碰巧生效"的机会都没有了。`core/registry.js` 现在把 `QARegistry` 作为 module 显式 export
  （ui/ 内部一律 `import { QARegistry }`），`window.QARegistry` 仍留一份，是有意保留的对外面。
- **决策 4（契约冻死）**：这条被**升级**而不是取消 —— 原先冻的是"249 条共享全局清单"
  （`uiSharedGlobals` + `test/ui-contract.test.mjs`），现在清单整个删掉，换成
  `test/ui-module-graph.test.mjs`：import 必须解析得通、未解析引用只剩浏览器内建、
  不许导出 let/var、不许写 import 绑定、求值期不踩 TDZ、除 `QARegistry`·`QAText` 外不许挂 window。
  换句话说：以前是"新增耦合必须登记"，现在是"根本不允许悄悄长出来"。
