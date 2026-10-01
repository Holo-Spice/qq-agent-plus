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
3. **失败模式简单**：没有构建产物 = 没有「源码改了但产物没更新」这一类问题；
   线上排查时浏览器里跑的就是仓库里的文件，逐字节可比对。

## 后果

- `ui/` 的模块化只能靠 ES module 原生能力与 classic script 的作用域规则 ——
  跨文件共享必须显式（见 [ADR 0004](0004-ui-classic-script-and-registry.md)）。
- 需要类型信息的规则（如 `no-floating-promises`）用不了，改用人工评审 + 自研扫描兜底。
- `ui/app.js` 的体积只能靠约定控制（`max-lines` 对新增目录 1500 行、新页新文件），
  不靠工具自动拆分。
