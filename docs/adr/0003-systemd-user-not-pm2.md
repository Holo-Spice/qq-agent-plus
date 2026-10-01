# ADR 0003：用 systemd user 服务托管，不用 PM2 / 面板的 Node 项目

- 状态：已定（硬约束）
- 日期：2026-09-30（补记已有决策）

## 背景

部署形态是「一个非 root 服务用户 + 一个源码目录 + 系统自带 Node」。
宝塔 / aaPanel 这类面板默认会提供「Node 项目」托管（底层是 PM2 或面板自己的守护）。

## 决策

**进程由 `systemctl --user` 的用户服务托管**（`qq-agent-linux.service`），
`manage.sh` 只依赖 `systemctl --user`；**部署不得以 root 运行**（`deploy-all.sh` 直接拒绝），
**不使用 PM2**，也不用面板的 Node 项目启动方式。

## 理由

1. **权限边界要对得上**：数据目录 `data/` 全部 0600/0700，属于服务用户。
   面板守护或以 root 启动会让进程属主与文件属主不一致，出现"能读到自己不该读的、或读不到自己该读的"。
2. **定时器与看门狗是一体的**：备份、进程守护、健康巡检、审计清理四个 timer 都挂在
   同一套 user 会话下（`install-timers`），PM2 的守护会与 systemd 的 Restart 策略互相打架。
3. **可预期**：`NoNewPrivileges=true`、`UMask=0077`、`TimeoutStopUSec=30s` 这些都在 unit 里写死，
   排查时看一份 unit 文件即可；面板的托管参数在界面里，容易漂移。

## 后果

- `manage.sh` **必须在安装目录**（含 `.deployment.json` 的那一层）里执行，
  在源码 checkout 里跑会报 `Deployed Node.js runtime is unavailable` —— 那是目录不对，
  不要因此重跑 `deploy.sh`。
- 面板只用来做反向代理/防火墙这类外围事情，不接管进程生命周期。
- 自动化脚本一律以服务用户身份、经 `systemctl --user` 操作；需要提权的动作走面板或运维手工。
