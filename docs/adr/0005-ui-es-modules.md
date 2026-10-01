# ADR 0005：ui/ 全量转 ES module（B 档 Step 2 落地）

- 状态：已定（**取代** [ADR 0004](0004-ui-classic-script-and-registry.md) 决策 2「保留 classic script 的加载方式」；
  ADR 0004 的其余决策（不抽 `core/lifecycle.js`、去插件化走 QARegistry、契约冻死）继续有效）
- 日期：2026-10-01

## 背景

`ui/app.js` 从 13,130 行拆成 `core/*` + `pages/*`（30 个 classic script）之后，跨文件引用变成
一份 249 条的 `uiSharedGlobals` 清单 + 一条"引用必须在清单里"的契约。外部评审指出：
**耦合没有减少，只是显性化了** —— 那 249 条清单就是将来转 import 时的转换表。
ADR 0004 当时把 B 档（ESM 化 + 按域拆）按改进方案 §11.4 的触发条件推迟；其中 Step 3（按域拆）
已经在拆分里落地，去插件化（C2）也完成了，剩下 Step 2（ESM 化）。

§11.4 的触发条件是「① 要新加第三个以上页面/大区块时；② UI 改动的 review/diff 开始让你花超过
10 分钟；③ 出现第二个长期维护者」。① 在拆分与外挂外迁里反复发生，② 也已经发生（13k 行的拆分
diff 需要独立核对守恒才能确认）—— 按这两条判断，这一步早该做。

## 实测（2026-10-01，转换**前**）

| 事实 | 数值 |
| --- | --- |
| 文件 / 顶层声明 | 30 / 379 |
| 跨文件引用 | 476 个名字次，涉及 162 个文件对 |
| import 环 | 17 个文件在环上（`core/state.js` ↔ `app.js` ↔ `pages/*` ↔ `core/format.js` …） |
| 跨文件**写** | 38 处 / 19 个可变单元 —— ES module 的 import 绑定**只读**，写它就是 `TypeError` |
| 模块求值期的跨文件引用 | 只有 `core/state.js` 的 `$`，与 `app.js` 的 8 个 `*Impl` + `$`/`$$` + `startListPoller()` |

## 决策

1. **一个文件一个 module，index.html 保留 30 个 `<script type="module">`**（不改成单入口）。
   外挂插件因此仍然"丢个文件 + 加一行标签"就能上；单入口要求 app.js 去 import 插件，会把
   "外挂 → app"的方向反过来 —— ADR 0004 决策 3 刚把耦合方向理顺，不该在这里倒回去。
   文档顺序保留（它是**可读性分层**）；求值顺序由 import 图决定，不再依赖标签先后。
2. **转换只做加法**：文件顶部按引用生成 `import` 块、尾部按"被别的文件引用"的集合生成
   `export { … }` 块，已有语句一行不动 —— 守恒可以逐字节证明（30/30 逐文件核对通过）。
3. **前置改造先做**（同一里程碑提交 `f5a12e1` 里的前置那一步；历史压缩前是 `3c9e507`）：19 个模块级 `let`（38 处跨文件写）归位成 `state.X`。
   import 绑定不可写，不先做这一步，模块化后第一次点页面就 `TypeError`。
4. **契约从"清单"升级成"没有清单"**：删掉 `uiSharedGlobals`（249 条）与
   `test/ui-contract.test.mjs`，换成 `test/ui-module-graph.test.mjs` 的 6 条 ——
   import 必须解析得通 / 未解析引用只剩浏览器内建 / 不许导出 `let`·`var` / 不许写 import 绑定 /
   求值期跨文件引用不许踩 TDZ / 除 `QARegistry`·`QAText` 外不许往 `window` 上挂东西。
   eslint 的 ui 段改成 `sourceType: 'module'` 且只留浏览器内建 —— `no-undef` / `no-unused-vars`
   从此能真正兜住"漏 import / 拼错名字"（此前被清单掩盖成调用期的静默 `undefined`）。
5. **测试网分两层**：vm 沙箱（render-test / scroll-test / usage-e2e / ui-smoke）继续用
   "剥掉 import/export 按 classic 跑"（`test/helpers/ui-module-source.mjs`）—— 它们测渲染行为，
   剥壳后语义与转换前一致，178/19/31 条断言的含义不变；另加 `test/ui-real-modules.test.mjs`，
   用 Node 的真 ESM 加载器 + happy-dom 的 DOM 全局按**真模块语义**加载整棵树并跑一遍启动。
   真解析、真求值顺序、真 TDZ 只有它能看见（见下）。
