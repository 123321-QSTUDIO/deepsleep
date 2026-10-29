# DeepSleep — Agent Handoff Guide

本文件面向接手/修改本仓库的 AI Agent 和开发者。用户可读的说明见 [README.md](README.md)，部署细节见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 项目是什么

DeepSleep 是一个运行在 **OpenCode 2.1.4** 上的 QQ 群聊 Agent 框架，独立服务形态：

- 通过 OneBot v11 WebSocket 连接 QQ 网关（SnowLuma / NapCat 等），收发群聊和私聊
- 每个群/每个私聊维护独立、长期延续的 OpenCode session；每轮把最近上下文交给 Agent
- Agent 通过 MCP 工具发送 QQ 消息/表情/语音、查询聊天记录、设置提醒、提交沙箱任务
- 复杂任务交给远程 Docker 沙箱执行，结果回群/私聊；Dream Memory 定期整理长期记忆
- 控制面板提供配置、会话、模型、表情、记忆等管理能力

## 快速开始

```bash
npm ci
npm run typecheck
npm run build
node dist-service/index.mjs
```

运行时要求：

- Node.js 18+
- OpenCode 2.1.4，`opencode serve` 在线
- 配置 `OPENCODE_PASSWORD` / `opencodePassword`
- 首次启动会生成 `config.json`；不要提交该文件

## 目录

- `src/main.ts`：独立服务入口，OneBot WS 连接与进程生命周期
- `src/app.ts`：组装层，创建 Config/MsgDB/OpenCode/Sessions/MCP/Panel/Dream 等
- `src/sessions.ts`：中枢。持久 session 映射、上下文组装、触发/批量窗口、发送队列、watchdog、工作区文件
- `src/agentsmd.ts`：每个群/私聊工作区的 AGENTS.md 人格与规则生成器
- `src/opencode.ts`：OpenCode V2 HTTP 客户端 + SSE 事件订阅
- `src/mcp.ts`：19 个 MCP 工具（模型可见名带 `qqbot_` 前缀）
- `src/executor.ts` / `tasks.ts`：远程 Docker 任务沙箱与任务注册表
- `src/dream.ts`：梦境记忆调度
- `src/panel.ts` / `panel.html`：控制面板后端/前端
- `src/config.ts`：配置默认值、模型迁移、保存
- `build.mjs`：esbuild 打包到 `dist-service/`

## 核心约束（改动前必读）

1. **人格与规则只改 `src/agentsmd.ts`**。不要往 user prompt 里塞规则段落；prompt 只放当前时间、最近群聊内容、`[须回应]` 标记、引用信息等。
2. **出站只认 MCP 发送工具**。`onSessionIdle` 不兜底发送模型最终文本；没调用 `qqbot_send_message` / `qqbot_send_sticker` / `qqbot_send_voice` 就是选择沉默。
3. 所有出站文本必须经过 `textToSegments`（CQ→segment）、表情白名单过滤、每 scope 串行发送队列。
4. 角色标签（`[主人]` / `[群主]` / `[群管理员]`）只能放在发言人名字前面；`formatForAgent` 只返回正文，作者前缀用 `rolePrefix`。
5. 消息库按 scope+天分文件；新增列必须考虑旧库迁移（`ALTER TABLE`）。
6. OpenCode 的图片附件请求结构是 `PromptInput.FileAttachment { uri }`；响应体才是 `{ data, mime, source }`，不要把响应体当请求体。
7. `AGENTS.md` 工作区文件由 `ensureWorkspaceFiles` 内容变化时重写；`opencode.json.instructions`（MEMORY.md）是 session 级快照，改 MEMORY.md 需要新 session 或 compact 后才生效。
8. 任何配置/人格/模型改动都要考虑旧配置兼容；`adminQqs` 已迁移为 `ownerQqs`，不要重新引入旧叫法。

## 安全与开源边界

- 永不提交：`config.json`、`.env`、密钥/token、真实 QQ 号/群号、服务器地址、聊天记录、日志
- 示例统一用占位符：`203.0.113.10`、`<HK_IP>`、`<测试群号>`
- MCP/面板默认只绑 `127.0.0.1`；远程访问请用 SSH 隧道并设置 token
- 许可证为 **Apache-2.0**；分发修改版时保留 `LICENSE` 和 `NOTICE`
- 公开仓库不包含维护者的本地冒烟测试和验收报告；提交前至少运行 `npm run typecheck` 和 `npm run build`

## 风格

- TypeScript ESM，模块边界保持现有结构
- 中文文案/注释优先；控制台与面板用户可见文案用中文
- 仓库使用 LF + UTF-8；不要用 PowerShell 的 `Set-Content` 重写中文文件
- 不引入不必要的依赖；新增 MCP 工具需同步文档、配置说明和面板展示
