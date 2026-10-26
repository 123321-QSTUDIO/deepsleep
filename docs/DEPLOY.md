# 部署手册（Windows Server 版）

> **只部署独立服务形态**：机器人是独立 Node 进程，通过 OneBot v11 WebSocket 连接 QQ 网关（推荐 SnowLuma，兼容 NapCat 等 OneBot v11 实现）。
> 更新只需重启 bot 进程，不动 QQ/网关进程。旧的 NapCat 进程内插件形态已停止维护。

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
> 服务配置 `mcpUrlForDocker` 要改成 `http://<Windows主机IP>:5100/mcp`，且 `mcpHost` 要设 `0.0.0.0`。

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

服务配置（见第 8 节）：
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
服务配置保持：`mcpHost: 127.0.0.1`、`mcpUrlForDocker: http://host.docker.internal:5100/mcp`
（容器经 host-gateway 到达远程主机的 5100 = 隧道入口，转发回本机回环 MCP）

方案 C-2b（简单，MCP 暴露公网但限源 IP）：
- `mcpHost: 0.0.0.0`
- `mcpUrlForDocker: http://<Windows服务器公网IP>:5100/mcp`
- Windows 防火墙：5100 入站只允许远程 docker 主机的 IP
- 注意：HTTP 明文，mcpToken 会在公网传输（被中间人看到即可调 MCP），介意就用 C-2a

服务配置相应字段（见第 8 节）：
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
（opencode 对 zen 免费模型内置 `apiKey: "public"`，开箱即用）。服务会给每个工作区自动写入默认模型；配置加载会自动迁移已知旧模型 ID，旧 session 若仍存弃用模型则执行 `/reset` 重建。
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

## 3. 构建服务

```powershell
mkdir C:\qqbot; cd C:\qqbot
git clone https://github.com/123321-QSTUDIO/deepsleep.git
cd deepsleep
# 旧仓库名 napcat-plugin-qqbot 已改为 deepsleep（GitHub 旧链接自动跳转）；
# 已有部署把代码目录换成 deepsleep 即可，dist-service 与数据目录契约不变
npm ci
npm run typecheck
npm run build
node smoke.mjs     # 期望输出 SMOKE TEST 1 PASS
```

【验证】`ls dist-service` 有 `index.mjs`、`app.mjs`、`sql-wasm.wasm`。

## 4. QQ 网关：SnowLuma（替代 NapCat）

SnowLuma 是第三方 OneBot v11 协议端：把桌面 QQ 的原生会话桥接成 OneBot v11（动作 + 事件），多个 QQ 号可并行。本服务只通过 OneBot 协议对接，**不包含也不分发其代码**。

> **许可注意**：SnowLuma 是**源码可见、非 OSI 开源**项目（学习/非商业自托管可用；商业使用、公开发布修改版或衍生版需其书面授权）。使用前请阅读其 `LICENSE` / `EULA.md`。

- 项目与 Releases：https://github.com/SnowLuma/SnowLuma （下载 `win-x64` 包；完整版自带 Node，Lite 版需 Node.js ≥22）
- 默认端口：**WebUI 5099** / OneBot HTTP 3000 / **OneBot WebSocket 3001**
- 官方部署文档：https://snowluma.github.io/zh/docs/guide/deploy
- 与 NapCat 的关系：两者都输出 OneBot v11，本服务的 `onebotUrl`/`onebotToken` 配置方式不变；迁移见 7b 节

## 5. 安装 QQ 桌面版

- 安装官方 Windows 桌面版 QQ（NT 架构），能正常打开 `QQ.exe`
- 机器人建议用**小号**；`QQ 版本 - SnowLuma hook` 需要版本匹配，QQ 自动升级后若 hook 失效，等 SnowLuma 更新或回退 QQ 版本（见其 README/WebUI 版本说明）
- **SnowLuma 必须与 QQ 用同一个 Windows 用户运行、权限保持一致**，否则 hook 注入失败

## 6. 部署并登录 SnowLuma

