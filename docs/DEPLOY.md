# 部署手册（Windows Server 版）

> **v2 起推荐独立服务模式**：机器人是独立 Node 进程，通过 OneBot v11 WebSocket 连接 NapCat，
> 更新只需重启 bot 进程（不动 QQ/NapCat），且 NapCat 用官方发行版即可（无需自编译白名单）。
> 插件模式仍保留但不再推荐。

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

### Docker（三选一）

**方式 A：Docker Desktop（本机，推荐于支持虚拟化的机器）**
- 下载 https://www.docker.com/products/docker-desktop/ 安装，设置里选 WSL2 后端，启动。
- 注意：Windows Server 不在 Docker Desktop 官方支持列表，实测 2022 可装可跑；商业用途注意授权。

**方式 B：WSL2 + Docker Engine（本机）**
```powershell
wsl --install -d Ubuntu-22.04   # 需重启
# 进 WSL 后：curl -fsSL https://get.docker.com | bash; sudo service docker start
```
> 方式 B 时容器里 `host.docker.internal` 指向的是 WSL 虚拟机而非 Windows 宿主机，
> 插件配置 `mcpUrlForDocker` 要改成 `http://<Windows主机IP>:5100/mcp`，且 `mcpHost` 要设 `0.0.0.0`。

**方式 C：远程 Docker 主机（本机无嵌套虚拟化时，实测场景）**
> 云服务器若是 KVM 且没开嵌套虚拟化（coreinfo 看 SVM/NP 为 `-`），方式 A/B 都跑不了，
> 就用另一台能跑 Linux docker 的机器。**注意：远程主机与本机通常不在同一内网（跨公网），按下面的安全要点做。**
>
> **推荐境外（如香港）主机**：任务的重网络活动（GitHub clone、npm/pip 拉包、访问 opencode.ai）都发生在远程主机本地，
> 境外直连外网更快更稳；回本机的只有 MCP 轻量调用（走隧道）和最终文本结果，延迟无感。
> 注意远程主机回程 SSH 隧道要稳（选到本机线路好的机房），隧道断了只是容器查不了聊天记录，不影响主链路。

远程 Linux 主机上（HK 侧组件已拆到独立仓库 [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner)，按其 README 执行）：
```bash
# 一键脚本（含 clone、build、HK->Windows 隧道 systemd 服务）：
curl -fsSL https://raw.githubusercontent.com/123321-QSTUDIO/qqbot-hk-runner/master/script/setup-hk.sh | sudo bash -s <Windows服务器IP> <Windows_SSH用户名> <MCP_TOKEN>
```

**C-1. 本机 → 远程 docker 的连接（不要用裸 TCP 2375 出公网！）**

跨公网链路抖（3 秒级延迟、频繁重置）时，**不要**用 `ssh://` 直接当 DOCKER_HOST——
那会让每条 docker 命令都新建一次 SSH 连接，每次都付握手延迟，链路一抖命令就失败。
正确做法：**一条持久 SSH 隧道复用所有 docker 流量**，握手只付一次，断了由托管服务自动重连。

```bash
# HK 主机：docker 加监听 127.0.0.1:2375（仅回环，不暴露公网；setup-hk.sh 已自动完成）
# /etc/systemd/system/docker.service.d/listen-local.conf:
#   [Service]
#   ExecStart=
#   ExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375
```

```powershell
# Windows 服务器：配好到 HK 的 SSH 密钥免密（ssh-keygen + 公钥加到 HK 的 authorized_keys）
# 起持久 docker 隧道，并用计划任务托管（开机自启）：
schtasks /create /tn "qqbot-docker-tunnel" /sc onlogon /rl highest /f `
  /tr "ssh -N -L 2375:127.0.0.1:2375 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes <HK用户>@<HK_IP>"

