# ADR 0001：不引入构建工具与前端框架

- 状态：已定（长期有效）
- 日期：2026-09-30（补记已有决策）

## 背景

控制台前端是 `ui/index.html` + 一整套 ES module（`i18n` → `core/*` → `pages/*` → 外挂；
2026-10-01 之前是 12 个 classic script，见 [ADR 0005](0005-ui-es-modules.md)），
没有打包器、没有框架、没有类型系统。（模块个数不在这里抄：清单就是 `ui/index.html` 里的
`<script type="module">` 列表，数它或跑 `test/ui-module-graph.test.mjs` 都行 —— 这行原先写
"30 个"，加一个模块就旧了。）`ui/app.js` 单文件约 13,000 行（决策当时；拆分经过见 ADR 0004/0005 的补记）。

## 决策

**不引入 Vite / webpack / React / TypeScript / jsdom 这类需要构建链或额外运行时的东西。**

允许的例外只有两类，都只影响开发与 CI，不进生产：

- `devDependencies`（当前 `eslint`、`globals`、`happy-dom`）—— 生产目录用
  `npm ci --omit=dev --ignore-scripts` 安装（`deploy.sh`），更新器同样走 `--omit=dev`，
  所以两条路径都不会把开发依赖带进线上；
- 用 Node 内建能力替代框架的部分（`node --test`、`node:sqlite`、`src/ops.js` 的自研扫描）。

## 理由

1. **部署形态决定代价**：线上是「一个源码树 + 系统自带 Node 直接跑」，`deploy.sh` 只做
   rsync + `npm ci`。加构建器就要在部署机上装工具链、加构建步骤、加产物同步，
   换来的收益在一人维护、低并发的前提下很小。
2. **静态资源已经解决了缓存问题**：控制台对每个文件做 `no-cache` + ETag 条件请求
   （`src/console/app.js` 的静态服务），所以拆模块不需要内容哈希，也不需要构建步骤。
   *（2026-10-01 更正：这条前提**实测证伪** —— ETag 只发不判，条件请求从未生效；
   见文末补记。结论「不引构建工具」不变。）*
3. **失败模式简单**：没有构建产物 = 没有「源码改了但产物没更新」这一类问题；
   线上排查时浏览器里跑的就是仓库里的文件，逐字节可比对。

## 后果

- `ui/` 的模块化靠 ES module 原生能力（classic script 时期只能靠其作用域规则）——
  跨文件共享必须显式（见 [ADR 0004](0004-ui-classic-script-and-registry.md)、[ADR 0005](0005-ui-es-modules.md)）。
- 需要类型信息的规则（如 `no-floating-promises`）用不了，改用人工评审 + 自研扫描兜底。
- `ui/app.js` 的体积只能靠约定控制（`max-lines` 对整个 `ui/` 1800 行、新页新文件），
  不靠工具自动拆分。
- *（2026-10-01）* 静态资源的缓存与"版本令牌"在**服务端下发时**处理，仍然没有构建步骤：
  见下。

## 补记（2026-10-01）：条件请求此前从未生效；内容哈希改在服务端下发时做

**实测**（线上跑着该批里程碑时的 `curl -D - -o /dev/null`）：`/core/format.js` 返回
`cache-control: no-cache` 与 `etag: W/"6874-1a0f5170ef4"`，但**带上 `If-None-Match` 再请求仍回
200 + 全文 26740 字节** —— 静态服务只写 ETag、从不判 `If-None-Match`/`If-Modified-Since`。
于是 `no-cache`（强制回源）+ 永远 200（不 304）= 每开一次控制台就把整套脚本整个重下一遍。
（**这是修之前的状态**；下面第 2 条已把它改掉 —— 真 304 与内容哈希长缓存都已生效。）
ADR 原文"静态资源已经解决了缓存问题"在这一点上不成立。

**决策（不动"不引构建工具"这条）**：在 `handleHttp` 的静态分支里补齐两件事，都不需要构建步骤：

1. **真 304**：`If-None-Match` 命中即 304（HTML 与资产都认）；非 HTML 文件在没有
   `If-None-Match` 时也认 `If-Modified-Since`。
2. **内容哈希长缓存**：下发 `index.html` 时把自家资源（`/x.js`、`/x.css`、`/x.svg`、`/x.png`）
   改写成 `?v=<文件内容 sha256 前 12 位>`；带对令牌的请求回
   `public, max-age=31536000, immutable` + 强 ETag，没带/带错则退回 `no-cache` 回源校验
   （旧 URL 钉不住旧脚本）。令牌按 `(size, mtime)` 记忆，不改写外链。
   HTML 的 ETag 取**改写后字节**的哈希 —— 这样"脚本变了、HTML 自己没变"也会换 ETag，
   浏览器不会攥着旧 HTML 里的旧令牌不放。

