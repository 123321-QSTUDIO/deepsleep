# Contributing

感谢愿意参与 DeepSleep。提 PR 前请先开 issue 说明要解决的问题，避免大改动方向不一致。

## 开发环境

- Node.js 18+
- OpenCode **2.1.4**（集成测试需要 `opencode serve`）
- OneBot v11 网关（推荐 SnowLuma；也可以接任意兼容实现）

## 提交前检查

```bash
npm ci
npm run typecheck
npm run build
node smoke.mjs        # 至少跑离线冒烟
```

涉及 Session / MCP / 消息库等改动的，请补充或更新对应 `smoke*.mjs`。测试不依赖真实 QQ 号，统一使用占位符。

## 禁止提交

- `config.json`、`.env`、私钥/证书
- 真实 token、API key、密码
- 真实 QQ 号、群号、服务器 IP、域名
- 用户聊天记录或含个人信息的日志

仓库对外公开（含 git 历史），提交前请自行检查 diff。

## 风格

- TypeScript，保持现有模块边界；改机器人行为优先看 `src/agentsmd.ts`
- 中文文案使用 UTF-8，仓库统一 LF
- 不引入不必要的依赖；新增 MCP 工具需同步文档与测试
