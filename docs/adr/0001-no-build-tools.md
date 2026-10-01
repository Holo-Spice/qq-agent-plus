# ADR 0001：不引入构建工具与前端框架

- 状态：已定（长期有效）
- 日期：2026-09-30（补记已有决策）

## 背景

控制台前端是 `ui/index.html` + 12 个 classic script（`i18n` → `core/*` → `app.js` → 8 个外挂），
没有打包器、没有框架、没有类型系统。`ui/app.js` 单文件约 13,000 行。

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

- `ui/` 的模块化只能靠 ES module 原生能力与 classic script 的作用域规则 ——
  跨文件共享必须显式（见 [ADR 0004](0004-ui-classic-script-and-registry.md)）。
- 需要类型信息的规则（如 `no-floating-promises`）用不了，改用人工评审 + 自研扫描兜底。
- `ui/app.js` 的体积只能靠约定控制（`max-lines` 对新增目录 1800 行、新页新文件），
  不靠工具自动拆分。
- *（2026-10-01）* 静态资源的缓存与"版本令牌"在**服务端下发时**处理，仍然没有构建步骤：
  见下。

## 补记（2026-10-01）：条件请求此前从未生效；内容哈希改在服务端下发时做

**实测**（线上 5ce8550，`curl -D - -o /dev/null`）：`/core/format.js` 返回
`cache-control: no-cache` 与 `etag: W/"6874-1a0f5170ef4"`，但**带上 `If-None-Match` 再请求仍回
200 + 全文 26740 字节** —— 静态服务只写 ETag、从不判 `If-None-Match`/`If-Modified-Since`。
于是 `no-cache`（强制回源）+ 永远 200（不 304）= 每开一次控制台就把 30 个脚本整个重下一遍。
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
（5 例 + 6 条变异：不改写 / 令牌改用体积+时间 / 不校验令牌一律 immutable / 去掉 304 /
HTML 也认 If-Modified-Since / HTML 的 ETag 改成体积+时间 —— 逐条都会红）。

**同一次改动还更正了两处文档漂移（2026-10-01）**：

- 后果里那句"`max-lines` 对新增目录 **1800** 行"——原写 **1500**（方案 §11 的数）。
  是拆分那次（`9c7c43a`）提上去的，理由是当时按依赖层级抽出的叶子桶 `ui/core/widgets.js`
  出来就 1606 行；那一桶随后按调用方拆开了，但设置页绑定的四段合计 1536 行 > 1500，
  再切只能是任意切分，故保留 1800（仍在 13k 量级之下）。**这个改动当时只写在提交信息里，
  现在补记在此**：阈值沿革 = 方案 1500 → 拆分时 1800（原因如上），当前最长文件
  `ui/pages/settings-bind.js` 1756 行，在限内。
- `eslint.config.mjs` 里"ui/app.js（骨架，5000+ 行）…… 豁免"已经过期：app.js 现在 1019 行，
  按那句"缩到阈值以内后才纳入约束"自己的规矩，`max-lines` 的作用域已从
  `core/pages/i18n` 扩到**整个 `ui/`**（含 app.js 与 8 个外挂插件，最大的 `global-memory.js` 372 行）。
  同时把 eslint 的两条覆盖拆开：`no-unused-vars: off` 仍只给 `core/pages/i18n`（它们的定义
  是给别的 script 用的），别把 app.js 与插件并进去——那会让业务/插件代码的未用变量失守。