```powershell
# 1) 下载 win-x64 发行包（完整版或 Lite 版）并解压到固定目录
mkdir C:\SnowLuma
# 把 SnowLuma-<TAG>-win-x64.zip 解压到 C:\SnowLuma（或 tar -xzf *.tar.gz -C C:\SnowLuma）

# 2) 启动 QQ（先开 QQ 或先开 SnowLuma 都行，它会自动探测并注入 QQ.exe）
# 3) 启动 SnowLuma
cd C:\SnowLuma
.\launcher.bat
```

- 首次启动（全新数据目录）控制台会输出**一次性管理员密码**，用它登录 http://127.0.0.1:5099/
- 登录**只支持扫码**：在 QQ 窗口用手机 QQ 扫码登录机器人小号
- 数据目录下的配置：`config/onebot.json`（全局默认）、`config/onebot_<uin>.json`（每账号）、`config/runtime.json`（WebUI 端口/hookAutoLoad 等）
- 常驻：用计划任务/服务把 `launcher.bat`（或 `node index.mjs`）设为开机自启，与 QQ 同用户运行

【验证】WebUI 显示账号在线；控制台无 hook 注入错误；`127.0.0.1:3001` 有 WS 监听。

## 7. 配置 OneBot 并部署机器人服务

**SnowLuma 侧**（WebUI → OneBot 配置，或直接改 `config/onebot_<uin>.json`）：
- 正向 **WebSocket 服务器**：`127.0.0.1:3001`，`accessToken` 设一个强随机串
- 鉴权：`Authorization: Bearer <token>`（也支持 `?access_token=`）；HTTP 与 WS 可能是不同 token
- 只在本机访问时保持回环；不要把 5099/3000/3001 裸暴露公网

```powershell
mkdir C:\qqbot-svc
xcopy /E /I C:\qqbot\deepsleep\dist-service C:\qqbot-svc
```

**服务侧**（`C:\qqbot-svc\data\config.json`，首次运行自动生成）：
- `onebotUrl`：`ws://127.0.0.1:3001`
- `onebotToken`：上一步 SnowLuma 里设的 WS token

```powershell
# 前台测试一次（Ctrl+C 退出）
cd C:\qqbot-svc; node index.mjs

# 常驻（计划任务，开机自启）
schtasks /create /tn "qqbot-svc" /sc onlogon /rl highest /f `
  /tr "cmd /c cd /d C:\qqbot-svc && node index.mjs > C:\qqbot-svc\svc.log 2>&1"
```

【验证】`Get-Content C:\qqbot-svc\svc.log -Tail 5` 看到 `启动完成 ... (在线)` 与 `OneBot WS 已连接`；群里 @机器人 有回复。

## 7b. 从旧部署迁移

- **从 NapCat 网关迁移**：SnowLuma 和 NapCat 都是 OneBot v11，默认 WS 端口都是 3001。装好 SnowLuma、配好同端口和 token 后，服务配置 `onebotUrl`/`onebotToken` 可以不变；消息库、会话、任务数据都在服务自己的数据目录里，无需迁移。
- **从旧的 NapCat 进程内插件模式迁移**：插件形态已停止维护（`src/index.ts` 已删除）。把旧插件数据目录（`C:\napcat-data\config\plugins\deepsleep\`）下的 `messages`、`sessions.json`、`tasks.json`、`users.json`、`workspaces` 拷到 `C:\qqbot-svc\data\`，配置按第 8 节合并即可。

## 8. 配置服务

编辑 `C:\qqbot-svc\data\config.json`（首次运行自动生成）：

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
  "panelToken": "CHANGE_ME_PANEL_TOKEN",
  "dreamMemoryEnabled": true,
  "dreamMemoryHour": 4,
  "dreamMemoryMinute": 30,
  "dreamMaxTranscriptChars": 120000,
  "dreamMemoryMaxChars": 8000
}
```

