# DeepSleep

**一个会聊天、会接梗、还能帮你干活的 AI 群友。**

**基于 OpenCode 的开源智能群聊 Agent** —— 主动参与群聊 · 持久会话 · MCP 工具 · Docker 沙箱

> 独立服务形态：OneBot v11 WS 连 **SnowLuma**（或任意 OneBot v11 实现）作为 QQ 网关，本机 OpenCode 作为对话/调度层（NapCat 进程内插件形态已停止维护）。

群友在 QQ 群里 @机器人 聊天，机器人把消息交给本机的 opencode（每群一个持久会话，拟人化分句回复）；遇到复杂任务（探索代码、跑命令、查资料），opencode 通过 MCP 把任务提交出来，机器人在**远程 Docker 沙箱**（HK 主机，每 QQ 一个可休眠容器）里执行，完成后**群里回复原消息发一句话结论、完整结果私聊发给提问的人**。

> **仓库已改名**：本仓库原名 `napcat-plugin-qqbot`，现更名为 **DeepSleep**（GitHub 旧链接会自动跳转）。npm 包名与部署示例同步改为 `deepsleep`；数据目录与 `dist-service` 目录契约不变，已有部署只需替换代码目录，无需迁移数据。

## 架构

要求 **OpenCode 2.1.4**，使用 V2 API（`/api/session`、`/api/session/active`、`/api/event`、`/api/info`）。创建 session 的 `directory` 放在 POST body；新 session 未显式传模型时不再一概在创建时锁死。

```
QQ群/私聊 ⇄ SnowLuma（QQ 网关；OneBot v11 WS）
             └─ DeepSleep 服务（本仓库，系统中枢）
                ├─ 消息收发（OneBot WS 事件 / send_msg）
                ├─ 消息库：每群/每人每天一个 SQLite（sql.js WASM）
                ├─ Session 控制器 → 本机 opencode serve（每群/每人一个持久 session）
                ├─ MCP Server（HTTP+Bearer，共 10 个工具，含收藏表情包）
                │   模型可见名带 qqbot_ 前缀，MCP 服务注册名不变
                ├─ 控制面板（WebUI）：改配置 / 看会话 / 操作 Session，与服务同进程
                ├─ 梦境记忆：每晚 fork 会话整理 MEMORY.md（instructions 注入）→ 原子替换
                │    → compact 原 session，避免上下文无限增长
                ├─ 任务注册表：task_id ↔ 属主QQ/群号/消息ID（持久化，重启恢复）
                └─ 任务执行器：本地 docker 一次性容器；或远程 docker 主机（ssh://）——
                    每 QQ 一个可休眠容器（qqbot-user-<QQ>），任务完成 stop + 产物压缩归档
                    （默认留存 5 天），下次任务唤醒并 --continue 延续 session
                      ↕ 容器内 opencode 挂同一 MCP（沙箱模式：禁发消息/禁嵌套任务）

本机 opencode（上层）：每群/每人持久 session = 对话记忆；只聊天+调度
Docker opencode（下层）：一次性容器跑重活；结果 → 私聊全文 + 群短通知
```

## 消息流

1. 群消息全部写入消息库（不触发的也写，供 Agent 检索上下文）
2. @机器人 / 回复机器人消息 → 组装 prompt（最近 N 条上下文 + 引用还原）→ 群 session
3. Agent 用 `qqbot_send_message` 分句回复（每条一次调用，像真人打字）；忘了调则兜底按行拆发
3b. 收藏表情包：先在控制面板「表情」页从当前 QQ 同步收藏、按合集归组并打标启用；Agent 之后会用 `qqbot_list_stickers` 挑（显示为「合集:描述」）、`qqbot_send_sticker` 发（未打标/未启用的不会暴露给 Agent）
4. 复杂请求 → Agent 调 `qqbot_submit_task` → 自己回一句"处理完回复你" → 服务排队起容器
5. 容器完成 → 群里 reply 原提问 + @发起人 + 一句话结论（Agent 措辞）；全文私聊属主并注入私聊上下文
6. 属主私聊问"我的任务怎么样了" → 私聊 session 用 `qqbot_list_tasks`/`qqbot_get_task_detail` 查（越权只给状态不给内容）

