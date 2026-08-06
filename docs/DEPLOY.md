# 部署手册（Windows Server 版）

> 目标环境：Windows Server 2019/2022（带桌面体验），x64。
> 全程用 **管理员 PowerShell** 执行。每一步都有【验证】，验证不过不要继续。
> 约定路径（可改，但请全文一致）：
> - `C:\qqbot` — 代码与构建
> - `C:\napcat` — 自编译 NapCat 运行目录
> - `C:\napcat-data` — NapCat 数据目录（NAPCAT_WORKDIR）

## 0. 前置检查

```powershell
[System.Environment]::OSVersion.Version   # 10.0.x
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB   # 建议 >= 8G
Get-PSDrive C | Select-Object Free       # 建议 >= 30G
```

## 1. 基础环境

```powershell
# Node 22 LTS（winget；没有 winget 就去 https://nodejs.org 下 LTS 安装包）
winget install OpenJS.NodeJS.LTS --version 22.15.0 -e --accept-source-agreements --accept-package-agreements
# 装完重开 PowerShell
npm i -g pnpm

# Git
winget install Git.Git -e --accept-source-agreements --accept-package-agreements
```

### Docker（二选一）

**方式 A：Docker Desktop（推荐，简单）**
- 下载 https://www.docker.com/products/docker-desktop/ 安装，设置里选 WSL2 后端，启动。
- 注意：Windows Server 不在 Docker Desktop 官方支持列表，实测 2022 可装可跑；商业用途注意授权。

**方式 B：WSL2 + Docker Engine**
```powershell
wsl --install -d Ubuntu-22.04   # 需重启
# 进 WSL 后：curl -fsSL https://get.docker.com | bash; sudo service docker start
# 然后把 Windows 的 docker CLI（Docker Desktop 的 docker.exe 或单独下载）配 DOCKER_HOST 指向 WSL
```
> 方式 B 时容器里 `host.docker.internal` 指向的是 WSL 虚拟机而非 Windows 宿主机，
> 插件配置 `mcpUrlForDocker` 要改成 `http://<Windows主机IP>:5100/mcp`。

【验证】
```powershell
node --version      # v22.x
pnpm --version
docker run --rm hello-world
```

## 2. host opencode（上层，常驻）

```powershell
npm i -g opencode-ai
opencode --version
```

**模型**：默认用 OpenCode Zen 的免费模型 `opencode/deepseek-v4-flash-free`，**无需任何登录/密钥**
（opencode 对 zen 免费模型内置 `apiKey: "public"`，开箱即用）。插件会给每个工作区自动写入该默认模型。
想换更强的付费模型才需要 `opencode auth login`（选 OpenCode Zen 或其他 provider）。

先验证免费模型可用：

```powershell
opencode run --model opencode/deepseek-v4-flash-free "只回复两个字：你好"
# 期望输出"你好"。失败说明网络到不了 opencode.ai，先解决网络。
```

用计划任务常驻（密码换成强密码）：

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'CHANGE_ME_STRONG_PASSWORD'
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList '/c "set OPENCODE_SERVER_PASSWORD=CHANGE_ME_STRONG_PASSWORD&& opencode serve --hostname 127.0.0.1 --port 4096 > C:\qqbot\opencode-serve.log 2>&1"'

# 开机自启
schtasks /create /tn "opencode-serve" /sc onlogon /rl highest /f `
  /tr "cmd /c set OPENCODE_SERVER_PASSWORD=CHANGE_ME_STRONG_PASSWORD&& opencode serve --hostname 127.0.0.1 --port 4096 > C:\qqbot\opencode-serve.log 2>&1"
```

【验证】
```powershell
curl.exe -s -u opencode:CHANGE_ME_STRONG_PASSWORD http://127.0.0.1:4096/session/status
# 期望返回 JSON。401=密码不对；连不上=服务没起，看 C:\qqbot\opencode-serve.log
```

## 3. 构建本插件

```powershell
mkdir C:\qqbot; cd C:\qqbot
git clone https://github.com/123321-QSTUDIO/napcat-plugin-qqbot.git
cd napcat-plugin-qqbot
npm ci
npm run typecheck
npm run build
node smoke.mjs     # 期望输出 SMOKE TEST 1 PASS
```

【验证】`ls dist` 有 `index.mjs`、`package.json`、`sql-wasm.wasm`。

## 4. 自编译 NapCat（白名单放行本插件）