# 现在就启动一次（验证）：
Start-Process -WindowStyle Hidden ssh -ArgumentList '-N','-L','2375:127.0.0.1:2375','-o','ServerAliveInterval=15','<HK用户>@<HK_IP>'
docker -H tcp://127.0.0.1:2375 version    # 能连上 HK 的 docker 即成功
```

插件配置（见第 8 节）：
- `dockerHost`: `tcp://127.0.0.1:2375`（走隧道）
- `remoteSsh`: `<HK用户>@<HK_IP>`（远程文件操作走独立 SSH：建目录/解压/归档；与 docker 隧道分离，互不影响）

**C-2. 远程容器 → 本机 MCP 的连接（二选一）**

方案 C-2a（推荐，MCP 不出公网）：SSH 隧道
```powershell
# Windows 服务器：启用 OpenSSH Server（设置 > 可选功能，或）
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic; Start-Service sshd
```
```bash
# 远程 docker 主机：跑持久正向隧道（建议 systemd/supervisor 托管，断线重连）
ssh -N -L 5100:127.0.0.1:5100 user@<Windows服务器IP> \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes
```
插件配置保持：`mcpHost: 127.0.0.1`、`mcpUrlForDocker: http://host.docker.internal:5100/mcp`
（容器经 host-gateway 到达远程主机的 5100 = 隧道入口，转发回本机回环 MCP）

方案 C-2b（简单，MCP 暴露公网但限源 IP）：
- `mcpHost: 0.0.0.0`
- `mcpUrlForDocker: http://<Windows服务器公网IP>:5100/mcp`
- Windows 防火墙：5100 入站只允许远程 docker 主机的 IP
- 注意：HTTP 明文，mcpToken 会在公网传输（被中间人看到即可调 MCP），介意就用 C-2a

插件配置相应字段（见第 8 节）：
- `dockerHost`: `ssh://user@<远程主机IP>`（留空则读本机）
- 远程模式下的任务生命周期（每 QQ 一个可休眠会话）：
  1. 首个复杂任务：在远程主机为该 QQ 创建容器 `qqbot-user-<QQ>`（挂载 `/opt/qqbot-users/<QQ>/home` 和 `workspace`），用 `opencode run --standalone --format json --model ...` 建立 session
  2. 任务完成：`docker stop` 容器（不再占用 CPU/内存）→ workspace 产物压缩到 `archive/workspace-<时间>.tar.gz` → 清空 workspace
  3. 同 QQ 再次提交任务：唤醒同一容器、解压最近归档，在上述命令后保留 `--continue` 延续之前的 session（上下文不断）
  4. 执行器从 NDJSON 输出中取最后一条 assistant 文本作为结果
  5. 归档保留 `archiveRetentionDays`（默认 5）天，超期自动清理
  - `home/` 持久保存该 QQ 的 opencode 数据（含 session 数据库）和个人 token/key（.env 等可手放这里）
  - 同一 QQ 的任务串行执行（一个容器不能同时跑两个任务），不同 QQ 之间受 `taskConcurrency` 限制

【验证】
```powershell
node --version      # v22.x+
pnpm --version
docker run --rm hello-world                          # 方式 A/B
$env:DOCKER_HOST='ssh://user@<远程主机IP>'; docker run --rm hello-world   # 方式 C
```

## 2. host opencode（上层，常驻）

必须使用 **OpenCode 2.1.4**，安装包为 `@opencode/cli`：

```powershell
npm i -g @opencode/cli@2.1.4
opencode --version   # 必须为 2.1.4
```

**模型**：默认 host 模型为 OpenCode Zen 免费模型 `opencode/deepseek-v4.1-flash-free`，vision 模型为 `opencode/mimo-v2.6-flash-free`，**无需任何登录/密钥**
（opencode 对 zen 免费模型内置 `apiKey: "public"`，开箱即用）。插件会给每个工作区自动写入默认模型；配置加载会自动迁移已知旧模型 ID，旧 session 若仍存弃用模型则执行 `/reset` 重建。
想换更强的付费模型才需要 `opencode auth login`（选 OpenCode Zen 或其他 provider）。