## 目录

```
src/
├── app.ts        服务组装层（配置/消息库/Session/MCP/面板/梦境 + 生命周期，测试也复用）
├── main.ts       独立服务入口（OneBot WS 连接网关 + 进程生命周期）
├── onebot.ts     OneBot v11 WebSocket 客户端（自动重连、action/echo 往返）
├── config.ts     配置（config.json 首次运行自动生成，已知旧模型 ID 自动迁移）
├── msgdb.ts      消息库：sql.js(WASM SQLite)，按 scope+天 分文件
├── format.ts     消息段提取（文本/引用/@/图片/CQ 码清洗）
├── opencode.ts   OpenCode V2 HTTP 客户端 + SSE 事件订阅（自动重连）
├── sessions.ts   Session 控制器：映射持久化、工作区、触发判定、prompt 组装、回复路由、
│                 串行发送队列、watchdog 兜底（轮询 /api/session/active，running 即忙碌）
├── agentsmd.ts   各群/私聊工作区 AGENTS.md 生成器（人设+分句规则+表情表+工具说明）
├── tasks.ts      任务注册表（tasks.json 持久化）
├── executor.ts   任务执行器（远程 docker：每 QQ 可休眠容器、归档、配额、过期提醒）
├── mcp.ts        MCP Server（8 工具，scope 头路由，沙箱模式，属主权限校验）
├── dream.ts      梦境记忆：每晚 fork 会话用当天群聊更新 MEMORY.md，再 compact 原 session
├── panel.ts      控制面板 HTTP 服务（配置读写/校验、会话快照、Session 操作 API）
└── panel.html    控制面板前端（单文件，构建时内联进 dist）
smoke*.mjs        冒烟测试（消息库 / V2 session / MCP 十工具（含收藏表情） / 图片与视觉 / watchdog / 服务模式 / 控制面板）
```

> 任务沙箱镜像、HK 部署脚本、产物下载服务在独立的执行层仓库
> [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner)（HK 服务器单独部署，镜像须使用 OpenCode 2.1.4）。

## 构建

```bash
npm install
npm run typecheck
npm run build        # 产出 dist-service/（独立服务）
node smoke.mjs           # 冒烟：消息库
node smoke2.mjs          # 冒烟：V2 session 创建（需本地 OpenCode 2.1.4 serve）
node smoke3.mjs          # 冒烟：MCP 十工具（含收藏表情包）
node smoke4.mjs          # 冒烟：离线图片下载/prompt
node smoke5.mjs <图片路径>  # 冒烟：视觉；也可设 QQBOT_TEST_IMAGE
node smoke6.mjs          # 冒烟：watchdog 兜底（需本地 opencode serve）
node smoke9.mjs          # 冒烟：离线 V2 生命周期
node smoke10.mjs         # 冒烟：配置模型 ID 自动迁移（离线）
node smoke11.mjs         # 冒烟：控制面板（mock opencode，离线）
node smoke12.mjs         # 冒烟：梦境记忆 fork/替换/compact + 定时调度（mock opencode，离线）
node smoke13.mjs         # 冒烟：收藏表情同步/打标/MCP 可见性（mock opencode，离线）
node smoke14.mjs         # 冒烟：模型目录/免费标记/一键切换所有 Session（mock opencode，离线）
node smoke-service.mjs   # 冒烟：独立服务模式（假 OneBot WS）
```

## 部署与测试

**详细步骤见 [`docs/DEPLOY.md`](docs/DEPLOY.md)（Windows Server 版，Agent 可直接照做）。**

概要（独立服务模式）：