```powershell
cd C:\qqbot
git clone https://github.com/NapNeko/NapCatQQ.git
cd NapCatQQ

# 4.1 白名单补丁（OFFICIAL_PLUGIN_IDS 数组加一行）
$f = 'packages\napcat-onebot\network\plugin\loader.ts'
(Get-Content $f -Raw) -replace "'napcat-plugin-qce',", "'napcat-plugin-qce',`r`n  'napcat-plugin-qqbot'," | Set-Content $f -NoNewline
Select-String -Path $f -Pattern 'napcat-plugin-qqbot'   # 期望有输出，否则补丁没打上

# 4.2 pnpm-workspace.yaml 的 allowBuilds 占位符必须改成 true
@'
packages:
  - packages/*
allowBuilds:
  '@heroui/shared-utils': true
  '@homebridge/node-pty-prebuilt-multiarch': true
  '@swc/core': true
  esbuild: true
  sharp: true
  ttf2woff2: true
  unrs-resolver: true
'@ | Set-Content pnpm-workspace.yaml

# 4.3 构建（node_modules 量大，耐心等）
pnpm install
pnpm build:webui
pnpm build:shell

# 【验证】白名单已编入产物
Select-String -Path packages\napcat-shell\dist\napcat.mjs -Pattern 'napcat-plugin-qqbot' -SimpleMatch | Select-Object -First 1
```

## 5. 安装 QQ + 部署 NapCat 运行目录

```powershell
# 安装 QQ NT Windows 版：https://im.qq.com/pcqq 下载安装（默认装到 C:\Program Files\Tencent\QQNT）

# 部署 NapCat 运行目录（dist 即运行目录，launcher 就在里面）
xcopy /E /I C:\qqbot\NapCatQQ\packages\napcat-shell\dist C:\napcat

# 数据目录
mkdir C:\napcat-data
```

做一个带 NAPCAT_WORKDIR 的启动脚本 `C:\napcat\start.bat`：

```bat
@echo off
chcp 65001 >nul
set NAPCAT_WORKDIR=C:\napcat-data
set NAPCAT_PATCH_PACKAGE=C:\napcat\qqnt.json
set NAPCAT_LOAD_PATH=C:\napcat\loadNapCat.js
set NAPCAT_INJECT_PATH=C:\napcat\NapCatWinBootHook.dll
set NAPCAT_LAUNCHER_PATH=C:\napcat\NapCatWinBootMain.exe
set NAPCAT_MAIN_PATH=C:/napcat/napcat.mjs
echo (async () =^> {await import("file:///%NAPCAT_MAIN_PATH%")})() > "%NAPCAT_LOAD_PATH%"
"%NAPCAT_LAUNCHER_PATH%" "C:\Program Files\Tencent\QQNT\QQ.exe" "%NAPCAT_INJECT_PATH%" %*
```

> QQ 装在其他路径就改最后一行的 QQ.exe 路径。想快速登录可在末尾加 `-q <机器人QQ号>`。

启动 + 开机自启：

```powershell
Start-Process -FilePath "C:\napcat\start.bat" -Verb RunAs
schtasks /create /tn "napcat" /sc onlogon /rl highest /f /tr "C:\napcat\start.bat"
```

【验证】
```powershell
Start-Sleep 15
curl.exe -s http://127.0.0.1:6099/ | Select-Object -First 1   # WebUI 有响应
Get-ChildItem C:\napcat-data\logs   # 有滚动日志
Get-Content C:\napcat-data\logs\*.log -Tail 30 | Select-String -Pattern 'webui|WebUI|6099'
```

## 6. 登录 QQ

1. 日志或 `C:\napcat-data\config\webui.json` 里找 WebUI token
2. 浏览器打开 `http://服务器IP:6099/webui?token=<token>`（没开公网就 RDP 进服务器开，或 SSH 转发）
3. 扫码登录机器人 QQ 号
4. 【验证】WebUI 显示在线；把机器人拉进测试群

## 7. 安装并启用插件

```powershell
mkdir C:\napcat-data\plugins\napcat-plugin-qqbot
xcopy /E /I C:\qqbot\napcat-plugin-qqbot\dist C:\napcat-data\plugins\napcat-plugin-qqbot

# 重启 NapCat（杀掉 QQ 进程重跑 start.bat，或在 WebUI 插件页重载）
Get-Process QQ -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath "C:\napcat\start.bat" -Verb RunAs
```

【验证】
```powershell
Get-Content C:\napcat-data\logs\*.log -Tail 50 | Select-String '\[qqbot\]'
# 期望: [qqbot] 初始化完成, botName=DeepSleep, opencode=... (在线), MCP :5100
```