先验证免费模型可用：

```powershell
opencode run --model opencode/deepseek-v4.1-flash-free "只回复两个字：你好"
# 期望输出"你好"。失败说明网络到不了 opencode.ai，先解决网络。
```

用计划任务常驻（密码换成强密码）。**必须显式设置密码并同步第 8 节的 `opencodePassword`**：2.1.4 前台 serve 未设密码会随机生成，导致机器人无法连接。优先使用 `OPENCODE_PASSWORD`；旧 `OPENCODE_SERVER_PASSWORD` 仍兼容，但新部署不要再用。

```powershell
$env:OPENCODE_PASSWORD = 'CHANGE_ME_STRONG_PASSWORD'
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList '/c "set OPENCODE_PASSWORD=CHANGE_ME_STRONG_PASSWORD&& opencode serve --hostname 127.0.0.1 --port 4096 > C:\qqbot\opencode-serve.log 2>&1"'

# 开机自启
schtasks /create /tn "opencode-serve" /sc onlogon /rl highest /f `
  /tr "cmd /c set OPENCODE_PASSWORD=CHANGE_ME_STRONG_PASSWORD&& opencode serve --hostname 127.0.0.1 --port 4096 > C:\qqbot\opencode-serve.log 2>&1"
```

【验证】
```powershell
curl.exe -s -u opencode:CHANGE_ME_STRONG_PASSWORD http://127.0.0.1:4096/api/info
# 也可检查 /api/session/active；期望返回 JSON。401=密码不对；连不上=服务没起，看 C:\qqbot\opencode-serve.log
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

## 4. （仅旧插件模式）自编译 NapCat + 白名单

> 推荐形态是**独立服务**（`src/main.ts`，OneBot WS 连 NapCat），用官方发行版 NapCat 即可，**本节整节可跳过**。
> 只有坚持用 `src/index.ts` 的 NapCat 进程内插件模式时，才需要自编译并加白名单。

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

> **pnpm install 失败规避**：`@homebridge/node-pty-prebuilt-multiarch` 的 install 脚本在部分 Windows 机器报 `spawn EINVAL`（仅影响 webui 终端功能，shell 运行不需要）。改用：
> ```powershell
> pnpm install --ignore-scripts
> pnpm rebuild @swc/core esbuild sharp ttf2woff2 unrs-resolver
> pnpm build:webui; pnpm build:shell
> ```

## 5. 安装 QQ + 部署 NapCat 运行目录

> **QQ 版本要求**：NapCat 当前最高支持到 **QQ NT 9.9.32-50969**（见其 `napcat-core/external/packet.json` 版本表与 CI 固定版本）。
> 腾讯会强制下线过旧的 QQ 版本（提示"存在安全隐患"并退出登录），请务必装新版本：
>
> ```powershell
> # NapCat CI 同款安装包（Windows x64, 9.9.32.50969）：
> curl.exe -L -o C:\qqbot\QQ9.9.32.exe "https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/beta/a33ab721/QQ9.9.32.50969_x64.exe"
> # 运行安装，默认装到 C:\Program Files\Tencent\QQNT
> ```
> 不要用 https://im.qq.com/pcqq 首页的最新版（可能超过 NapCat 支持范围）。

```powershell
# 部署 NapCat 运行目录（dist 即运行目录，launcher 就在里面）
xcopy /E /I C:\qqbot\NapCatQQ\packages\napcat-shell\dist C:\napcat

# 【必须】napcat.mjs 将 express/ws 留作外部依赖，运行目录必须有 node_modules：
cd C:\napcat
npm install --omit=dev
# （或在 monorepo 里 pnpm deploy，或从同版本官方 Shell 包复制 node_modules）

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

## 7. 部署机器人（独立服务模式，推荐）

```powershell
mkdir C:\qqbot-svc
xcopy /E /I C:\qqbot\napcat-plugin-qqbot\dist-service C:\qqbot-svc
```

**NapCat 侧**：WebUI → 网络配置 → 新建 **WebSocket 服务器**：`127.0.0.1:3001`，token 设一个强随机串。
（stock 官方 NapCat 即可，不再需要自编译白名单）

**启动服务**：

```powershell
# 前台测试一次（Ctrl+C 退出）
cd C:\qqbot-svc; node index.mjs

