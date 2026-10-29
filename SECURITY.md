# Security Policy

## 报告漏洞

请不要在公开 issue 中披露安全问题或利用细节。优先使用 GitHub 的私有漏洞报告功能：

- 仓库页 **Security** → **Report a vulnerability**
- 或通过 GitHub Security Advisories 联系维护者

请在报告中附上：受影响的版本/提交、复现步骤、影响范围，以及你认为可行的修复方向。维护者会尽快确认并回复。

## 部署安全提示

- `config.json` 包含 MCP/网关 token 和模型凭据，不要提交或公开
- 控制面板默认只绑定 `127.0.0.1`；远程访问请走 SSH 隧道并设置 `panelToken`
- `mcpHost` 不要在有公网 IP 的机器上直接设为 `0.0.0.0`
- 生产环境不要把真实 QQ 号、群号、服务器地址写进 issue 或截图