- `hostModel`：host 层每个工作区的默认模型，默认 `opencode/deepseek-v4.1-flash-free`；已知旧模型 ID 会在配置加载时自动迁移，旧 session 存了弃用模型则 `/reset`
- `visionModel`：视觉桥接 subagent（vision-bridge）用的识图模型，默认 `opencode/mimo-v2.6-flash-free`。图片消息会下载到工作目录 `inbox/`，由纯文本主模型通过 **subagent** 工具调桥接代理读图，**不是**直接切换主模型
- 工作区 opencode.json 使用 `agents` + `system`、`mcp.servers` 和 `codemode: false`。MCP 共 10 个工具，模型可见名带 `qqbot_` 前缀（如 `qqbot_send_message`、`qqbot_list_stickers`/`qqbot_send_sticker`（收藏表情包）、`qqbot_query_chat_log`、`qqbot_submit_task`），MCP 服务注册名不变
- `mcpHost`：MCP 服务绑定地址，默认 `127.0.0.1`（回环）。**服务器有公网 IP 直绑网卡时切勿改成 0.0.0.0**；方式 B（WSL2 docker）确需容器访问时才改为 `0.0.0.0` 并配合防火墙只放行容器网段
- `opencodePassword` 必须等于第 2 步显式设置的 `OPENCODE_PASSWORD`，不能为空或写成可选项
- `dockerHost`：留空 = 本机 docker；方式 C 填 `tcp://127.0.0.1:2375`（走持久 SSH 隧道，见方式 C-1）
- `remoteSsh`：方式 C 必填，`<HK用户>@<HK_IP>`，远程文件操作（建目录/解压/归档）走这条 SSH
- `remoteSshKey`：可选，私钥绝对路径（如 `C:\qqbot-svc\hk_key`）。**服务进程若以非交互式用户启动（计划任务/服务），ssh 可能找不到 `~/.ssh` 里的密钥导致 BatchMode 失败——此时务必显式配置此项**，密钥用 `ssh-keygen -t ed25519 -f C:\qqbot-svc\hk_key -N '""'` 生成，公钥加到 HK 的 authorized_keys
- `storageQuotaMB`：每个 QQ 的持久目录（home+workspace+archive）总配额，默认 500MB，超了从最旧归档开始删
- `artifactBaseUrl` / `artifactToken` / `linkTtlMinutes`：产物下载服务（见 9.1 节）；链接为 HMAC 签名临时链接，默认 10 分钟有效，有效期内重复索要返回同一链接（不重复生成），失效后才能生成新链接
- `archiveRetentionDays`：产物归档留存天数（默认 5），**每次该 QQ 的 session 被激活会自动刷新最近归档的过期时间**
- `replyDelayMinMs` / `replyDelayMaxMs` 默认 `1200` / `3000` 毫秒，`maxLinesPerReply` 默认 `4`
- `panelEnabled` / `panelHost` / `panelPort` / `panelToken`：控制面板（见 8.1 节）。默认开启、只绑 `127.0.0.1:5101`；**远程访问必须设 `panelToken`**
- `dreamMemoryEnabled` / `dreamMemoryHour` / `dreamMemoryMinute`：梦境记忆（见 8.2 节）。默认每天 4:30（服务器本地时区）整理 MEMORY.md 并压缩会话；`dreamMaxTranscriptChars` 限单次喂入的聊天记录字符数，`dreamMemoryMaxChars` 限 MEMORY.md 目标字数
- `dockerEnv`：**用免费模型时留空 `{}` 即可**；要给容器换付费模型时才填 key（如 `ANTHROPIC_API_KEY`），同时调整 qqbot-hk-runner 的模型配置并重新 build 镜像
- 方式 B（WSL2 docker）时 `mcpUrlForDocker` 改为 `http://<Windows主机IP>:5100/mcp`；方式 C 改为 `http://<本机IP>:5100/mcp`
- 改完重启机器人服务生效

## 8.1 控制面板（推荐开启）

机器人进程内置 WebUI 控制面板，部署完即可用：

