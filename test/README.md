# 测试布局

所有用例都在这个目录下，分成四类。跑之前不需要任何额外服务（协议端与模型都是桩件）。

## 1. 单元测试（CI 跑）

```
test/*.test.mjs      # node:test，一个文件管一块（清单看 ls test/*.test.mjs，别写死数量）
```

- 命令：`npm run test:unit`（= `node --test test/*.test.mjs`）
- CI 与发版流程都会跑；**新增用例请放在这里**，文件名用 `*.test.mjs`。
- 需要连真协议端/真模型的用例不要写在这一类：这里必须能在无网、无 docker 的机器上跑。
- 其中 `layout.test.mjs` 是"目录布局不变量"（ROOT 指向仓库根、相对 import 全部可解析、
  硬编码入口没被挪走）——挪文件前后它最先报警。

## 2. 独立脚本（不在 test:unit 里，但 CI 会单独跑）

```
test/test-prompt.mjs    # 提示词自检：拼装结果与各段是否齐全
test/render-test.mjs    # 控制台各设置分区渲染（在 vm + DOM 桩里跑真实 ui/app.js）
test/scroll-test.mjs    # 会话列表滚动与节流
test/usage-e2e.mjs      # 用量页端到端（真起服务 + 真接口，无 mock）
test/selftest.mjs       # 端到端审计：mock OneBot + mock 模型，跑一遍核心流程
```

- 命令：`npm run test:prompt` / `test:render` / `test:scroll` / `test:usage` / `test:legacy-selftest`
- 前四个也在 `npm test` 里串起来跑。
- ⚠️ `render-test.mjs` 与 `usage-e2e.mjs` 会占用 `127.0.0.1:3210`（控制台默认端口）。
  本机开着控制台隧道（`console-tunnel.bat`）时它们会报 `EADDRINUSE`，关掉隧道再跑。

## 3. 本地回归（CI 跑）

```
test/local/run.mjs        # 串行跑下面的用例，自动用临时数据目录
test/local/test-*.mjs     # 发送/贴纸/空间互动/内联兜底等回归
```

- 命令：`npm run test:local`
- **必须用临时 `QQ_AGENT_DATA_DIR`**（`run.mjs` 已经处理）；这些用例会写 config.json，
  指到生产数据目录会把线上配置覆盖掉（血泪教训）。
- 需要真协议端行为的用例写在这里（用桩件模拟工具层）。

## 4. 约定

- 用例自己造临时目录（`mkdtemp`），跑完清理；不要依赖仓库里的 `data/`。
- 不要在用例里读真实凭据或碰网络：需要网络的一律注入 `fetchImpl` 桩件。
- 改完 `src/` 下的相对路径或移动文件，先跑 `layout.test.mjs` 与 `npm run test:local`。
- 在 Windows 上跑 `npm run test:unit` 会有 43 个用例失败（2026-10-01 实测基线，仅 Windows 本机特有：
  docker/systemd/linux 集成类），这是环境差异不是回归；CI（ubuntu-latest）上全量通过。