没初始化：查 `C:\napcat-data\config\plugins.json` 是否有 `"napcat-plugin-qqbot": true`，没有就在 WebUI 启用或手动写入后重启。
提示 "not in official plugin whitelist"：QQ 加载的还是旧 napcat.mjs，确认 `C:\napcat\start.bat` 指向的是自编译产物。

## 8. 配置插件

编辑 `C:\napcat-data\config\plugins\napcat-plugin-qqbot\config.json`（首次运行自动生成）：

```json
{
  "botName": "DeepSleep",
  "hostModel": "opencode/deepseek-v4-flash-free",
  "opencodeUrl": "http://127.0.0.1:4096",
  "opencodePassword": "CHANGE_ME_STRONG_PASSWORD",
  "mcpPort": 5100,
  "mcpToken": "CHANGE_ME_MCP_TOKEN",
  "mcpUrl": "http://127.0.0.1:5100/mcp",
  "mcpUrlForDocker": "http://host.docker.internal:5100/mcp",
  "dockerImage": "qqbot-opencode-task:latest",
  "dockerEnv": {},
  "taskTimeoutSec": 900,
  "taskConcurrency": 2,
  "contextMessageCount": 15,
  "replyDelayMinMs": 300,
  "replyDelayMaxMs": 800
}
```

- `hostModel`：host 层每个工作区的默认模型，默认 zen 免费模型（`opencode/deepseek-v4-flash-free`）
- `opencodePassword` 必须等于第 2 步的 `OPENCODE_SERVER_PASSWORD`
- `dockerEnv`：**用免费模型时留空 `{}` 即可**；要给容器换付费模型时才填 key（如 `ANTHROPIC_API_KEY`），同时改 `docker/opencode.json` 里的 `model` 并重新 build 镜像
- 方式 B（WSL2 docker）时 `mcpUrlForDocker` 改为 `http://<Windows主机IP>:5100/mcp`
- 改完重启 NapCat 生效

## 9. 构建任务沙箱镜像

```powershell
cd C:\qqbot\napcat-plugin-qqbot\docker
docker build -t qqbot-opencode-task:latest .
```

【验证】
```powershell
docker run --rm --entrypoint opencode qqbot-opencode-task:latest --version
docker run --rm `
  -e QQBOT_MCP_URL=http://host.docker.internal:5100/mcp `
  -e MCP_TOKEN=CHANGE_ME_MCP_TOKEN `
  -e QQBOT_SCOPE=group-0 `
  qqbot-opencode-task:latest run "回复两个字：你好"
# 期望输出包含"你好"（容器里同样走 zen 免费模型，无需 key）
```

## 10. 部署完成检查单

- [ ] `curl.exe -u opencode:PASS http://127.0.0.1:4096/session/status` 返回 200
- [ ] `curl.exe -s -X POST -H "authorization: Bearer MCP_TOKEN" -H "content-type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}' http://127.0.0.1:5100/mcp` 返回 JSON（不是 401/404）
- [ ] QQ 在线，机器人在测试群里
- [ ] 日志有 `[qqbot] 初始化完成`
- [ ] `docker images | Select-String qqbot-opencode-task` 有镜像

全部打勾后进入 `docs/TEST_PLAN.md`。

## 常见问题

| 现象 | 排查 |
|---|---|
| 插件列表没有本插件 / 提示 not in whitelist | 白名单补丁没打上或没重新 build:shell；确认 start.bat 加载的是自编译的 `C:\napcat\napcat.mjs`（对比构建产物 MD5） |
| launcher 报 "provided QQ path is invalid" | QQ 未安装或装在非默认路径，改 start.bat 里 QQ.exe 路径 |
| 插件初始化报 MCP 端口占用 | 5100 被占：三处配置（mcpPort/mcpUrl/mcpUrlForDocker）一起改 |
| @机器人没反应 | 看日志 opencode 请求报错：401=密码不对；ECONNREFUSED=serve 没起；没报错但没回复=模型问题，手动跑 `opencode run --model opencode/deepseek-v4-flash-free "hi"` 排查 |
| zen 免费模型报 "usage limit reached" | 免费模型有额度限制（几小时重置），密集测试时悠着点；或 `opencode auth login` 登录 zen 账号提额/换付费模型 |
| 任务 error "沙箱环境不可用" | NapCat 进程里调不到 docker：确认 Docker Desktop 在跑；QQ 进程环境与当前用户一致（docker CLI 在 PATH 里） |
| 容器连不上 MCP | Docker Desktop 自带 host.docker.internal；方式 B 见第 8 节说明；Windows 防火墙放行 5100 |
| 服务器重启后全挂了 | 两个计划任务（opencode-serve / napcat）是否建成 onlogon；服务器需自动登录或改任务为不管登录与否都运行 |