- 本机直接打开 <http://127.0.0.1:5101/>（服务器上则用 SSH 隧道：`ssh -N -L 5101:127.0.0.1:5101 <用户>@<服务器IP>`，再在本机浏览器打开同一地址）
- `panelToken` 非空时，页面会提示输入 token（也能用 `http://127.0.0.1:5101/?token=xxx` 直接进）
- 功能：表单改全部配置（写回 config.json，部分字段提示需重启）、看所有群/私聊会话与 Session 状态、打开某个会话看 OpenCode 对话/QQ 消息记录/工作区文件、执行 `/reset`、`/abort`、以机器人身份发 QQ 消息、把文字作为 prompt 直接发给 Agent
- **模型（「模型」页）**：直接读 OpenCode 的 `/api/model` 动态目录，免费模型（provider `opencode`、cost 全 0）标「免费」并排在前面；模型列表会随 OpenCode 更新/下架，**免费模型失效时刷新页面选一个新免费模型即可**。
  - 「切换到所有 Session」= 更新默认配置 + 逐会话调用 `POST /api/session/:id/model`，**保留已有对话上下文**，不会清空会话；之后新建会话也用新默认模型
  - 识图模型（vision-bridge 子代理）单独切换，只更新配置和工作区，不改已有会话
  - 如果 OpenCode 不在线/插件未就绪，模型页会提示读取目录失败，先恢复 OpenCode 再操作
- **收藏表情（「表情」页）**：点「同步收藏表情」从当前 QQ 拉取收藏夹里的自定义表情（带预览图）；点任一表情即可编辑描述/合集/分类并启用；顶部「多选」可一次框选多个表情「新建合集/归入合集」或批量启停（表情商店下载的包建议归成同一合集，用合集总开关管理整组）。合集也可以删除：删除只是解散合集，里面的表情回到未分组、描述/启用状态保留。启用后 Agent 才能用。QQ 原始描述可能为空/不准（`[动画表情]` 之类的占位不会自动当标签），**未打标的表情绝不会暴露给 Agent**；Agent 工具里显示「合集:描述」，不同合集的同名表情可区分。数据存在 `data/stickers.json`，重复同步保留标签/合集/启用状态
- **安全**：默认只绑回环；不要把 `panelHost` 改成 `0.0.0.0` 直接暴露公网。SSH 隧道/反代场景请务必设置 `panelToken`（面板能看到配置里的密钥，也能改配置）

【验证】`curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:5101/api/status`：设了 token 返回 401 属正常；页面 `http://127.0.0.1:5101/` 返回 200。

## 8.2 梦境记忆（默认已开启）

每个工作区有一个 `MEMORY.md` 作为长期记忆，通过 workspace `opencode.json` 的 `instructions` 注入，不再让 session 上下文无限增长。每天凌晨（默认 4:30 本地时间）：

1. `fork` 原 session（继承上下文，不动原 session）
2. 把最近 24 小时群聊记录喂给梦境会话，让它读取旧 MEMORY.md 并写出 `MEMORY.new.md`
3. 校验后备份旧记忆（`MEMORY.md.bak`）→ 原子替换 MEMORY.md
4. 删除临时梦境会话
5. `compact` 原 session（摘要接管旧上下文，并让新 instructions 生效）

- 服务进程需要跑着；在整理窗口（4:30 起 3 小时内）重启也会补跑，错过则等第二天
- 失败不会破坏旧记忆（不动 MEMORY.md、不 compact），原因记录在数据目录 `dream.json` 与面板会话详情「梦境记忆」卡片
- 面板「会话详情 → 梦境记忆」有「立即整理」按钮可手动触发；工作区文件标签可直接查看 MEMORY.md
- **instructions 是 session 级快照**：手动改 MEMORY.md 对已存在 session 不会立即生效，需 compact（或 /reset 重建、或等下一次梦境整理）

