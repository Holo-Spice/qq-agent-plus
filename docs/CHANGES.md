# 改动清单（CHANGES）

本项目的开发起点是 revision `8dca708`（衍生关系见 NOTICE），之后叠加的改动集中在五块：**对话行为、发送链路健壮性、贴纸系统、主动发言、运维**。

这些改动当初是逐条以"补丁脚本"的形式打到部署机上的（脚本头部注释记录了当时的复现现象、失败模式与实测数字），后来沉淀进源码。下表"原补丁脚本"列即对应脚本名；没有对应脚本的是直接改源码/配置，标为「本仓库新增」。源码侧 diff 约 1.2 万行（含整文件重排），UI 侧只有两个小改动。

## 总表

| 功能 | 涉及文件 | 一句话说明 | 原补丁脚本 |
| --- | --- | --- | --- |
| 分条/多气泡发言 | `src/llm/prompt.js` | 一轮想说的分 2-3 条短句发，禁止用空格把两句连成一条 | `apply-chat-bubbles-patch.sh` |
| 提示词调优 | `src/llm/prompt.js`、`src/llm/qzone-interaction-prompt.js` | 明确"被点名默认要回、没被点名可以不回"等边界；表情/图库用法同步更新 | `apply-prompt-tune.sh` |
| 聊天关思考 | `src/llm/llm.js`、`src/core/orchestrator.js` | 按用途传 thinking 开关：聊天不带思考，判断/写作类保留 | `apply-chat-thinking-off.sh` |
| 看图先读情绪 | `src/llm/prompt.js`、`src/tools/tools-core.js` | 禁止描述画面，要求先给情绪定性再回话（v2 进一步收紧并给正反例） | `apply-vision-emotion.sh`、`apply-vision-emotion-v2.sh` |
| 自安排唤醒 `schedule_wake` | `src/core/orchestrator.js`、`src/tools/tools-core.js`、`src/llm/prompt.js`、`src/console/app.js` | 模型可以给自己安排一次"稍后主动开口" | `apply-schedule-wake-patch.sh` |
| 补话（说了没人接） | `src/core/orchestrator.js`、`src/llm/prompt.js` | 发过言、没人接、在发言时段内时，约 10 分钟后给一次补话机会 | `apply-followup-nudge.sh` |
| 提示词收尾自检 / 发言唯一通道 / 多气泡鼓励 / 闲聊带自己 / 表情清单常驻 | `src/llm/prompt.js` | 一批提示词层面的行为约束 | 本仓库新增（直接改源码） |
| 消息 id 归一化 | `src/tools/tools-core.js`、`src/core/store.js` | 把 `#123` 归一成纯数字 id；helper 与调用点绑定插入，避免"调用点有、定义没有" | `apply-message-id-normalize.sh` |
| 发送网络级重试 | `src/onebot/sender.js` | `fetch failed` 重试一次；限频等非网络错误不重试 | `apply-send-retry.sh` |
| 内联工具调用兜底 | `src/tools/inline-tools.js`（新增）、`src/core/orchestrator.js`、`src/features/daily-moments.js`、`src/identity/identity-pilot*.js`、`src/pilots/relationship-pilot.js`、`src/features/qzone-interactions.js`、`src/onebot/sticker-manager.js` | 模型把 tool call 写成文本（Hermes XML / 裸 JSON）时也能取到决定 | `apply-inline-toolcall-fallback.sh` |
| 发 QQ 系统表情 `send_face` | `src/onebot/onebot.js`、`src/onebot/sender.js`、`src/tools/tools-core.js`、`src/llm/prompt.js` | 按中文名发系统表情，支持"文字+表情"同一条混排 | `apply-send-face-patch.sh` |
| 系统表情标签 | `src/onebot/onebot.js`、`src/llm/prompt.js` | 来信里的系统表情标成 `[QQ表情N 名字]`，与表情库 id 区分 | `apply-face-label-clarity.sh` |
| 启动/重连补课 | `src/console/app.js` | 断线或重启期间丢的消息，从协议端拉最近历史补齐（按 mid 去重） | `apply-chat-catchup.sh` |
| 启动自检 + 静态扫描 | `src/ops.js`（`scan` 子命令） | 扫"调用点有、定义没有"的函数名，只记日志、不阻断启动 | 本仓库新增（由消息 id 归一化事故催生） |
| 已理解过的图直接回备注 | `src/tools/tools-core.js` | 库内图的备注直接复用，省一次视觉调用 | `apply-known-sticker-hint.sh` |
| 表情包自动收藏 | `src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、`src/console/app.js`、`src/core/config-legacy.js` | 看别人发的图判断值不值得收；判断异步、不阻塞主流程 | `apply-sticker-autocollect.sh` |
| 收藏判断健壮性 | `src/onebot/sticker-manager.js` | 认内联提交；`max_tokens` 200 → 600；判定尝试 2 → 3 次 | `apply-sticker-judge-robust.sh`、`apply-judge-retry3.sh` |
| 优先 QQ 收藏表情 | `src/onebot/sticker-manager.js` | 值得收时优先加进 QQ 收藏（链接稳定），失败退回本地库 | `apply-sticker-qq-favorites.sh` |
| 表情同步防清空 | `src/onebot/stickers.js` | QQ 收藏列表为空/失败时不剪枝，避免本地库（含备注）被清空 | `apply-sticker-sync-guard.sh` |
| 找不到表情时的兜底 | `src/onebot/stickers.js`、`src/tools/tools-core.js` | 报错里带上有效 id；`findSticker` 加唯一命中的模糊匹配；提示直接用备注名选图 | `apply-sticker-lookup-help.sh` |
| 表情备注上限 | `src/onebot/sticker-manager.js` | 16 → 24 字 | `apply-sticker-note-length.sh` |
| `[表情包]` 标签与收藏规则收紧 | `src/console/app.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/onebot/stickers.js`、`src/onebot/sticker-manager.js` | 表情包消息单独标注；只收真表情包，生活照/自拍不收 | `apply-sticker-label-and-rule.sh` |
| 提示词告知可攒表情 | `src/llm/prompt.js` | 工具一直有，只是没告诉模型 | `apply-sticker-collect-prompt.sh` |
| 主动开话题节奏 | `src/core/orchestrator.js` | 间隔 2.5-3.5 小时；"没有安静的群"不算消耗本轮（45 分钟后再看） | `apply-proactive-cadence.sh` |
| 主动判定间隔守卫 | `src/core/orchestrator.js` | "上次判定时间"落盘，重启后不足一个间隔就跳过 | `apply-proactive-interval-guard.sh` |
| 主动行为可观测 | `src/core/orchestrator.js` | 跳过原因、真正开话题都记日志；每次 tick 最多一行 | `apply-proactive-observability.sh` |
| 主动发言活跃时段 | `src/core/orchestrator.js` | 支持多个时间窗口（如 9-12 与 14-24）；窗口外不开口，也不浪费间隔 | `apply-proactive-quiet-hours.sh` |
| 空间互动专属活跃时段 | `src/features/qzone-interactions.js` | 动态互动单独设时段，不影响聊天回复 | `apply-qzone-active-hours.sh` |
| 空间互动失败退避 | `src/features/qzone-interactions.js` | 接口连续失败时指数退避，避免失败风暴 | `apply-qzone-fail-backoff.sh` |
| 空间互动抓取容错 | `src/features/qzone-interactions.js`、`ui/app.js` | 好友动态抓取失败（腾讯侧 `network busy` / 使用人数过多）先重试一次，仍失败也不再让整轮失败：评论检查与未读积压照跑；连续第 3 次才上报异常通知 | 本仓库新增 |
| 每日说说查重容错 | `src/features/daily-moments.js` | 空间列表读不到时跳过查重，不阻断发布 | `apply-moment-dedup-fix.sh` |
| 控制台端口探测修复 | `src/console/integrations.js` | 上游写死旧端口 15099/16081，与 Linux 全栈的 5099/6081 不一致导致误报"不可达" | `reapply-console-port-fix.sh` |
| 控制台自动登录 | `ui/app.js`、`src/console/app.js` | 地址栏带 `?token=` 免输令牌（成功后清掉 URL 明文）；登录 cookie 改 30 天 | `apply-autologin-patch.sh` |
| 会话列表轮询校准 | `ui/app.js` | 配置就绪后重新校准轮询间隔，消除每 4 秒重建列表的闪烁 | 本仓库新增（见 UI diff） |
| 只在源码变化时重启 | 部署脚本 `restart-if-changed.sh` | 每小时更新链不再无条件重启、打断正进行的对话 | `restart-if-changed.sh` |
| 运维工具集 | `src/ops.js`（单入口）、`docs/OPS.md` | 主机/服务自检、备份、进程看门狗、发送/登录线上验证、表情名导出、非交互部署、SSH 隧道、systemd 定时器安装 | 本仓库新增 |
| 本地回归测试 | `test/local/` | 定点验证发送重试、退避、内联兜底、贴纸查找 | 本仓库新增 |
| 省 Token 模式 | `src/core/token-saver.js`（新增）、`src/core/config-legacy.js`、`src/llm/prompt.js`、`src/core/orchestrator.js`、`src/memory/memory-global.js`、`src/features/daily-moments.js`、`src/features/qzone-interactions.js`、`ui/app.js`、`src/console/app.js` | 「设置 -> 省 Token」三档，只给上下文档位条数、单次运行轮数与预算、交接/印象注入字符数、表情清单条数**夹上限**，不改写用户设置；关掉即恢复原样 | 本仓库新增 |
| 关闭上游调试探针 | `src/*.js`、`ui/*.js` | 上游作者留在源码里的调试上报（指向其开发机私网地址）全部关掉 | `apply-disable-upstream-debug.sh` |

## 0. 群游戏、语音回复多供应商、定时提醒与群日报（v0.7.5 起）

- **群游戏：数字炸弹 / 谁是卧底 / 狼人杀**：`src/features/group-game.js`（新增管理器）、
  `src/features/games/{number-bomb,undercover,werewolf}.js`（新增三个插件）、`src/console/app.js`、
  `ui/app.js`、`src/core/config-legacy.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、
  `src/onebot/sender.js`、`src/core/access.js`、`src/core/store.js`。
  失败模式：群游戏既要"隐藏信息 + 轮次 + 超时"，又不能把玩家的牌面（身份、词、查验结果）露给主持模型 ——
  真人群里还有一串模拟不出来的情况：没参加的人插话、有人只潜水不发言、有人半路退出、有人 AFK 不交行动、
  白天谁也不想先开口。现行做法：**真相与话术分离**（身份/词/查验结果只走私聊，模型只看公开摘要）；
  需要私聊的游戏**先挂报名**（默认 45 秒，想玩的回「我玩」，到点人不够就散），不再把只是在群里插句话的
  围观者拉进局；白天三个出口谁先到算谁（固定讨论时长、超过半数存活玩家说「投吧」、全员发过言）；
  夜里 90 秒行动窗口，到点按已收到的结算（不点名、不催人）。
  **出局者的话一律不计入判定**（入场就返回 + 计票只认活人投票）并在出局那一刻私聊本人说明；
  有人反复私聊刷行动时按"每人每夜 4 条回执"夹住，超出静默。
  **游戏期间私聊豁免**：引擎发给本局在册玩家的私聊不受 `allow.private` 白名单限制（`deny` 仍优先、
  只在局内、失败不重试、内容全部是引擎文本），否则"整局都靠私聊"的狼人杀只有全员加白名单才玩得起来。
  **引擎私聊不进模型上下文**：发送侧落库时即打 `eventKind='game-secret'`，提示词历史、翻页工具、
  消息详情等所有出口统一过滤 —— 模型在私聊里不是上帝视角。
  **狼人杀**：6~9 人（6 人局 = 2 狼 / 1 预言家 / 1 女巫 / 2 民，7 人起加守卫，9 人 3 狼）；女巫两瓶药
  （解药救当晚被刀的人、毒药独立致命可一晚双死）各一次、一晚最多一瓶、不能自救、**同守同救必死**；
  狼刀定下之后才私聊询问女巫（提示里写明被刀的是谁），此后狼改刀会被拒。控制台实验页可选可开的游戏、
  报名与讨论时长、每局人数上限、结算是否公开身份等。
- **语音回复：四家适配（含豆包语音合成 2.0）**：`src/llm/tts-presets.js`、`src/llm/tts-doubao.js`（新增）、
  `src/llm/tts-http.js`（新增）、`src/console/app.js`、`ui/app.js`。
  失败模式：原先只支持 OpenAI 兼容一家；火山 v1 的鉴权（`Bearer;<token>`）与豆包 2.0 的 v3 流式
  （`X-Api-Key` / `X-Api-Resource-Id`、NDJSON 分片里 base64）形态完全不同，写死一种形态在别家必然失败。
  现行做法：OpenAI 兼容 / 火山 v1 / 豆包 2.0 / MiniMax 四家适配，控制台按服务商预设填地址、Key、模型与
  音色（豆包内置官方 2.0 音色清单 102 条，按控制台分类分组），支持试听；语音/图片类发送的超时 15s→60s
  （实测一条 7 秒语音协议端要 16.4s，原 15s 会把已发出的语音记成"结果未知"）。
- **声音复刻音色报「没开通」**（用户反馈，2026-09-30）：`src/llm/tts-doubao.js`、`src/llm/tts.js`、
  `src/llm/tts-presets.js`、`docs/CONFIG-EXAMPLES.md`、`ui/app.js`。
  失败模式：用户在自己的火山账号上复刻了声音、也开通了，调用却报没开通。生产账号实测对照（同一把 Key）：
  复刻音色（`S_` 开头）+ `seed-tts-2.0` → `55000000 resource ID is mismatched with speaker related resource`；
  换成复刻资源 `seed-icl-2.0` → `45000030 [resource_id=volc.seedicl.default] requested resource not granted`。
  根因是**资源按音色分家**：官方文档写明音色与资源必须配套（v3 资源 `seed-icl-2.0` = 声音复刻 2.0；
  v1 集群 `volcano_icl` = 声音复刻，标准音色才是 `volcano_tts`），而适配器只会照配置发默认值；
  用户看到的"没开通"是第二段的 45000030 —— 账号确实少了「声音复刻2.0字符版」
  （后付费音色还要单独开通「后付费音色服务」），但第一段的资源错配会先把人引偏。
  现行做法：新增 `doubaoResourceIdForVoice()`（v3）与 `volcClusterForVoice()`（v1）按音色前缀路由 ——
  `S_`/`icl_`（复刻）自动切复刻资源，`icl_*` 可走 v1 并发的 `volcano_icl_concurr`；用户显式填复刻资源时尊重
  （复刻 1.0 老音色）；官方投放音色 `ICL_uranus_*`（大写）不受影响（实测配 `seed-tts-2.0` 正常出音频）；
  45000030/55000000 的错误文案补上复刻场景的下一步。
  同时修掉文档里把 `ICL_uranus_*` 说成"自己克隆的音色"的错（那是火山自营音色，全表 201 个）。
- **画出图来（generate_image）**（Issue #21）：`src/llm/image-gen.js`（新增）、`src/tools/tools-core.js`、
  `src/core/config-legacy.js`、`src/core/config.js`、`src/core/orchestrator.js`、`src/llm/prompt.js`、
  `src/console/app.js`、`ui/app.js`、`docs/CONFIG-EXAMPLES.md`。
  失败模式：原先只会"收图、发图"，不会画 —— 群友让"画一张"时只能拿库里的旧图应付。
  现行做法：新增 `generate_image` 工具（OpenAI 兼容 `POST {baseUrl}/images/generations`），生成的图
  经 `addManual` 落进表情库、再用现成的 `send_sticker` 发出（零改动复用托管内联那条路）。
  配置 `imageGen` 默认关，控制台与语音回复同页、带「试画一张」。
  **三条评审抓出来的硬约束**：① **Key 归属守卫** —— 地址与聊天模型不同域时拒绝复用模型 Key
  （`resolveImageGenAuth`，"把 A 家的密钥发给 B 家"是这个项目修过的同类事故），同域或地址留空才复用；
  ② **唯一成本闸门** `maxPerHour`（默认 6，全局）—— 图片计费不进「用量」面板（那里只统计 token），
  所以闸门是唯一防线，且先查闸门再发请求（超限不花那笔钱）；③ 不发 `response_format`
  （新版 OpenAI 因未知参数 400），`b64_json` 与 `url` 两种响应都吃、`url` 走 SSRF 防护下载后落盘。
  关闭时不注入工具、提示词也不提画图。测试：适配器 6 例 + 端到端 4 例（真落库→真能发）+ 渲染 2 例 +
  编排器 1 例；4 条变异验证（跨域回退用模型 Key / 去掉体积上限 / 闸门恒放行 / 未开仍注入）——
  其中"体积上限"与"未开仍注入"头两次是**假绿**（变异后仍全绿），各补了用例才钉住。
  **2026-09-30 审查又补三处**（均为本批引入、未发布的缺陷）：① `available`/`hasApiKey` 这类
  "给界面看的派生结论"会被控制台整段展开回传写进 config.json，旧结论从此冒充当前状态 —— 按
  `IMAGEGEN_DERIVED_KEYS` 在 `migrateConfig` 里统一剔除（该口也是读盘必经，顺带清掉遗留脏字段）；
  ② 提示词原按 `enabled` 判断、而工具过滤按 `imageGenAvailable`，"勾了开关但没填模型"时会
  一边摘掉工具一边教模型去调 —— 两处口径统一为 `imageGenAvailable`；③ 控制台的「显示」按钮
  有控件无绑定（点了没反应），补 `GET /api/imagegen/key` 端点（守卫同 `/api/tts/key`）并接上事件。
  新增 `test/imagegen-config-api.test.mjs` 4 例 + 编排器/渲染各 1 例断言，三条修复各做变异验证（均如期变红）。
- **全量审查修复（针对改进方案 C0–#13 那 47 个提交）**：`deploy.sh`、`scripts/verify-deployment-target.mjs`、
  `src/core/health-check.js`、`src/core/secret-keys.js`、`src/core/redact.js`、`src/memory/memory-runtime-integration.js`、
  `src/ops.js`、`src/console/app.js`、`src/llm/prompt.js`、`ui/app.js`。
  这批提交本身测试很全，但整体过一遍仍抓出四处真问题（都做了代码实验复现，不是纸面推断）：
  ① **全新安装会被自己的预检挡住（P0）** —— `deploy.sh` 在调用校验器**之前**就
  `mkdir -p "$INSTALL_DIR" "$DATA_DIR"`（默认 `--data-dir` 就是 `$INSTALL_DIR/data`），
  无系统 Node 时还会下到 `$INSTALL_DIR/.runtime`；而校验器把"目录非空且无 `.deployment.json`"一律拒绝，
  于是按文档走的全新安装拿到一句自我循环的提示（"清空该目录后全新安装"，清空后下次仍被自己的 mkdir 挡住）。
  修法：校验器忽略**安装器自己创建**的条目（数据目录、`.runtime`；嵌套数据目录要求路径上每一层
  **在滤掉安装器产物之后**只含下一段，否则不整体忽略 —— 滤这一步是二审才补上的，漏掉它时
  "嵌套 `--data-dir` + 无系统 Node（下了 `.runtime`）"仍会被误拒），
  并放行**就地安装**（`--install-dir` 省略、即源码树干装时 rsync 源与目标同目录，不存在覆盖来历不明代码的风险）；
  同时把校验调用挪到"沿用端点"之后，`--host/--port` 才传得上、漂移提示不再是死分支。
  ② **数据目录迁移的逃生开关传不进去（P1）** —— 校验器要求 `--allow-path-change` + 环境变量双条件，
  但 `deploy.sh` 的参数解析**不认这个参数**（报 Unknown option），提示与 `docs/LINUX.md` 却让用户加它 →
  迁移永远做不成。修法：`deploy.sh` 接收并转发该参数。
  ③ **健康告警会静默丢失（P1）** —— 注入的通知器（`notify-owner` 的 `sendOwnerText`）**失败时返回
  `{ok:false}` 而不抛**，而 `health-check` 只 try/catch，于是"没发出去"被记成"已送达"、连击痕迹也被下轮整体重写抹掉；
  触发条件又是 `count === 3` 的硬相等，一次瞬时失败 = 整段故障期再也不告警（而告警通道正是最可能同因失败的 OneBot HTTP）。
  修法：`{ok:false}` 也算失败并记 `notifyError`，到达阈值后**每轮重试直到送达**（成功即清痕迹；
  送达判定用 `!= null` 而非真值，避免注入 `now = 0` 时被当成"没送过"而每轮重发）。
  ④ **审计日志会明文落盘密钥（P1）** —— 审计把**整份配置**写入 `audit-*.jsonl` 并由 `/api/audit` 读回，
  而脱敏只按字段名判（`SECRET_KEY_PATTERN` 不含 `authorization`/`x-api-key`/`cookie`/`auth`），
  按值扫（`redactText` 的 `Bearer …`/`sk-…` 规则）又只作用于 `error`。用户把凭据填进
  `api.extraBody`/`api.thinkingParams`/自定义 header（文档推荐的高级逃生口）时明文即落盘。
  修法：模式补上 header 类名字（仍**故意不含**裸 `key`，避免误伤 sortKey 这类业务字段），
  并把按值脱敏抽成 `redactSecretValue` 接到 `redactSecretFields` 的字符串分支上。
  另修 P2：`ops audit-prune` 的 help 与 `docs/OPS.md` 写了 `--data=目录` 但代码忽略它（会删**默认**目录的审计文件）。
  以上每条都补了用例并做变异验证（还原修复必红）；顺带补掉 `generate_image` 的两处接口不一致
  （提示词与工具注入的门不统一、控制台「显示」按钮没有对应路由点了没反应 —— 与上一条
  「画出图来」的 2026-09-30 审查补记是同一处缺陷，统合后只保留一处实现与一套用例）。
- **定时提醒**：`src/core/reminders.js`、`src/console/app.js`、`ui/app.js`。
  失败模式：提醒原来只在内存里、重启就丢；多条同时到点会叠着派发；派发前不预检会把提醒标成已发生却没真提醒。
  现行做法：落盘持久化、同会话多条合并、派发前预检（模型忙/会话在跑就排队），控制台新增"定时提醒"页
  （开关、待触发与最近完成列表、单条取消），`reminders.enabled` 同时门控 `remind` 工具与到期派发。
- **群日报**：`src/features/group-digest.js`、`src/console/app.js`。定时把最近 24 小时的群聊汇总发到指定群，
  发送时间的格式做了校验与兜底（配置写错时间不再静默不跑）。
- **对抗性审查修复（3 轮）**：`src/features/group-game.js`、`src/features/games/*`、`src/tools/tools-core.js`、
  `src/core/store.js`。修掉的问题包括：引擎私聊的 `game-secret` 标记原先只打在 ingest 回显侧，而存储按
  (chat_key, mid) 幂等、命中重复不回填 → 标记恒不生效（身份与查验结果会进模型上下文）；
  出局者反复发「不玩了」绕过配额（实测 20 条→20 条回执）；投票阶段「投自己」每次都回一条群消息；
  数字炸弹越界提示可无限刷；`tick` 推进的阶段不落盘导致任何重启都会重复"天亮了"、重发夜行动提示
  （改为发送成功后落盘 + tmp/rename 原子写）；退出的守卫仍然挡刀（`pending.guard` 存的是目标，作废时
  却拿提交者 uid 去比）；同一个人在两个群各一局时一条私聊被两局各执行一次；狼在锁刀前减员导致刀口永不
  锁定、女巫整夜收不到询问；名单没去重（模型把同一个人写两遍，他会拿 2~6 张身份）。
  配置侧补上 `maxPlayers`/`roundSeconds` 的默认值、`roundSeconds` 对狼人杀补 30 秒下限、
  `recruitSeconds` 显式写 `null`/空串按缺省 45 秒处理、名单报错区分"对不上"与"被人数上限截断"。
  测试侧新增 20 条用例（含数字炸弹边界、回执按夜重置、单一归属、原子写与损坏文件现状等），
  "tick 重入锁"那条原先是假绿、改成"报名溢出 + 慢发送"并做了突变验证；整局驱动从零断言加到 6 条。
- **控制台前端去插件化（UI 解耦 C2/C3）**：`ui/core/registry.js`（新增）、`ui/app.js`、
  `ui/stable-features.js`、`ui/status-refresh.js`、`ui/index.html`、`eslint.config.mjs`、
  `test/ui-registry.test.mjs`（新增）、`test/ui-contract.test.mjs`（新增）、`test/ui-smoke.test.mjs`、
  `test/{render-test,scroll-test,usage-e2e}.mjs`。
  失败模式：两个外挂文件原先靠**改写全局**接管渲染入口 —— `stable-features.js` 用
  `window[name] = wrapped` 包裹 5 个渲染函数、`status-refresh.js` 裸赋值 `refreshStatus = ...`。
  那只在"脚本顺序刚好、且双方都还是 classic script"时成立：ES module 的绑定只读、模块作用域
  也不挂 window，任何一步模块化都会让覆盖**静默失效**（页面照常渲染，只是那段改造不再生效，
  既没有报错也没有测试能发现）。现行做法：新增 `QARegistry`（`register` 底座 / `onTransform`
  HTML 变换链 / `onAfter` 副作用链 / `override` 整体接管 + `base` 取回原实现 / 钩子抛错只 warn），
  app.js 在载入时登记 8 个入口的底座并把三个被接管的入口改经 `dispatch` 分发；两个外挂文件改成
  显式注册。**契约冻死**：`test/ui-contract.test.mjs` 断言外挂文件引用的每个跨文件全局都在
  `uiSharedGlobals` 清单里、清单里每个名字都还有定义且确实被别的文件用到、且再无 `window[...] =`
  改写；`test/ui-smoke.test.mjs` 补一条"注册 transform/after/override 后输出真的被改写"（原来只有
  "渲染不抛"）。顺带清掉清单里只在自家文件使用的 `CONSOLE_MARKER`。
  同步文档：`docs/UI-SMOKE.md`（新增，UI 手工烟测清单）、`docs/adr/0001~0004`（新增，其中 0004 用
  实测记下"不抽 `core/lifecycle.js`"的原因：那 18 个符号的传递闭包是 357 个顶层声明里的 327 个）、
  AGENTS.md 的 UI 约定与定时器条数更正（三个→四个，audit-prune 早就加了）。
- **健康巡检误报"收发停止"（生产实测，2026-10-01 凌晨）**：`src/core/health-check.js`、`test/ops-health.test.mjs`。
  失败模式：`outbound-freshness` 的判据是"6 小时内没有任何出站消息＝可疑"，而**深夜/冷清时段群里本来就没人说话**，
  于是每次在安静时段部署（部署会重启服务、出站水位跟着停住）之后，恰好 6 小时越过阈值 → 连击 3 次 →
  私聊 owner 报"收发停止"。2026-10-01 06:24 实测就是这么误报的：那一夜 6.7 小时里**一条入站消息都没有**
  （最后一条入站 23:40:37、最后一条出站 23:40:53，都答完了），其余 6 项检查全绿。
  方案 §#7 只写了"observe 模式要跳过"，把其它静默期留给"连续 3 次"的抑制口径 —— 但抑制只压抖动，
  压不住"本来就没人的时段"。现行做法：判据改成"**有人说话而 bot 一条都没回**"才算故障 ——
  窗口内有入站消息且出站超时才失败；窗口内没有入站（或库里根本没有入站记录）记为**静默期**（ok，明细写明各自时间）。
  三处新用例（有入站且超时必红 / 无入站记静默 / 从来没有入站记静默）+ 2 条变异验证（拆掉两个静默期分支，对应用例如期变红）。

## 1. 思考控制与表情匹配（v0.7.4 起）

- **思考控制（按渠道翻译档位、每家独立、可按任务分设）**：`src/core/provider-presets.js`（新增）、
  `src/llm/llm.js`、`src/core/providers.js`、`src/console/app.js`、`ui/app.js`、`src/core/config-legacy.js`。
  失败模式：思考原先只有"开/关"两态、只写一种参数形态，而各家的开关根本不是同一个参数 —— Command Code 认
  `reasoning_effort`（且没有"关"档，`thinking` 字段被网关静默吞掉）、DeepSeek 官方认 `thinking.type=disabled`、
  通义认 `enable_thinking` + `thinking_budget`、OpenAI 用 `none` 当"关"……写死的形态在别的渠道上要么静默失效、
  要么被 400 拒绝。现行做法：语义层只表达意图（跟随服务商默认 / 关 / 低 / 中 / 高 / 最高），由渠道预设按
  baseUrl 主机名翻译成该家真实形态；档位表以官方文档/实测为准，个别未逐字核对的渠道在 `source` 里如实标注、
  由"参数被 400 拒绝就摘除重试"兜底（Command Code 官方无"关"档 → 不列「关」；智谱列「关」并注明
  GLM-5.3/4.7/4.5V 强制思考、选了也会被兜底忽略）。三处细分：**按供应商独立**（`api.thinkingByService[host]` 覆盖全局 `api.thinking`）、
  **按任务分设**（`{chat, judge, write, default}`：聊天 / 判断·总结 / 写作 / 其他，例如"聊天关、判断开"，
  带 `purpose` 的调用点在编排器、表情判断、身份/关系试航、空间互动等处）、**两条逃生口**（`extraBody` 直接并进
  请求体、优先级最高；`thinkingParams` 给不在预设内的渠道自定义档位映射；控制台里清空 JSON 要 `__replace__` 才真删）。
  能力实测（控制台按钮）只报实测到的事实：选"关掉"给"能不能关"的结论，选档位只报这一档能否通过、不含关闭结论；
  请求被 400 拒绝且错误提到 thinking/reasoning 参数时自动摘掉该参数重试一次。默认值不变（`thinking: 'on'`、
  跟随服务商默认），升级不影响既有实例。
- **表情匹配：send_sticker 报「找不到表情」（Issue #17）**：`src/onebot/stickers.js`。
  失败模式：`findSticker` 把标签与备注同池做双向包含、再要求唯一命中，别的表情的短标签擦边命中会把真正的备注
  命中一起否决 → 库里有也返回 null；模型把清单里「备注 [标签]（用过N次）（stickerId：…）」整行抄回来时同样匹配不上。
  现行做法：分级匹配（备注优先，只在同一级内要求唯一）id/md5/url → 备注精确相等 → 备注包含查询 → 查询包含备注 →
  标签；展示性修饰做成"由长到短"的形态阶梯、从最完整形态开始试（备注自身以括号结尾如「裂开（崩溃）」时不会被
  剥短形态劫持到别的条目）；能从「（stickerId：xxx）」里抠出 id 兜底。生产库 37 条清单行 + 截断行实测 66/66 命中。
- **OpenDesign（amr-link 网关）渠道预设**：`src/core/provider-presets.js`、`ui/app.js`、`docs/CONFIG-EXAMPLES.md`。
  失败模式：该网关虽属"聚合网关"一类，行为却与既有的 Command Code 预设不同 —— 四轮探针实测（2026-09-30）表明它
  **吞掉全部 thinking 类参数**（`thinking` / `enable_thinking` / `thinking_budget` / `reasoning` 均被忽略、请求成功
  但推理照跑），只认 `reasoning_effort`；且接受度**逐模型不同**：deepseek 系（v4-flash / v4-flash-vision-exp /
  v4-pro / v4.1-flash）六档全通且 `none` 真正关闭（推理 token 从 100+ 归零，各模型 3 次复现），
  glm-5.3 系只认 low/high/max，传 `none` 与 `medium` 直接 400。
  现行做法：off 映射为 `reasoning_effort: none`（不是历史默认的 `thinking.type` —— 实测会被吞掉），
  档位只列**两端都通过**的 low/high/max（同渠道内模型不同时取交集，与智谱条目同一约定）；`medium` 不进表，
  要它的用户走「额外请求参数」。glm 系的 400 由既有的"400 且文本含 reasoning → 摘参重试"兜底
  （实测该 400 原文命中该正则），故 `canDisable` 保持 `null` 而非 `false` —— 该发 none 让 deepseek 系真关掉。
  模型例：deepseek-v4.1-flash、glm-5.3-flash、kimi-k2.7-code、mimo-v2.6-pro。
- **工具报错写进 journal 并统一脱敏**：`src/core/orchestrator.js`、`src/core/redact.js`（新增）。
  失败模式：工具失败只进控制台异常面板，journal 里查不到，排查时容易漏（Issue #17 的补充建议）。现行做法：
  同一判定口径下补一行 `[tool] … 出错：…`，文本走统一脱敏（与 incident-pilot 入库同一套规则），并把
  `access_token` / `api_key` 这类带下划线前缀的参数名补进规则（旧规则只认 `?token=` / `?key=`，会漏掉本项目
  OneBot 实际写在查询串上的 `access_token`）。

## 2. 引用、记忆与人设（v0.7.3 起）

- **引用块带被引用那条的消息 id**：`src/core/util.js`（`formatQuoteRef` / `quotePrefixFor` / `textWithQuote`）、
  `src/onebot/onebot.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/console/app.js`。
  失败模式：引用块里只有说话人名和原文、没有消息 id，且机器人自己被引用时显示的是群名片名（历史行里却是「我」）——
  模型定位不到被引用那条、也认不出那是自己说的话，于是对"谁在回谁、哪条在前"给出错误回答（Issue #16）。
  现行做法：统一渲染成 `[引用#102·说话人：原文]`，引用自己的消息标「我」；实时消息、历史记录、翻页工具、
  消息详情、控制台消息接口共用同一套渲染。形态里不放空白（`sanitizeUserText` 会折叠方括号内空白，
  老的前缀判定 `startsWith('[引用 ')` 因此在真实存档上从未命中，历史行会重复贴一次引用、「引用」标签也一直没生效）。
- **过去状态的边界说明与翻页补偿**：`src/llm/prompt.js`、`src/tools/tools-core.js`。
  失败模式：历史只带最近 N 条却没有任何说明，模型把"没看到"当成"不存在"；`pastStateCount` 少算触发批，
  `get_recent_messages` 翻页开头会重复触发批那几条。现行做法：写明条数、`#消息id` 通常随时间递增可核对先后
  （被补课的旧消息/跳号时以行序为准）、更早的用工具往前翻；补偿按"触发批 + 过去状态"计。
  「有历史但这次没带」不再误报"这是你第一次参与这个会话"。
- **emoji 被切成半个导致整次模型请求 400**：`src/core/util.js`（`safeSlice` / `stripLoneSurrogates`）、
  `src/llm/llm.js`（请求前兜底清理）、`src/core/orchestrator.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、
  `src/console/app.js`。失败模式：记忆"新建印象"把该群友的发言按 200 字符切片，正好切出半个 emoji（孤立代理项），
  模型网关把整次请求判成 400 Bad Request —— 该群友永远建不出印象，控制台只显示"1 位失败（已保留原印象）"。
  实测：原样请求 400，剥掉孤立代理项后同一请求 200 并成功产出印象。现行做法：截断一律走 `safeSlice`（不切断代理对），
  并在请求出口统一清掉孤立代理项。
- **人物记忆的"发现新人"门槛改为控制台可设**：`ui/app.js`、`src/core/orchestrator.js`。
  失败模式：自动整理只在"最近 2000 条里发言 ≥ discoverMinMessages（默认 20 条）"的零印象群友里挑人，
  门槛高于群里多数人的实际活跃度时，新记忆永远不会产生（实测某群：已有印象者 225/127/45 条，
  其余人 16/11/8 条全部够不到门槛）。现行做法：控制台「记忆整理」可设「发现新人的最少发言条数」与
  「单次最多发现几人」，默认值不变。
- **换人设不再残留上一张卡**：`src/llm/prompt.js`、`src/console/app.js`、`ui/app.js`、`roles/*.md`。
  失败模式：换卡 26 小时后仍在用旧卡的口癖（实测：群 433397830 最近 30 条里它自己 8 条带"喵"，群友 0 条，
  而当前卡明文写着"不要：可以哦，喵～"），根因是"自我锚定"——自己上一条的口气、各群的交接/checkpoint、
  表情库里的旧人设道具都在提示词里。现行做法：`persona.changedAt` 由控制台在内容真变时打点，
  24 小时内【过去状态】等段落自动加"旧记录不作数"提示；新增按钮「换人设后清空交接」
  （`POST /api/persona/reset-handoffs`，需确认；不动聊天记录与人物印象）；平台提示词里写死的默认人设元素全部中性化。
- **表情库区分"QQ 收藏表情"与"本地图库"**：`src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、
  `src/tools/tools-core.js`、`src/console/app.js`。失败模式：库里的收藏项存的是消息图片的临时链接，
  发出去是普通图片、链接过期后是坏图；`collect_sticker` 直接进本地库、不判断"是不是表情包"。现行做法：
  收藏即落盘（`sticker-assets/`），清单标出来源与发送形态（〔QQ收藏表情〕/〔本地图库·发出去是图片〕），
  发送前探活、失效不发并给出可照做的提示；QQ 收藏夹上限 500（非会员）因此本地库保留。

## 3. 语音转写与视频（v0.7.2 起）

- **多供应商语音转写**：`src/llm/asr-openai.js`、`asr-local.js`（本机 whisper.cpp）、`src/llm/seed-asr.js`（火山 Seed-ASR）、
  `asr-dashscope.js`（阿里云百炼）、`asr-baidu.js`、`asr-tencent.js`（TC3 签名）、`asr-iflytek.js`（签名 WSS 分帧）+
  `src/tools/audio-transcribe.js`（路由/分片/配额/非语音提示）。四家国内云的短语音接口单次 ≤60 秒，
  统一按 55 秒无损分片再拼接；OpenAI 兼容服务超过 20MB 才切片（25MB 上传上限）。失败模式：长音频被服务端整条拒掉、
  分片中途失败丢掉已计费的前几片、纯音乐/音效被 ASR"编"出一段像模像样的假文本 —— 分别用分片、进度写进错误、
  停顿比例判据（≥3 秒且近静音 <5%）处理，命中时把"别把上面的文字当作事实讲"一并交给模型。
- **QQ 语音是 SILK**：`src/llm/silk.js`。真实字节是 `.#!SILK_V3`（文件名写着 `.amr`、CDN 回 `content-type: audio/mp3`，
  都不可信），ffmpeg 没有 SILK 解码器 → 一律 "Invalid data found"。协议端的 `get_record` 不会转码
  （实测传 `out_format=mp3/wav` 仍返回同一个 CDN URL），因此用 `silk-wasm`（WASM，延迟加载）在本地解成
  16k 单声道 PCM。协议端只给文件名、没给 URL 时，语音走 `get_record`、群/私聊文件走
  `get_group_file_url` / `get_private_file_url` 换地址。
- **视频"看画面 + 听声音"**：`src/onebot/onebot.js`（video 段与视频类文件段各留 audio/video 两条）、
  `src/tools/image-downsample.js`（`convertVideoToFrameStrip`：ffprobe 取时长 → 均匀抽 4 帧拼 2×2 JPEG）、
  `src/tools/tools-core.js`（`get_message_images` 按 kind 分流）。失败模式：只采音轨时模型会回"视频只能听声音"
  （用户实测反馈），画面根本没进过模型的眼睛。

## 4. 对话行为

- **分条发言（多气泡）**：`src/llm/prompt.js`。失败形态有两种：一是"把想说的全塞进一条长消息"，二是"用空格把两句连成一条"。补丁注释记录，v1 之前实测 90% 的情况只发一条；v2 在尾部加了"别把一轮压成一句点评"，并明确"一轮常见 2-3 条短句、单条多数 ≤30 字、别一口气刷 4 条以上"。配套的 `humanRhythm` / 主体性文本属于上游自带内容，未通过脚本改动。
- **提示词调优**：`src/llm/prompt.js`、`src/llm/qzone-interaction-prompt.js`。把"被 @ 或直接提问时优先判断是否需要回应"改成"被 @、点名或直接提问时默认要回一句（可以短、可以敷衍、可以怼回去），只有明显与你无关、对方 @ 别人、或纯刷屏误 @ 时才不回"（v0.6.3 起把其中的"可以怼回去"进一步软化为"也可以就回一句不痛不痒的"）；同时统一了"图库可以自己攒"的用法说明。
- **聊天关思考**：`src/llm/llm.js`、`src/core/orchestrator.js`。聊天主调用传 `purpose:'chat'`，不携带 thinking 字段；判断/写作类调用不传，走 `default:'on'`。配置 `api.thinking = {chat:'off', default:'on'}`；脚本幂等，写配置前才停服务。
- **看图先读情绪**：`src/llm/prompt.js`、`src/tools/tools-core.js`。模型看表情包/图片时容易去"描述画面"；改成先定性情绪再回话，v2 进一步收紧并给出正反例。顺手修了一个缺失：看库内表情时只给了 `desc`，没给模型自己写的 `localNote`。

## 5. 发送链路健壮性

- **消息 id 归一化**：`src/tools/tools-core.js`、`src/core/store.js`。模型常把提示词里的 `#123` 连 `#` 一起传回来，而 OneBot 只认纯数字 id。关键教训：`tools-core.js` 用到的 `normalizeMid` 必须在同一个文件里定义（`store.js` 里那份是模块私有、没有 export），早先只替换调用点没插 helper，结果每次 `send_message` / `send_sticker` / `send_face` 都抛 `normalizeMid is not defined`，机器人一个字都发不出去。所以脚本把"插 helper"和"替换调用点"绑在一起，并且在最后自检两者必须同时存在。
- **发送网络级重试**：`src/onebot/sender.js`。协议端重启或连接被掐时会抛 `fetch failed`，原来直接丢消息（用户视角是"它没回我"）；网络层错误重试一次即可救回，限频/参数类错误不重试（重试也没用）。回归用例见 `test/local/test-sender-retry.mjs`。
- **内联工具调用兜底**：新增 `src/tools/inline-tools.js`，并接入编排器之外的所有判断类模块（空间互动 / 每日说说 / 身份评估 / 关系评估 / 表情收藏判断）。失败模式：模型有时不返回原生 `tool_calls`，而是写成 `<tool_call><function=...>` 文本或带 `name` 的 JSON，这些模块只认原生结构 → 决定被当成"没提交"丢掉（线上出现过"关系评估模型未提交唯一的 submit_relationship_events 结果"、以及"模型两次都没提交决定，这次跳过"）。做法是把编排器里的解析器抽成共享模块，新增 `resolveToolCalls(message)` 统一成 OpenAI 结构，其余代码照旧读 `call.function.name / arguments`。
- **启动/重连补课**：`src/console/app.js`。服务重启或协议端断线期间，消息事件会丢——消息根本没进库，也就永远没人回。做法：连上 OneBot（含重连）后从协议端拉一次最近历史，把库里没有的消息按 mid 去重补进来；≤30 分钟的按新消息处理（会触发回应），更早的只补进记录、不吵人。
- **自检与静态扫描**：`src/ops.js scan`（原为 `ops/check-undefined-calls.sh` + `ops/scan-undefined-calls.py`，现已并入项目代码）。上面那次"整夜发不出一个字"的事故表现像"静默/掉线"，很难查；于是加了一个只记日志、永远 `exit 0`、不阻断启动的自检，挂在服务启动链上，另配 `src/ops.js audit` 的补丁标记检查做部署验收。

## 6. 贴纸（表情包）系统

- **自动收藏**：`src/onebot/sticker-manager.js`、`src/onebot/stickers.js`、`src/console/app.js`、`src/core/config-legacy.js`。让模型看一眼别人发的图，自己判断值不值得收（值得就存并写备注）；入口改成异步判断，不阻塞消息处理。条目保留 `srcKey` 作为去重键。
- **收藏判断健壮性**：`src/onebot/sticker-manager.js`。两个失败模式：模型有时把决定写成 `<tool_call>` 文本或裸 JSON（判断逻辑只认结构化 `tool_calls` → 决定丢失）；`max_tokens=200` 会被"思考"吃掉（实测思考 80-595 token），截断后一个字段都收不到 → 提到 600。另外内容过滤是概率性的（实测同图 20/20 通过、偶发被挡），把尝试次数 2 提到 3，并把"被服务商内容过滤"和"模型没提交"在日志里分开。
- **收藏去向与同步安全**：`src/onebot/sticker-manager.js`（优先加进 QQ 收藏表情，链接稳定、QQ 端也能用，失败退回本地库）、`src/onebot/stickers.js`（QQ 收藏列表为空或接口失败时不剪枝——否则接口一抖，本地库连同 AI 写的备注会被清空）。
- **查找与备注**：`src/onebot/stickers.js`、`src/tools/tools-core.js`、`src/onebot/sticker-manager.js`。线上连续出现 5 次"找不到表情 NNN"，编号其实来自来信里的 `[表情NNN]` 标签，模型却拿去当表情库 id 查。于是：来信把系统表情标成 `[QQ表情N 名字]`；找不到时把有效 id 回给模型；`findSticker` 增加"唯一命中"的模糊兜底，提示改为直接用备注名选图；备注上限 16 → 24 字（真图实测里 16 字会把一句话硬切）。
- **标签与收录规则**：`src/console/app.js`、`src/llm/prompt.js`、`src/tools/tools-core.js`、`src/onebot/stickers.js`、`src/onebot/sticker-manager.js`。表情包消息显示 `[表情包]`（普通图仍是 `[图片]`）；收藏规则收紧到"只认真正的表情包"，生活照/随手拍/自拍不收；相关文案统一叫"表情包"。

## 7. 主动发言与空间互动

- **开话题节奏**：`src/core/orchestrator.js`。间隔定为 2.5-3.5 小时；"没有安静的群"这种空转不算消耗本轮（45 分钟后再看）。概率、冷场阈值属于部署方偏好，脚本不强制。
- **间隔守卫**：`src/core/orchestrator.js`。tick 第一次在启动后 15 秒触发，所以每重启一次就会多一次开话题判定，与"几小时才概率开一次"的设定不符。改为把"上次判定时间"落盘，重启后不足一个间隔直接跳过（补丁标记 `minGapMs`、`writeProactiveLastAttempt`）。
- **可观测性**：`src/core/orchestrator.js`。原来整个 tick 一条日志都没有，出问题时完全没法查；现在跳过原因和真正开话题都记日志，每次 tick 最多一行，不会刷屏。
- **活跃时段**：`src/core/orchestrator.js`（支持多个窗口，如 9-12 与 14-24，窗口外不开口也不浪费间隔；调度上直接把下一次排到窗口开始）、`src/features/qzone-interactions.js`（空间互动有独立时段，不影响聊天回复）。
- **失败退避**：`src/features/qzone-interactions.js`。一次失败风暴里 3 分钟打了 191 次（失败后按 -1s 下限重排，等于每秒重试），QQ 直接回"使用人数过多，请稍后再试"。改为成功后清零失败计数、排下一次检查时加指数退避下限。回归用例见 `test/local/test-qzone-backoff.mjs`（23 秒内只尝试一次，下一次排到分钟级）。
- **抓取容错与通知阈值**：`src/features/qzone-interactions.js`、`ui/app.js`。好友动态这条外呼在腾讯侧被限流时会回 `{code:-10001, message:"network busy"}`（协议端原样透传），而它此前是硬失败：一次限流就让整轮——包括评论检查和已积压的未读——全部不跑，还会立刻顶一条"错误"级异常通知。现在抓取失败先等 45 秒重试一次（中止信号可打断等待）；仍失败只记 `run.feedError`，本轮继续跑评论检查与积压，运行记录标为「好友动态未取到」并在控制台显示原因；失败计数与退避照旧（2→4→8→16→30 分钟），连续第 3 次才发异常通知；失败轮不算建立动态基线，免得把上线前的旧动态当成新内容。用例：`test/qzone-interactions.test.mjs`、`test/local/test-qzone-backoff.mjs`、`test/local/test-qzone-intervals.mjs`。
- **每日说说容错**：`src/features/daily-moments.js`。空间列表读不到时跳过查重，不阻断发布。

## 8. 运维与控制台

- **控制台端口探测**：`src/console/integrations.js`。上游把 SnowLuma / noVNC 地址写死为旧端口 15099 / 16081，而 Linux 全栈部署实际使用 5099 / 6081，导致"服务与访问控制"页误报"不可达"。改为按实际部署端口探测，并修正改 SnowLuma 密码时的地址兜底端口。
- **控制台自动登录**：`ui/app.js`（地址栏带 `?token=` 时先自动登录，成功后清掉 URL 里的明文令牌再重载，避免留在浏览历史）、`src/console/app.js`（登录 cookie 加 `Max-Age`，避免关掉浏览器就要重新输令牌）。
- **会话列表轮询**：`ui/app.js`。首次 `startListPoller()` 在配置加载前执行会落到 4000ms 兜底值，导致会话列表每 4 秒重建一次（界面闪烁）；配置就绪后重新校准一次轮询间隔。
- **只在源码变化时重启**：部署链每小时会跑一遍所有补丁脚本，无条件重启会让服务每小时被重启多次、打断正在进行的对话；于是加哈希比对，源码没变就跳过重启。
- **运维工具与回归测试**：`src/ops.js`（单入口，详见 `docs/OPS.md`）与 `test/local/`（详见 `test/local/README.md`），均为本仓库新增。原 `ops/` 目录下的 shell/python 脚本已全部移植进 `src/ops.js`，目录本身已删除；开发机私有的 ssh 文件传输/执行脚本不再随仓库分发，远程执行直接用 `ssh`/`scp`。
- **关闭上游调试探针**：`src/*.js`、`ui/*.js`。上游作者在自己开发机上留了一批调试上报（往其私网地址的 7777/7780 端口发数据），与本项目无关，已全部关闭（守卫条件置假 + 目标地址换成本机兜底）。
