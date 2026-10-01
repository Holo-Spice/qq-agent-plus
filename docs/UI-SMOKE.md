# 控制台手工烟测清单（UI-SMOKE）

自动化只覆盖到「渲染函数不抛异常 + 真实 DOM 能加载 + 钩子接上了」这三层
（`test/render-test.mjs` 176 条、`test/scroll-test.mjs` 19 条、`test/ui-smoke.test.mjs`
4 条、`test/ui-contract.test.mjs`、`test/ui-modules.test.mjs`）。**布局、事件、真实数据下的
观感只有人看得见**，所以每次动到 `ui/` 就照下面走一遍。

打开方式见 [`../AGENTS.md`](../AGENTS.md)（`console-tunnel.bat` 或
`SSHHOST=user@host node src/ops.js console --open`）。

## 0. 前置

- [ ] 页头没有「控制台已更新 · 点击刷新」的黄条（有就说明拿到的还是旧 JS，先刷新）
- [ ] 浏览器控制台（F12）没有任何红色报错；`console.warn` 里没有 `[QARegistry]` 开头的行
      —— 出现 `[QARegistry] xxx 抛错，已跳过该钩子` 就是某个插件钩子挂了（页面不会白，但那段改造没生效）
- [ ] 在控制台里执行 `QARegistry.snapshot()`：`bases` 应有 8 个入口、`overrides` 应有 3 个
      （`refreshStatus` / `renderLifecycleOverview` / `loadFriendFeaturePage`）、
      `transforms` 应有 `renderExperimentalSettingsSection`、`afters` 应有 4 个渲染页

## 1. 顶栏与总览

- [ ] OneBot 状态点/文字正常；鼠标悬停能看到失败原因（未连接时）
- [ ] 「模型 / 今日用量 / 搜索」三段文字不换行、不被截断（窄窗口拉伸一次再看）
- [ ] 暂停按钮文字在「暂停 / 恢复」间正确切换
- [ ] 生命周期卡片（有 lifecycle 会话时）底部显示「结束原因」—— 这是
      `status-refresh.js` 的 `renderLifecycleOverview` 接管在起作用

## 2. 设置页（去插件化的主要风险面）

- [ ] 左侧 16 个分区都能点开，切页不残留上一页的内容
- [ ] **页面顶部有「全局管理员 QQ」面板**（`renderSettings` 的 after 钩子），
      填一个非法值（如 `abc`）保存 → 就地提示「必须为 5 到 15 位数字」，不发请求
- [ ] **「设置 → 实验功能」里看不到已转正/退役的控件**
      （`renderExperimentalSettingsSection` 的 transform 钩子）：
      人物统一印象、主动好友、黑话试点、异常处理试点这四项的"启停"开关不应出现
- [ ] 「设置 → 实验功能」里没有"黑话研究"那一段（同一钩子顺带摘掉的）
- [ ] 设置页滚动到底，所有区块都渲染完整（没有半截 html）

## 3. 人物印象 / 好友管理 / 异常

- [ ] 三个页面打开都有内容，且**没有区域被整块删除**
- [ ] 人物印象页与异常页出现的是「人物印象」「异常处理」字样（钩子改过的文案），
      不是「统一身份库」「异常处理试点」
- [ ] 好友管理页右上角有「手动触发评分」按钮（`loadFriendFeaturePage` 接管加的），
      点开弹窗能列出身位库里的人；`state.config` 未加载时按钮为灰
- [ ] 好友候选/入站申请的旧「owner」输入框已被隐藏成 hidden input（不应再看到可编辑的旧输入框）

## 4. 会话页 / 存档页

- [ ] 会话列表按 key 增量更新：连点刷新，行的 DOM 不整块重建（不闪）
- [ ] 存档页滚到底能继续加载更早的消息；切群时旧请求晚回来不会覆盖新群
- [ ] 未提交树部署时「当前版本」显示「未提交版本 · 时间」，不是被截断的串

## 5. 改完 UI 之后

- [ ] `npm run lint`（0 error / 0 warning）
- [ ] `node test/render-test.mjs` → ALL PASSED 176
- [ ] `node test/scroll-test.mjs` → ALL PASSED 19
- [ ] `node --test test/ui-smoke.test.mjs test/ui-contract.test.mjs test/ui-registry.test.mjs test/ui-modules.test.mjs`
- [ ] 新增跨文件全局时，**同时**改 `eslint.config.mjs` 的 `uiSharedGlobals` ——
      不改会被 `test/ui-contract.test.mjs` 当场判红（这是有意的）