# 常驻（计划任务，开机自启）
schtasks /create /tn "qqbot-svc" /sc onlogon /rl highest /f `
  /tr "cmd /c cd /d C:\qqbot-svc && node index.mjs > C:\qqbot-svc\svc.log 2>&1"
```

【验证】
```powershell
Get-Content C:\qqbot-svc\svc.log -Tail 5
# 期望: 启动完成 botName=DeepSleep onebot=ws://127.0.0.1:3001 opencode=... (在线) MCP ...
# 且有 "OneBot WS 已连接"
```

**配置文件**：`C:\qqbot-svc\data\config.json`（首次运行自动生成），在原有插件配置基础上多了：
- `onebotUrl`：NapCat WS 地址（默认 `ws://127.0.0.1:3001`）
- `onebotToken`：上一步在 NapCat 设的 WS token

**从插件模式迁移**：把 `C:\napcat-data\config\plugins\napcat-plugin-qqbot\` 下的 `messages`、`sessions.json`、`tasks.json`、`users.json`、`workspaces` 拷到 `C:\qqbot-svc\data\`，配置合并进新 config.json，WebUI 里**停用插件**，启动服务。消息库、会话映射、任务记录全部继承。

## 7b. 插件模式（旧，不推荐）

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
  "hostModel": "opencode/deepseek-v4.1-flash-free",
  "visionModel": "opencode/mimo-v2.6-flash-free",
  "opencodeUrl": "http://127.0.0.1:4096",
  "opencodePassword": "CHANGE_ME_STRONG_PASSWORD",
  "mcpPort": 5100,
  "mcpHost": "127.0.0.1",
  "mcpToken": "CHANGE_ME_MCP_TOKEN",
  "mcpUrl": "http://127.0.0.1:5100/mcp",
  "mcpUrlForDocker": "http://host.docker.internal:5100/mcp",
  "dockerImage": "qqbot-opencode-task:latest",
  "dockerHost": "",
  "remoteSsh": "",
  "remoteWorkRoot": "/opt/qqbot-users",
  "archiveRetentionDays": 5,
  "storageQuotaMB": 500,
  "artifactBaseUrl": "",
  "artifactToken": "",
  "linkTtlMinutes": 10,
  "dockerEnv": {},
  "taskTimeoutSec": 900,
  "taskConcurrency": 3,
  "contextMessageCount": 15,
  "replyDelayMinMs": 1200,
  "replyDelayMaxMs": 3000,
  "maxLinesPerReply": 4,
  "panelEnabled": true,
  "panelHost": "127.0.0.1",
  "panelPort": 5101,
  "panelToken": "CHANGE_ME_PANEL_TOKEN"
}
```