**代价**：HTML 每次请求都要过一遍 ~15KB 的正则改写（按 `(size,mtime)` 记忆的令牌计算，
实际很轻）；换来的是首屏之后资产零请求。测试见 `test/static-cache.test.mjs`
（6 例 + 6 条变异：不改写 / 令牌改用体积+时间 / 不校验令牌一律 immutable / 去掉 304 /
HTML 也认 If-Modified-Since / HTML 的 ETag 改成体积+时间 —— 逐条都会红）。

**同一次改动还更正了两处文档漂移（2026-10-01）**：

- 后果里那句"`max-lines` 对新增目录 **1800** 行"——原写 **1500**（方案 §11 的数）。
  是拆分那次（现为里程碑提交 `ac012ec`「ui/app.js 拆分」；历史压缩前是 `9c7c43a`）提上去的，理由是当时按依赖层级抽出的叶子桶 `ui/core/widgets.js`
  出来就 1606 行；那一桶随后按调用方拆开了，但设置页绑定的四段合计 1536 行 > 1500，
  再切只能是任意切分，故保留 1800（仍在 13k 量级之下）。**这个改动当时只写在提交信息里，
  现在补记在此**：阈值沿革 = 方案 1500 → 拆分时 1800（原因如上）。
  桌面上限还剩多少，**跑一遍 lint 或 `wc -l` 就有**，这里不再抄具体数字 —— 这一行原先写
  "当前最长 `ui/pages/settings-bind.js` 1787 行、离上限只剩 13 行"，写下当天就被
  `d747308`（拆出 `ui/pages/key-toggles.js`）带旧了，是**第三个**栽在"派生数字"上的注释。
  真要加代码进设置页，先 `wc -l ui/pages/settings-bind.js` 看还剩多少。
  （教训：这类"当前最长/当前行数"是**派生数字**，别手抄；要么改成过去时，要么指一条命令。）
- `eslint.config.mjs` 里"ui/app.js（骨架，5000+ 行）…… 豁免"已经过期：app.js 已缩到千行量级
  （同一数字问题，见上；`wc -l ui/app.js` 为准），
  按那句"缩到阈值以内后才纳入约束"自己的规矩，`max-lines` 的作用域已从
  `core/pages/i18n` 扩到**整个 `ui/`**（含 app.js 与 8 个外挂插件，最大的 `global-memory.js` 377 行）。
  同时把 eslint 的两条覆盖拆开：`no-unused-vars: off` 仍只给 `core/pages/i18n`（它们的定义
  是给别的 script 用的），别把 app.js 与插件并进去——那会让业务/插件代码的未用变量失守。
  *（2026-10-01 补：ESM 化后这条 `no-unused-vars: off` 覆盖已整体删除 —— 跨文件引用改为 `import`，
  不再有"定义是给别的 script 用的"这回事，`no-unused-vars` 对 `ui/**` 整体是硬门禁。）*

**补记（2026-10-01）：ui/ 转 ES module 之后，js 不再走 URL 令牌（模块身份优先于缓存命中）**

同一天 ui/ 全量转成 ES module（见 [ADR 0005](0005-ui-es-modules.md)）。这让上面第 2 条
"内容哈希长缓存"**对 js 失效**，原因是浏览器按 **URL** 认模块：

- `index.html` 里被改写成 `/core/dom.js?v=abc` 的标签，与模块内相对 import（`./dom.js`）解析出的
  `/core/dom.js`（相对路径解析不受父 URL 查询串影响）是**两个不同的 URL** → 各自求值一次 →
  同一份 `state` 变成两份实例：页面看着正常，状态不共享，排查起来极痛苦。
- 反过来，如果让服务端去改写模块内的 import specifier 带上同样的令牌，也能做到 URL 唯一，
  但那要求服务端解析 JS 源码；一旦漏掉某种 specifier 形态（`import './x.js'`、多行 import、
  将来有人写 `export … from`），**静默**退化成上面的双实例 —— 这个失败模式太贵。

所以定成：**js 不带版本令牌**，走 `no-cache` + 内容哈希**强** ETag 回源校验（真 304 仍然生效，
只是每次开控制台会多一轮条件请求）；`css`/`svg`/`png` 不是模块，继续 `?v=` + immutable 长缓存。
`test/static-cache.test.mjs` 已按这套口径重写（含一条"js 就算带了内容哈希也不给 immutable"）。

顺带记一条与"无构建工具"的关系：转 module 没有动摇本 ADR 的决策 —— ES module 是浏览器原生能力，
仓库里跑的仍就是浏览器里跑的（逐字节可比对），没有引入打包/转译步骤。