【验证】面板打开任一有 session 的群会话 → 「梦境记忆」卡片应显示上次整理时间/记忆字数/是否已压缩；点击「立即整理」后 1-3 分钟出现结果，工作区文件中 MEMORY.md 内容被更新。

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
- 链接机制：服务按需 HMAC 签名生成（`?exp=&sig=`），默认 24 小时有效（`linkTtlHours`），**机器人不主动发链接，用户私聊索要时才生成**；产物到期前一天机器人会主动私聊提醒用户留存
- 服务配置填 `artifactBaseUrl: "https://<域名>"` 和 `artifactToken`（与脚本参数一致），重启服务生效

## 10. 部署完成检查单

- [ ] `opencode --version` 与任务镜像内版本均为 2.1.4
- [ ] `curl.exe -u opencode:PASS http://127.0.0.1:4096/api/info` 返回 200（也可用 `/api/session/active`）
- [ ] 控制面板 `http://127.0.0.1:5101/` 可打开，能列出会话、保存一次配置（设置了 panelToken 时记得带上）
- [ ] 群会话工作区已有 `MEMORY.md`，面板会话详情「梦境记忆」卡片存在（可点一次「立即整理」验证端到端）
- [ ] 面板「表情」页能同步出收藏表情，至少打标并启用 1 个（之后可让 Agent 发一次验证）
- [ ] `curl.exe -s -X POST -H "authorization: Bearer MCP_TOKEN" -H "content-type: application/json" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}' http://127.0.0.1:5100/mcp` 返回 JSON（不是 401/404）
- [ ] QQ 在线，机器人在测试群里
- [ ] 日志有 `[qqbot] 初始化完成`
- [ ] `docker images | Select-String qqbot-opencode-task` 有镜像

全部打勾后进入 `docs/TEST_PLAN.md`。

## 常见问题

### 风控与下线（必读）

SnowLuma 采用 hook 注入桌面 QQ 的方式，客户端行为与正常 QQ 一致，风险面通常比 headless shell 小，但仍受腾讯风控约束：

- 机器人用**小号**；分句限速（本服务的随机间隔/合并逻辑）仍是第一道防线
- 群内少发链接（链接是重点审查对象），不要用机器人号加来源不明的群
- 被踢下线后重新扫码登录即可；本服务的会话/任务状态都在自己数据目录，不受影响
- SnowLuma hook 与 QQ 版本强相关：QQ 自动升级后 hook 可能失效，等 SnowLuma 更新或回退 QQ 版本
- 更细的风控/部署说明以 SnowLuma 官方文档与其用户群为准

### 其他

| 现象 | 排查 |
|---|---|
| 服务连不上网关 | 检查 SnowLuma WebUI 的 OneBot WebSocket 配置（127.0.0.1:3001 + token 与 config.json 一致）；服务日志看 WS 连接错误 |
| SnowLuma hook 注入失败 | 确认 SnowLuma 与 QQ 同一 Windows 用户/权限；QQ 版本是否在 SnowLuma 支持范围；看 WebUI/控制台日志 |
| 服务启动报 MCP 端口占用 | 5100 被占：三处配置（mcpPort/mcpUrl/mcpUrlForDocker）一起改 |
| @机器人没反应 | 看日志 opencode 请求报错：401=密码不对；ECONNREFUSED=serve 没起；没报错但没回复=模型问题，手动跑 `opencode run --model opencode/deepseek-v4.1-flash-free "hi"` 排查 |
| zen 免费模型报 "usage limit reached" | 免费模型有额度限制（几小时重置），密集测试时悠着点；或 `opencode auth login` 登录 zen 账号提额/换付费模型 |
| 任务 error "沙箱环境不可用" | 服务进程调不到 docker：确认 Docker Desktop 在跑；QQ 进程环境与当前用户一致（docker CLI 在 PATH 里） |
| 容器连不上 MCP | Docker Desktop 自带 host.docker.internal；WSL2 方式见第 1 节说明；Windows 防火墙放行 5100 |
| 服务器重启后全挂了 | 计划任务（opencode-serve / SnowLuma / qqbot-svc）是否都建成 onlogon；服务器需自动登录或改任务为不管登录与否都运行 |