- `hostModel`：host 层每个工作区的默认模型，默认 `opencode/deepseek-v4.1-flash-free`；已知旧模型 ID 会在配置加载时自动迁移，旧 session 存了弃用模型则 `/reset`
- `visionModel`：视觉桥接 subagent（vision-bridge）用的识图模型，默认 `opencode/mimo-v2.6-flash-free`。图片消息会下载到工作目录 `inbox/`，由纯文本主模型通过 **subagent** 工具调桥接代理读图，**不是**直接切换主模型
- 工作区 opencode.json 使用 `agents` + `system`、`mcp.servers` 和 `codemode: false`。MCP 共 8 个工具，模型可见名带 `qqbot_` 前缀（如 `qqbot_send_message`、`qqbot_query_chat_log`、`qqbot_submit_task`），MCP 服务注册名不变
- `mcpHost`：MCP 服务绑定地址，默认 `127.0.0.1`（回环）。**服务器有公网 IP 直绑网卡时切勿改成 0.0.0.0**；方式 B（WSL2 docker）确需容器访问时才改为 `0.0.0.0` 并配合防火墙只放行容器网段
- `opencodePassword` 必须等于第 2 步显式设置的 `OPENCODE_PASSWORD`，不能为空或写成可选项
- `dockerHost`：留空 = 本机 docker；方式 C 填 `tcp://127.0.0.1:2375`（走持久 SSH 隧道，见方式 C-1）
- `remoteSsh`：方式 C 必填，`<HK用户>@<HK_IP>`，远程文件操作（建目录/解压/归档）走这条 SSH
- `remoteSshKey`：可选，私钥绝对路径（如 `C:\\napcat-data\\hk_key`）。**NapCat 进程若非交互式用户启动（计划任务/服务），ssh 可能找不到 `~/.ssh` 里的密钥导致 BatchMode 失败——此时务必显式配置此项**，密钥用 `ssh-keygen -t ed25519 -f C:\napcat-data\hk_key -N '""'` 生成，公钥加到 HK 的 authorized_keys
- `storageQuotaMB`：每个 QQ 的持久目录（home+workspace+archive）总配额，默认 500MB，超了从最旧归档开始删
- `artifactBaseUrl` / `artifactToken` / `linkTtlMinutes`：产物下载服务（见 9.1 节）；链接为 HMAC 签名临时链接，默认 10 分钟有效，有效期内重复索要返回同一链接（不重复生成），失效后才能生成新链接
- `archiveRetentionDays`：产物归档留存天数（默认 5），**每次该 QQ 的 session 被激活会自动刷新最近归档的过期时间**
- `replyDelayMinMs` / `replyDelayMaxMs` 默认 `1200` / `3000` 毫秒，`maxLinesPerReply` 默认 `4`
- `panelEnabled` / `panelHost` / `panelPort` / `panelToken`：控制面板（见 8.1 节）。默认开启、只绑 `127.0.0.1:5101`；**远程访问必须设 `panelToken`**
- `dockerEnv`：**用免费模型时留空 `{}` 即可**；要给容器换付费模型时才填 key（如 `ANTHROPIC_API_KEY`），同时调整 qqbot-hk-runner 的模型配置并重新 build 镜像
- 方式 B（WSL2 docker）时 `mcpUrlForDocker` 改为 `http://<Windows主机IP>:5100/mcp`；方式 C 改为 `http://<本机IP>:5100/mcp`
- 改完重启机器人服务（旧插件模式则重启 NapCat）生效

## 8.1 控制面板（推荐开启）

机器人进程内置 WebUI 控制面板，部署完即可用：

- 本机直接打开 <http://127.0.0.1:5101/>（服务器上则用 SSH 隧道：`ssh -N -L 5101:127.0.0.1:5101 <用户>@<服务器IP>`，再在本机浏览器打开同一地址）
- `panelToken` 非空时，页面会提示输入 token（也能用 `http://127.0.0.1:5101/?token=xxx` 直接进）
- 功能：表单改全部配置（写回 config.json，部分字段提示需重启）、看所有群/私聊会话与 Session 状态、打开某个会话看 OpenCode 对话/QQ 消息记录/工作区文件、执行 `/reset`、`/abort`、以机器人身份发 QQ 消息、把文字作为 prompt 直接发给 Agent
- **安全**：默认只绑回环；不要把 `panelHost` 改成 `0.0.0.0` 直接暴露公网。SSH 隧道/反代场景请务必设置 `panelToken`（面板能看到配置里的密钥，也能改配置）

【验证】`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:5101/api/status`：设了 token 返回 401 属正常；页面 `http://127.0.0.1:5101/` 返回 200。

## 9. 构建任务沙箱镜像

