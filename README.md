# napcat-plugin-qqbot

QQ 群 AI 机器人（DeepSleep）：NapCat 插件 + opencode 双层架构。

群友在 QQ 群里 @机器人 聊天，插件把消息交给本机的 opencode（每群一个持久会话，拟人化分句回复）；遇到复杂任务（探索代码、跑命令、查资料），opencode 通过 MCP 把任务提交给插件，插件起一个**一次性 Docker 沙箱**里的 opencode 执行，完成后**群里回复原消息发一句话结论、完整结果私聊发给提问的人**。

## 架构

```
QQ群/私聊 ⇄ NapCat (自编译, 白名单放行本插件)
             └─ napcat-plugin-qqbot（本插件，系统中枢）
                ├─ 消息收发（plugin_onmessage / send_msg）
                ├─ 消息库：每群/每人每天一个 SQLite（sql.js WASM）
                ├─ Session 控制器 → 本机 opencode serve（每群/每人一个持久 session）
                ├─ MCP Server（HTTP+Bearer）：send_message / query_chat_log /
                │   submit_task / list_tasks / get_task_detail
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
3. Agent 用 `send_message` 分句回复（每条一次调用，像真人打字）；忘了调则兜底按行拆发
4. 复杂请求 → Agent 调 `submit_task` → 自己回一句"处理完回复你" → 插件排队起容器
5. 容器完成 → 群里 reply 原提问 + @发起人 + 一句话结论（Agent 措辞）；全文私聊属主并注入私聊上下文
6. 属主私聊问"我的任务怎么样了" → 私聊 session 用 `list_tasks`/`get_task_detail` 查（越权只给状态不给内容）

## 目录

```
src/
├── index.ts      插件入口（plugin_init / plugin_onmessage / plugin_cleanup）
├── config.ts     配置（config.json 首次运行自动生成）
├── msgdb.ts      消息库：sql.js(WASM SQLite)，按 scope+天 分文件
├── format.ts     消息段提取（文本/引用/@）
├── opencode.ts   opencode HTTP 客户端 + SSE 事件订阅（自动重连）
├── sessions.ts   Session 控制器：映射持久化、工作区、触发判定、prompt 组装、回复路由
├── agentsmd.ts   各群/私聊工作区 AGENTS.md 生成器（人设+分句规则+表情表+工具说明）
├── tasks.ts      任务注册表（tasks.json 持久化）
├── executor.ts   Docker 任务执行器（并发上限、超时、结果分流投递）
└── mcp.ts        MCP Server（5 工具，scope 头路由，沙箱模式，属主权限校验）
smoke*.mjs        冒烟测试（消息库 / session+MCP配置 / MCP 五工具全链路）
```

> 任务沙箱镜像、HK 部署脚本、产物下载服务在独立的执行层仓库
> [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner)（HK 服务器由单独的 Agent 部署）。

## 构建

```bash
npm install
npm run typecheck
npm run build        # 产出 dist/（index.mjs + package.json + sql-wasm.wasm）
node smoke.mjs       # 冒烟测试 1：消息库
node smoke2.mjs      # 冒烟测试 2：session 创建（需要本地 opencode serve）
node smoke3.mjs      # 冒烟测试 3：MCP 五工具
```

## 部署与测试

**详细步骤见 [`docs/DEPLOY.md`](docs/DEPLOY.md)（Windows Server 版，Agent 可直接照做）。**

概要：

1. **自编译 NapCat**：本插件 ID `napcat-plugin-qqbot` 不在 NapCat 官方插件白名单内，需把
   `packages/napcat-onebot/network/plugin/loader.ts` 的 `OFFICIAL_PLUGIN_IDS` 加上该 ID 后构建
   （`pnpm install && pnpm build:shell`）。
2. **安装插件**：把 `dist/` 整个目录拷到 NapCat 数据目录 `plugins/napcat-plugin-qqbot/`。
3. **host opencode**：`opencode serve --hostname 127.0.0.1 --port 4096`
   （设 `OPENCODE_SERVER_PASSWORD` 则同步填到插件配置 `opencodePassword`）。
4. **任务沙箱镜像**：在远程执行层仓库 [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner) 构建（HK 主机跑其 `script/setup-hk.sh` 一键完成）。
5. **模型**：默认全部走 OpenCode Zen 免费模型 `opencode/deepseek-v4-flash-free`（免登录，host 层和容器层都已内置默认）；换付费模型才需要 `opencode auth login` 或配置 `dockerEnv`。
6. NapCat WebUI 启用插件，群里 @机器人 即可。

**测试**：验收用例见 [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)；测完按
[`docs/TEST_REPORT.template.md`](docs/TEST_REPORT.template.md) 填写为根目录 `TEST_REPORT.md` 并 push。

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `botName` | `DeepSleep` | 机器人自称（写入 AGENTS.md 人设） |
| `hostModel` | `opencode/deepseek-v4-flash-free` | host 层默认模型（OpenCode Zen 免费模型，免登录） |
| `visionModel` | `opencode/mimo-v2.5-free` | vision-bridge 桥接子代理的识图模型（免费 MiMo V2.5；图片下载到 inbox/ 由子代理读图） |
| `opencodeUrl` / `opencodePassword` | `http://127.0.0.1:4096` | host opencode 地址与密码 |
| `mcpPort` / `mcpToken` / `mcpUrl` | `5100` | 插件 MCP Server 监听与鉴权 |
| `mcpUrlForDocker` | `http://host.docker.internal:5100/mcp` | 容器访问 MCP 的地址 |
| `dockerImage` / `dockerEnv` | `qqbot-opencode-task:latest` | 任务镜像与注入容器的环境变量（API key） |
| `dockerHost` | 空（本机） | 远程 docker 主机（如 `ssh://user@x.x.x.x`），本机无法虚拟化时用 |
| `remoteWorkRoot` / `archiveRetentionDays` | `/opt/qqbot-users` / `5` | 远程模式每 QQ 持久目录根路径与产物归档留存天数（激活 session 自动续期） |
| `storageQuotaMB` | `500` | 每 QQ 持久目录总配额，超出从最旧归档开始清理 |
| `artifactBaseUrl` / `artifactToken` / `linkTtlHours` | 空 / 空 / 24 | 产物下载服务地址、签名密钥、链接有效期（HK 绑域名后启用，见 qqbot-hk-runner 仓库）；链接按需生成，到期前一天主动私聊提醒 |
| `taskConcurrency` / `taskTimeoutSec` | `2` / `900` | 任务并发上限与超时 |
| `contextMessageCount` | `15` | 触发时携带的最近上下文条数 |
| `replyDelayMinMs` / `replyDelayMaxMs` | `300` / `800` | 兜底分句发送的随机间隔 |

## 群命令

- `/reset`：清空当前对话的记忆（删除 opencode session）
- `/abort`：打断正在生成的回复

## 注意

- 插件跑在 NapCat 主进程内（无沙箱），所有 handler 已做异常隔离，但请勿让它处理不可信输入以外的操作。
- 消息库存于插件数据目录 `messages/<group|private>-<id>/msg_<YYYY-MM-DD>.db`，只增不删，注意定期清理。