1. **QQ 网关**：推荐 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（OneBot v11，默认 WS `127.0.0.1:3001`）；NapCat 等其它 OneBot v11 实现也可用
2. **机器人服务**：拷贝 `dist-service/` 到 `C:\qqbot-svc`，`node index.mjs` 或计划任务常驻——**更新只重启这个进程，不动 QQ/网关**
3. **host opencode**：安装 `@opencode/cli` 并确认版本为 2.1.4，再运行 `opencode serve --hostname 127.0.0.1 --port 4096`。
   **必须显式设置 `OPENCODE_PASSWORD` 并同步配置 `opencodePassword`**；旧 `OPENCODE_SERVER_PASSWORD` 仅作兼容。2.1.4 未设密码会随机生成，不能省略。
4. **任务沙箱镜像**：在远程执行层仓库 [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner) 构建（HK 主机跑其 `script/setup-hk.sh` 一键完成），镜像必须升级到 OpenCode 2.1.4。
5. **模型**：默认 host/vision 分别走 OpenCode Zen 免费模型 `opencode/deepseek-v4.1-flash-free`、`opencode/mimo-v2.6-flash-free`（免登录）；配置加载会迁移已知旧模型 ID。换付费模型才需要 `opencode auth login` 或配置 `dockerEnv`。
6. 群里 @机器人 即可。

**测试**：验收用例见 [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)；测完按
[`docs/TEST_REPORT.template.md`](docs/TEST_REPORT.template.md) 填写为根目录 `TEST_REPORT.md` 并 push。历史报告不代表当前结果。

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `botName` | `DeepSleep` | 机器人自称（写入 AGENTS.md 人设） |
| `hostModel` | `opencode/deepseek-v4.1-flash-free` | host 层默认模型（OpenCode Zen 免费模型，免登录） |
| `visionModel` | `opencode/mimo-v2.6-flash-free` | vision-bridge 桥接 subagent 的识图模型（免费 MiMo V2.6；图片下载到 inbox/ 由 subagent 读图） |
| `opencodeUrl` | `http://127.0.0.1:4096` | host opencode V2 地址 |
| `opencodePassword` | 空（部署必填） | 必须与 serve 的 `OPENCODE_PASSWORD` 一致 |
| `mcpPort` / `mcpToken` / `mcpUrl` | `5100` | MCP Server 监听与鉴权 |
| `mcpUrlForDocker` | `http://host.docker.internal:5100/mcp` | 容器访问 MCP 的地址 |
| `dockerImage` / `dockerEnv` | `qqbot-opencode-task:latest` | 任务镜像与注入容器的环境变量（API key），镜像须为 OpenCode 2.1.4 |
| `dockerHost` | 空（本机） | 远程 docker 主机（如 `ssh://user@x.x.x.x`），本机无法虚拟化时用 |
| `remoteWorkRoot` / `archiveRetentionDays` | `/opt/qqbot-users` / `5` | 远程模式每 QQ 持久目录根路径与产物归档留存天数（激活 session 自动续期） |
| `storageQuotaMB` | `500` | 每 QQ 持久目录总配额，超出从最旧归档开始清理 |
| `artifactBaseUrl` / `artifactToken` / `linkTtlMinutes` | 空 / 空 / 10 | 产物下载服务地址、签名密钥、链接有效期（分钟）。有效期内重复索要返回同一链接，失效后可再生成；产物到期前一天主动私聊提醒 |
| `taskConcurrency` / `taskTimeoutSec` | `3` / `900` | 任务并发上限与超时 |
| `contextMessageCount` | `15` | 触发时携带的最近上下文条数 |
| `replyDelayMinMs` / `replyDelayMaxMs` | `1200` / `3000` | 兜底分句发送的随机间隔 |
| `maxLinesPerReply` | `4` | 兜底回复最大分句数，超出自动合并 |
| `panelEnabled` | `true` | 是否启用控制面板 |
| `panelHost` / `panelPort` | `127.0.0.1` / `5101` | 控制面板监听地址与端口（默认只允许本机访问） |
| `panelToken` | 空 | 面板访问 Token；非空时 API 需要 `Authorization: Bearer <token>` 或 URL `?token=` |
| `dreamMemoryEnabled` | `true` | 启用梦境记忆（每晚整理 MEMORY.md 并压缩会话） |
| `dreamMemoryHour` / `dreamMemoryMinute` | `4` / `30` | 每日整理开始时间（服务器本地时区，4:30 起；错过 3 小时内会补跑） |
| `dreamMaxTranscriptChars` | `120000` | 单次喂给梦境会话的群聊记录字符上限（超出截断保留最近部分） |
| `dreamMemoryMaxChars` | `8000` | 要求梦境产出的 MEMORY.md 建议字数上限（超过 2 倍视为无效输出） |