镜像构建文件（Dockerfile + 容器内 opencode.json）在远程执行层仓库 [qqbot-hk-runner](https://github.com/123321-QSTUDIO/qqbot-hk-runner) 的 `docker/` 目录。**远程 qqbot-hk-runner 镜像必须升级到 OpenCode 2.1.4，旧镜像不可继续用于新任务协议。**

- 方式 A/B（本机 docker）：clone qqbot-hk-runner 后 `docker build -t qqbot-opencode-task:latest docker/`
- 方式 C（远程主机）：HK 主机跑 `setup-hk.sh` 时构建镜像；升级后必须重新构建并确认版本，不能沿用旧镜像
- 任务统一使用 `opencode run --standalone --format json --model ...`，远程续跑保留 `--continue`；执行器读取 NDJSON 最后一条 assistant 文本

【验证】
```powershell
docker run --rm --entrypoint opencode qqbot-opencode-task:latest --version   # 必须为 2.1.4
docker run --rm `
  -e QQBOT_MCP_URL=http://host.docker.internal:5100/mcp `
  -e MCP_TOKEN=CHANGE_ME_MCP_TOKEN `
  -e QQBOT_SCOPE=group-0 `
  qqbot-opencode-task:latest run --standalone --format json --model opencode/deepseek-v4.1-flash-free "回复两个字：你好"
# 期望 NDJSON 最后的 assistant 文本包含"你好"（容器里同样走 zen 免费模型，无需 key）
```

## 9.1 产物下载服务（远程模式 + 域名，可选但推荐）

给 HK 主机绑一个域名后，群友可以找机器人要任务产物（workspace 打包 tar.gz）的**临时下载链接**。

```bash
# HK 主机上（qqbot-hk-runner 仓库目录里）：
sudo bash script/setup-artifacts.sh <域名> <ARTIFACT_TOKEN>
# 脚本会做：装 node+caddy → artifact-server 常驻(127.0.0.1:8080) → Caddy 反代
```

- **域名走 Cloudflare 代理（橙云，推荐）**：TLS 在 CF 边缘终结，源站 Caddy 只开 80（脚本已按此配置），CF 面板 SSL/TLS 模式选 Full。CF 免费版 100MB 限制只管**上传**方向，产物下载不受影响，还能隐藏源站 IP
- **灰云直连**：把 Caddyfile 的 `http://` 前缀去掉（Caddy 自动签 TLS）。源站 IP 会随域名解析暴露，脚本已自动配 ufw 只放行 22/80/443；建议再给 sshd 关密码登录（`PasswordAuthentication no`，前提是密钥已配好）
- 链接机制：插件按需 HMAC 签名生成（`?exp=&sig=`），默认 24 小时有效（`linkTtlHours`），**机器人不主动发链接，用户私聊索要时才生成**；产物到期前一天机器人会主动私聊提醒用户留存
- 插件配置填 `artifactBaseUrl: "https://<域名>"` 和 `artifactToken`（与脚本参数一致），重启 NapCat 生效

## 10. 部署完成检查单

- [ ] `opencode --version` 与任务镜像内版本均为 2.1.4
- [ ] `curl.exe -u opencode:PASS http://127.0.0.1:4096/api/info` 返回 200（也可用 `/api/session/active`）
- [ ] 控制面板 `http://127.0.0.1:5101/` 可打开，能列出会话、保存一次配置（设置了 panelToken 时记得带上）
- [ ] `curl.exe -s -X POST -H "authorization: Bearer MCP_TOKEN" -H "content-type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}' http://127.0.0.1:5100/mcp` 返回 JSON（不是 401/404）
- [ ] QQ 在线，机器人在测试群里
- [ ] 日志有 `[qqbot] 初始化完成`
- [ ] `docker images | Select-String qqbot-opencode-task` 有镜像

全部打勾后进入 `docs/TEST_PLAN.md`。

## 常见问题

### 风控与下线（必读）

实测规律：**只在主动发消息后被检测下线**，纯接收相对安全。出站行为已做拟人化限速：

- 每对 scope 的消息严格串行 + 随机间隔 `replyDelayMinMs~MaxMs`（默认 1.2~3 秒，像真人打字）
- 兜底回复超过 `maxLinesPerReply`（默认 4）条时自动合并，防止刷屏式分句
- 私聊任务结果最多 4 段、每段 1200 字，长结果引导走下载链接

**开启 NapCat 内置反检测（默认是关的！）**：NapCat 发行默认配置把所有 bypass 关了。两种开法（二选一，Linux/Windows 通用）：
- WebUI → 反检测开关配置页：Hook / Window / Module / Process / Container / JS 全部打开，保存后重启
- 或编辑 NapCat 数据目录 `config/napcat.json`：

```json
{
  "bypass": {
    "hook": true,
    "window": true,
    "module": true,
    "process": true,
    "container": true,
    "js": true
  }
}
```

作用：隐藏注入模块（module）、伪装进程路径（process）、伪造 QQ 期望的窗口（window）、内存扫描欺骗（hook）等。重启 NapCat 生效。

运营侧建议：用**小号**跑、QQ 客户端保持新版、群里少发链接（链接是重点审查对象）、高频群适当调大间隔。被踢下线后重新扫码登录即可，会话与任务状态都在服务端持久化，不受影响。

补充：shell 模式是 headless（QQ 无窗口），这本身是个行为异常特征。如果开了 bypass 仍频繁被踢，可考虑 NapCat framework 模式（挂进正常带 UI 的 QQ 客户端，客户端行为与真人一致），需要时找我出迁移步骤。

### 方案 C：NapCat 移到国内 Linux 机器（官方 Docker，NAT 机即可）

Windows Server 无嵌套虚拟化、shell/framework 都被踢时的终选方案——把 NapCat 整个搬到一台**国内 Linux 机器**（Docker 在 Linux 上是原生的，与嵌套虚拟化无关），也是 NapCat 官方群主流形态：

1. **机器要求**：能跑 Docker 的 Linux 即可，**便宜的 NAT 机（共享 IP + 端口映射）或公网 IPv6 机都够用**——QQ 是出站连接不需要独立公网 IPv4；SSH 走 NAT 映射端口或 IPv6 地址。优先选内地机房（登录 IP 画像比境外好）。IP 类型二选一原则：Windows 服务器有 IPv6 出口（`ping -6 ipv6.baidu.com` 测）就选**公网 IPv6**（独立地址声誉好）；没有就只能 IPv4 NAT（注意共享段声誉）。选 IPv6 时隧道目标写 `[v6地址]` 格式并自己配 ip6tables 只放 SSH
2. **跑 NapCat（两种安装方式，优先 Launcher）**：
   - **优先：NapCat.Linux.Launcher（非入侵式）**——`LD_PRELOAD` 动态劫持文件访问，磁盘上 QQ 文件零修改（少一个完整性校验检测面）：
     ```bash
     # 下载 libnapcat_launcher_amd64.so 后
     Xvfb :1 -screen 0 1x1x8 +extension GLX +render > /dev/null 2>&1 &
     export DISPLAY=:1
     LD_PRELOAD=./libnapcat_launcher_amd64.so qq
     ```
   - **备选：官方 Docker（Installer 路线打包）**：`mkdir -p /opt/napcat-docker && cd /opt/napcat-docker`，按官方 compose 起
   - 两者**互斥**，别混用；WebUI（6099）和 WS（3001）都只绑 127.0.0.1，扫码登录走 `ssh -L 6099:127.0.0.1:6099 -p <NAT映射端口> <用户>@<NAT_IP>`
3. **OneBot WS 走 SSH 隧道回 Windows**：容器里 WS server 配 `127.0.0.1:3001`，Windows 加一条持久隧道（与 docker 隧道并列）：
   ```powershell
   schtasks /create /tn "qqbot-onebot-tunnel" /sc onlogon /rl highest /f `
     /tr "ssh -N -L 3001:127.0.0.1:3001 -p <NAT映射端口> -o ServerAliveInterval=15 -o ServerAliveCountMax=3 <用户>@<NAT_IP>"
   ```
   bot 服务配置完全不用改（`onebotUrl: ws://127.0.0.1:3001`，指向本地隧道入口）
4. **Windows 上只剩**：QQ 客户端卸载都行，只剩 `qqbot-svc` + `opencode serve` + 两条隧道
5. 注意：Linux QQ 同样在腾讯风控体系内（只是形态不同、官方群反馈存活率更好）；**境外数据中心 IP 登录是更高危信号**（所以选内地机器）；小号、限速原则照旧

### 方案 B：framework 模式（带 UI 的正常客户端，抗行为检测）

### 方案 B：framework 模式（带 UI 的正常客户端，抗行为检测）
shell 模式被踢的核心嫌疑是"无窗口 headless 客户端"这个行为特征。framework 模式让 NapCat 住进**正常运行的 QQ**（有窗口、有托盘、行为与真人客户端一致）：

1. **装 LiteLoaderQQNT**（QQ NT 插件加载器，按它仓库 README 操作；会改 QQ 的 `resources/app/package.json` 入口指向 LiteLoader，这是磁盘修改，与 shell 模式二选一）
   - ⚠️ 先确认 LiteLoader 支持你装的 QQ 版本（9.9.32），不支持就按其支持列表选 QQ 版本
2. **放 NapCat framework 包**：官方 Release 下载 `NapCat.Framework.zip`，解压到 LiteLoader 的 `plugins/napcat/` 目录（入口 `napcat.cjs`）
3. **正常启动 QQ**：双击 QQ 图标，窗口正常出现，扫码登录机器人小号，**保持 QQ 窗口常驻**（服务器上挂着一个 RDP 会话或用 tscon 保持会话活跃，别最小化到完全无会话）
4. NapCat WebUI 照常（6099），WS server 配置不变，`qqbot-svc` 服务零改动——OneBot 协议层完全一样
5. LiteLoader 对 QQ 的磁盘 patch 本身是另一个检测面，但"有 UI 的正常客户端"行为特征收益通常大于这个风险；失效了就两个方案换着试

### 其他

| 现象 | 排查 |
|---|---|
| 插件列表没有本插件 / 提示 not in whitelist | 白名单补丁没打上或没重新 build:shell；确认 start.bat 加载的是自编译的 `C:\napcat\napcat.mjs`（对比构建产物 MD5） |
| launcher 报 "provided QQ path is invalid" | QQ 未安装或装在非默认路径，改 start.bat 里 QQ.exe 路径 |
| 插件初始化报 MCP 端口占用 | 5100 被占：三处配置（mcpPort/mcpUrl/mcpUrlForDocker）一起改 |
| @机器人没反应 | 看日志 opencode 请求报错：401=密码不对；ECONNREFUSED=serve 没起；没报错但没回复=模型问题，手动跑 `opencode run --model opencode/deepseek-v4.1-flash-free "hi"` 排查 |
| zen 免费模型报 "usage limit reached" | 免费模型有额度限制（几小时重置），密集测试时悠着点；或 `opencode auth login` 登录 zen 账号提额/换付费模型 |
| 任务 error "沙箱环境不可用" | NapCat 进程里调不到 docker：确认 Docker Desktop 在跑；QQ 进程环境与当前用户一致（docker CLI 在 PATH 里） |
| 容器连不上 MCP | Docker Desktop 自带 host.docker.internal；方式 B 见第 8 节说明；Windows 防火墙放行 5100 |
| 服务器重启后全挂了 | 两个计划任务（opencode-serve / napcat）是否建成 onlogon；服务器需自动登录或改任务为不管登录与否都运行 |