6. **js 静态资源不再用 URL 版本令牌**：浏览器按 **URL** 认模块，HTML 里带 `?v=` 的
   `/core/dom.js` 与模块内相对 import 解析出的 `/core/dom.js` 是两个 URL、两份模块实例
   （同一份 `state` 变成两份，页面看着正常、状态不共享，极难查）。js 改为
   `no-cache` + 内容哈希强 ETag 回源校验（真 304 仍然生效）；css/svg/png 不是模块，
   继续 `?v=` + immutable 长缓存。详见 [ADR 0001](0001-no-build-tools.md) 的补记。

## 这次转换实测撞出来的两个坑

1. **模块求值期读 `state` = 白屏。** `core/state.js` ↔ `app.js` ↔ `pages/*` 在同一个 import 环上，
   浏览器实际会先求值 `app.js` 的依赖链，而 app.js 顶层那句 `startListPoller()` 会读 `state`
   → `Cannot access 'state' before initialization`。已把它挪进 `init()`，并把 `init` 改成
   **DOMContentLoaded 之后再跑**（module 是 defer 语义，这个时机是对的）。
   ⚠️ **剥了 import/export 的 vm 沙箱对此全绿** —— 它按 document 顺序执行，那时 `state` 早就初始化了。
   这正是新增 `ui-real-modules` 用例的理由：静态的 TDZ 用例只能看"顶层语句直接引用"，看不见
   "顶层调用了一个函数，函数里读 state"。
2. **静态资源的令牌与模块身份冲突**（决策 6）：上表第 4 行那 38 处跨文件写也是同一类问题
   —— 都是"classic script 的全局词法环境"悄悄提供的便利，模块化后必须换形态。

## 后果

- **耦合的形态变了，不只是条数变了**：249 条共享全局 → 162 条显式 import 边。① 名字必须在文件头
  列出来；② 漏写/写错当场报错（解析失败或 `no-undef`），不再静默 `undefined`；③ 环还在（17 个文件），
  但环上只许放函数声明 —— TDZ 用例盯着。
- **控制台（F12）里不再有 `switchTab` 这类全局**：调试改用 `QARegistry.snapshot()` 与点 DOM
  （`docs/UI-SMOKE.md` 的清单已按这个口径改）。`window.QARegistry` 与 `window.QAText` 是**有意保留**的对外面。
- `'use strict'` 指令序言留在原处（模块恒严格，它已无实际作用，但不惹事 —— 不为了删它再制造一轮 diff）。
- 页面域之间仍会互相调用（`pages/settings-bind.js` 从 16 个文件 import），环没有消除。要不要继续
  理顺，仍按 §11.4 的触发条件判断，别凭"看起来还能更纯"动手。

## 坑 3（2026-10-01，真浏览器烟测抓到）：`document.readyState` 在 module 执行期是 `interactive`

第一版把"等模块图求值完再跑 `init()`"写成：

```js
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();                     // ← 真浏览器走的是这一支
```

看着合理，实际是错的：**HTML 规范的顺序是「解析结束 → 置 readyState = 'interactive' → 跑
defer / module 脚本 → 发 DOMContentLoaded → 置 'complete'」**，所以 module 脚本执行期
`readyState` 已经是 `'interactive'` 了，判据得是"不是 `complete`"，不是"还在 `loading`"。
结果就是 `init()` 在模块求值期执行 → 读 `state` 踩 TDZ → **整页白屏**（和坑 1 同一个报错，
但根因完全不同）。

为什么本地全绿：三套 vm 沙箱是剥壳按 document 顺序跑的（那时 state 早初始化好了）；
而新写的 `ui-real-modules` 里，我把 `readyState` 设成了 `'loading'` —— **照着错的前提去测，
等于没测**。真浏览器一打开就白屏。

修法与加固：

- 判据改成 `if (document.readyState === 'complete') init(); else addEventListener(...)`。
- `ui-real-modules` 里的 `readyState` 对齐成规范里的 `'interactive'`；做了变异验证：
  把判据改回 `'loading'`，该用例立刻红在 `Cannot access 'state' before initialization`。
- **教训（比修法更重要）**：模拟浏览器时序的参数必须来自规范或实测，不能凭"看起来应该"。
  这条也是"任何发版前必须先在服务器部署实测"这条老规矩的价值 —— 三套自动化测试全绿，
  真浏览器照样白屏。