## 群命令

- `/reset`：清空当前对话的记忆（删除并重建 opencode session）；旧 session 存了弃用模型时也可用它恢复
- `/abort`：打断正在生成的回复

## 梦境记忆（MEMORY.md）

长期记忆不靠无限增长的上下文，而是外置到每个工作区的 `MEMORY.md`：通过 workspace `opencode.json` 的 `instructions` 注入系统提示，结构是人可读的 Markdown（群聊概况 / 长期事实 / 群成员 / 话题与偏好 / 未完成的事 / 更新时间）。

每天凌晨（默认 4:30，本地时区）自动执行：

1. `fork` 原会话（继承对话上下文，不影响原会话）
2. 把最近 24 小时的群聊记录喂给 fork 出的「梦境会话」，要求它读取旧 MEMORY.md、写出完整的 `MEMORY.new.md`
3. 校验产物（Markdown、有标题、大小合理）→ 备份旧记忆为 `MEMORY.md.bak` → **原子替换** MEMORY.md
4. 删除临时梦境会话
5. `compact` 原 session：OpenCode 生成摘要接管旧上下文，同时**重新读取 instructions**，让新记忆在原会话生效

要点：

- **instructions 是 session 级快照**：直接改 MEMORY.md 对已存在的 session 不生效；新 session 或 compact 后才会读到新内容——所以第 5 步的 compact 是让新记忆进入原会话的关键。
- 整理失败不会破坏旧记忆（不动 MEMORY.md、不 compact），错误会记录在 `dream.json` 与面板的「梦境记忆」卡片里。
- 需要服务进程在运行；进程在整理窗口内重启也会在 3 小时内补跑。面板会话详情可手动「立即整理」。
- 记忆文件在工作区目录 `workspaces/<scope>/MEMORY.md`，可手工编辑。

## 控制面板

内置一个 WebUI 控制面板（默认 <http://127.0.0.1:5101/>，绑定回环），用来：

- **改配置**：表单方式编辑全部 config 字段（含分组说明），写回 config.json；能热更新的字段立即生效，标「需重启」的字段（opencode 地址/密码、MCP 端口、面板端口等）需重启进程。也可以直接编辑 JSON。
- **看会话**：列出所有群/私聊会话及其 Session、忙碌状态、今日消息数、最后一条消息、待回应条数。
- **打开某个群/私聊的 Session**：查看 OpenCode 侧对话（含思考过程、工具调用折叠）与 QQ 消息库记录、工作区 AGENTS.md/opencode.json/MEMORY.md、屏蔽名单、该会话的任务，以及「梦境记忆」卡片（上次整理结果 + 立即整理按钮）。
- **操作 Session**：清空记忆（`/reset`）、打断生成（`/abort`）、以机器人身份发一条 QQ 消息、或把一段文字作为 prompt 直接发给 Agent（回复仍会正常发到 QQ）。

**远程访问**（服务器上部署时）：

```powershell
ssh -N -L 5101:127.0.0.1:5101 <用户>@<服务器IP>   # 然后本机打开 http://127.0.0.1:5101/
```

**安全**：面板默认只绑 `127.0.0.1`；只要不是本机直连（SSH 隧道/反代），务必设置 `panelToken`，否则任何能连到该端口的人都能读取密钥、改配置。面板 API 与 MCP 一样无状态、只支持同源访问，不做 CORS。

## 注意

- 服务与 QQ 网关分离部署（OneBot WS 连接）：业务进程崩溃不影响 QQ，网关重启后服务会自动重连。
- 消息库存于服务数据目录 `messages/<group|private>-<id>/msg_<YYYY-MM-DD>.db`，只增不删，注意定期清理。
