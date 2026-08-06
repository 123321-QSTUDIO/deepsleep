import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { PluginConfig } from './config'
import { MsgDB, dayKey } from './msgdb'
import { OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRec, TaskRegistry } from './tasks'

interface ExecutorDeps {
  config: PluginConfig
  tasks: TaskRegistry
  sessions: SessionController
  db: MsgDB
  oc: OpencodeClient
  dataPath: string
  sendToScope: (scope: string, text: string) => Promise<void>
  log: (msg: string, ...args: unknown[]) => void
}

interface UserState {
  initialized: boolean
}

const CONTAINER_OPENCODE_JSON = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode/deepseek-v4-flash-free",
  "mcp": {
    "qqbot": {
      "type": "remote",
      "url": "{env:QQBOT_MCP_URL}",
      "enabled": true,
      "headers": {
        "authorization": "Bearer {env:MCP_TOKEN}",
        "x-qqbot-scope": "{env:QQBOT_SCOPE}",
        "x-qqbot-task": "1"
      }
    }
  }
}
`

export class TaskExecutor {
  private queue: TaskRec[] = []
  private running = 0
  private workRoot: string
  private dockerChecked = false
  private dockerOk = false
  private userState = new Map<string, UserState>()
  private userStateFile: string
  private perUser = new Map<string, Promise<void>>()

  constructor(private deps: ExecutorDeps) {
    this.workRoot = path.join(deps.dataPath, 'task-workspaces')
    fs.mkdirSync(this.workRoot, { recursive: true })
    this.userStateFile = path.join(deps.dataPath, 'users.json')
    try {
      if (fs.existsSync(this.userStateFile)) {
        const raw = JSON.parse(fs.readFileSync(this.userStateFile, 'utf-8')) as Record<string, UserState>
        for (const [k, v] of Object.entries(raw)) this.userState.set(k, v)
      }
    } catch {
      // start fresh
    }
  }

  private saveUserState() {
    fs.writeFileSync(this.userStateFile, JSON.stringify(Object.fromEntries(this.userState), null, 2))
  }

  enqueue(rec: TaskRec) {
    this.queue.push(rec)
    void this.pump()
  }

  recoverQueued() {
    for (const rec of this.deps.tasks.pending()) this.queue.push(rec)
    void this.pump()
  }

  private get remote(): boolean {
    return Boolean(this.deps.config.dockerHost)
  }

  private sshTarget(): string | null {
    if (this.deps.config.remoteSsh) return this.deps.config.remoteSsh
    const m = /^ssh:\/\/(.+)$/.exec(this.deps.config.dockerHost)
    return m ? m[1] : null
  }

  private dockerEnvVars(): NodeJS.ProcessEnv {
    return this.deps.config.dockerHost
      ? { ...process.env, DOCKER_HOST: this.deps.config.dockerHost }
      : process.env
  }

  private ssh(script: string): Promise<string> {
    const target = this.sshTarget()
    if (!target) return Promise.reject(new Error('dockerHost 不是 ssh:// 形式，无法执行远程命令'))
    return new Promise((resolve, reject) => {
      const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'bash -s'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', reject)
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`ssh exit ${code}: ${err.slice(-300)}`))))
      p.stdin.write(script)
      p.stdin.end()
    })
  }

  private async ensureDocker(): Promise<boolean> {
    if (this.dockerChecked) return this.dockerOk
    this.dockerChecked = true
    this.dockerOk = await new Promise((resolve) => {
      const p = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', env: this.dockerEnvVars() })
      p.on('error', () => resolve(false))
      p.on('exit', (code) => resolve(code === 0))
    })
    if (!this.dockerOk) this.deps.log('docker 不可用, 任务将无法执行')
    return this.dockerOk
  }

  private async pump() {
    const { config } = this.deps
    while (this.running < config.taskConcurrency && this.queue.length > 0) {
      const rec = this.queue.shift()!
      if (rec.status !== 'queued') continue
      this.running++
      const prev = this.perUser.get(rec.owner_qq) ?? Promise.resolve()
      const chained = prev.then(() => this.run(rec))
      this.perUser.set(rec.owner_qq, chained.catch(() => undefined))
      void chained.finally(() => {
        this.running--
        void this.pump()
      })
    }
  }

  private contextFor(rec: TaskRec): string {
    const lines: string[] = []
    const now = Math.floor(Date.now() / 1000)
    for (const day of [dayKey(now - 86400), dayKey(now)]) {
      try {
        const rows = this.deps.db.query(
          rec.scope,
          day,
          'SELECT time, nickname, user_id, text FROM message ORDER BY msg_pk DESC LIMIT 20',
          []
        )
        for (const r of rows.reverse()) {
          lines.push(`[${new Date(Number(r.time) * 1000).toTimeString().slice(0, 5)}] ${r.nickname || r.user_id}: ${String(r.text ?? '').slice(0, 200)}`)
        }
      } catch {
        // ignore
      }
    }
    return lines.slice(-20).join('\n')
  }

  private buildPrompt(rec: TaskRec, continued: boolean): string {
    const base = `你是后台任务执行助手，一个QQ群友请求了以下任务：

${rec.task}

背景（最近群聊记录，供你理解上下文）：
${this.contextFor(rec)}

要求：
- 你在一个隔离沙箱里，可以随意使用命令行、网络、读写文件（当前目录 /workspace）。
- 你可以用 MCP 工具 query_chat_log 查询更多群聊记录来理解上下文。
- 不要尝试调用 send_message 发消息（已禁用）。
- 完成后，你的最终回复第一行用一句话总结结论（不超过50个字，不要加"结论："以外的前缀），从第二行开始写详细结果（中文，可以包含必要的细节、代码、链接）。`
    return continued ? base : base + '\n- 工作目录 /workspace 里的文件是你自己的持久工作区，产物都放这里。'
  }

  private spawnDocker(args: string[], timeoutSec: number, killCmd: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve, reject) => {
      const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.dockerEnvVars() })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        spawn('docker', killCmd, { stdio: 'ignore', env: this.dockerEnvVars() })
        reject(new Error(`任务超时 (${timeoutSec}s)`))
      }, timeoutSec * 1000)
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      p.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0 && !out.trim()) reject(new Error(`沙箱退出码 ${code}: ${err.slice(-500)}`))
        else resolve({ code, out })
      })
    })
  }

  private containerEnv(rec: TaskRec): string[] {
    const { config } = this.deps
    const env = [
      '-e', `QQBOT_MCP_URL=${config.mcpUrlForDocker}`,
      '-e', `MCP_TOKEN=${config.mcpToken}`,
      '-e', `QQBOT_SCOPE=${rec.scope}`,
    ]
    for (const [k, v] of Object.entries(config.dockerEnv)) {
      if (v) env.push('-e', `${k}=${v}`)
    }
    return env
  }

  private runOneShot(rec: TaskRec, workdir: string): Promise<{ code: number | null; out: string }> {
    const name = `qqbot-task-${rec.task_id}`
    const args = [
      'run', '--rm',
      '--name', name,
      '--add-host=host.docker.internal:host-gateway',
      '-v', `${workdir}:/workspace`,
      '-w', '/workspace',
      ...this.containerEnv(rec),
      this.deps.config.dockerImage,
      'run', this.buildPrompt(rec, false),
    ]
    return this.spawnDocker(args, this.deps.config.taskTimeoutSec, ['kill', name])
  }

  // ---- 远程模式：每 QQ 一个可休眠容器 + 持久 home/workspace + 产物归档 ----

  private userRoot(qq: string): string {
    return `${this.deps.config.remoteWorkRoot}/${qq}`
  }

  private containerName(qq: string): string {
    return `qqbot-user-${qq}`
  }

  private async prepareUserEnv(qq: string) {
    const root = this.userRoot(qq)
    const ocJson = Buffer.from(CONTAINER_OPENCODE_JSON).toString('base64')
    await this.ssh(`
set -e
mkdir -p "${root}/home/.config/opencode" "${root}/workspace" "${root}/archive"
if [ ! -f "${root}/home/.config/opencode/opencode.json" ]; then
  echo "${ocJson}" | base64 -d > "${root}/home/.config/opencode/opencode.json"
fi
latest=$(ls -1t "${root}/archive"/*.tar.gz 2>/dev/null | head -1 || true)
if [ -n "$latest" ]; then
  touch "$latest"
  if [ -z "$(ls -A "${root}/workspace")" ]; then
    tar xzf "$latest" -C "${root}/workspace"
  fi
fi
`)
  }

  private async archiveWorkspace(qq: string): Promise<string | null> {
    const root = this.userRoot(qq)
    const days = this.deps.config.archiveRetentionDays
    const quota = this.deps.config.storageQuotaMB
    const out = await this.ssh(`
set -e
if [ -n "$(ls -A "${root}/workspace")" ]; then
  tar czf "${root}/archive/workspace-$(date +%Y%m%d-%H%M%S).tar.gz" -C "${root}/workspace" .
  rm -rf "${root}/workspace"/* "${root}/workspace"/.[!.]* 2>/dev/null || true
fi
find "${root}/archive" -name '*.tar.gz' -mtime +${days} -delete
while [ "$(du -sm "${root}" 2>/dev/null | cut -f1)" -gt "${quota}" ]; do
  oldest=$(ls -1t "${root}/archive"/*.tar.gz 2>/dev/null | tail -1 || true)
  [ -z "$oldest" ] && break
  rm -f "$oldest"
done
basename "$(ls -1t "${root}/archive"/*.tar.gz 2>/dev/null | head -1)" 2>/dev/null || true
`)
    return out.trim() || null
  }

  private async ensureContainer(qq: string) {
    const name = this.containerName(qq)
    const root = this.userRoot(qq)
    const inspect = await this.spawnDockerQuiet(['inspect', '-f', '{{.State.Status}}', name])
    if (inspect === null) {
      await this.spawnDockerQuiet([
        'create', '--name', name,
        '--add-host=host.docker.internal:host-gateway',
        '-v', `${root}/home:/root`,
        '-v', `${root}/workspace:/workspace`,
        '-w', '/workspace',
        '--entrypoint', 'tail',
        this.deps.config.dockerImage, '-f', '/dev/null',
      ], true)
    }
    if (inspect !== 'running') {
      await this.spawnDockerQuiet(['start', name], true)
    }
  }

  private spawnDockerQuiet(args: string[], throwOnError = false): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.dockerEnvVars() })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d.toString()))
      p.stderr.on('data', (d) => (err += d.toString()))
      p.on('error', (e) => (throwOnError ? reject(e) : resolve(null)))
      p.on('exit', (code) => {
        if (code === 0) resolve(out.trim())
        else if (throwOnError) reject(new Error(`docker ${args[0]} exit ${code}: ${err.slice(-300)}`))
        else resolve(null)
      })
    })
  }

  private async stopContainer(qq: string) {
    await this.spawnDockerQuiet(['stop', this.containerName(qq)])
  }

  private async runRemote(rec: TaskRec): Promise<{ code: number | null; out: string }> {
    const qq = rec.owner_qq
    const name = this.containerName(qq)
    await this.prepareUserEnv(qq)
    await this.ensureContainer(qq)
    const state = this.userState.get(qq) ?? { initialized: false }
    const continueArgs = state.initialized ? ['--continue'] : []
    const args = [
      'exec',
      ...this.containerEnv(rec),
      name,
      'opencode', 'run', ...continueArgs, this.buildPrompt(rec, state.initialized),
    ]
    try {
      return await this.spawnDocker(args, this.deps.config.taskTimeoutSec, ['stop', name])
    } finally {
      await this.stopContainer(qq)
      state.initialized = true
      this.userState.set(qq, state)
      this.saveUserState()
      try {
        const artifact = await this.archiveWorkspace(qq)
        if (artifact && this.deps.config.artifactBaseUrl) {
          const token = this.deps.config.artifactToken ? `?token=${this.deps.config.artifactToken}` : ''
          this.deps.tasks.update(rec.task_id, {
            artifact_url: `${this.deps.config.artifactBaseUrl.replace(/\/$/, '')}/${qq}/archive/${artifact}${token}`,
          })
        }
      } catch (e) {
        this.deps.log(`归档失败 ${qq}:`, e)
      }
    }
  }

  // ---- 主流程 ----

  private async run(rec: TaskRec) {
    const { tasks, log } = this.deps
    log(`任务 ${rec.task_id} 开始执行 (属主 ${rec.owner_qq})`)
    tasks.update(rec.task_id, { status: 'running' })
    const workdir = path.join(this.workRoot, rec.task_id)
    fs.mkdirSync(workdir, { recursive: true })

    if (!(await this.ensureDocker())) {
      tasks.update(rec.task_id, { status: 'error', error: '沙箱环境不可用（docker 未安装或未启动）', finished_at: Math.floor(Date.now() / 1000) })
      await this.deliver(tasks.get(rec.task_id)!)
      return
    }

    try {
      const { out } = this.remote ? await this.runRemote(rec) : await this.runOneShot(rec, workdir)
      const text = out.trim()
      const firstBreak = text.indexOf('\n')
      const summary = (firstBreak > 0 ? text.slice(0, firstBreak) : text).trim().slice(0, 80)
      const result = firstBreak > 0 ? text.slice(firstBreak + 1).trim() : text
      tasks.update(rec.task_id, {
        status: 'done',
        summary: summary || '任务完成',
        result: result || text,
        finished_at: Math.floor(Date.now() / 1000),
      })
      log(`任务 ${rec.task_id} 完成`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      tasks.update(rec.task_id, { status: 'error', error: msg, finished_at: Math.floor(Date.now() / 1000) })
      log(`任务 ${rec.task_id} 失败: ${msg}`)
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true })
    }
    await this.deliver(tasks.get(rec.task_id)!)
  }

  private async deliver(rec: TaskRec) {
    const { sendToScope, log } = this.deps
    try {
      const privateScope = `private-${rec.owner_qq}`
      if (rec.status === 'done') {
        const chunks = this.chunk(rec.result, 800)
        for (const c of [`你的任务「${rec.task.slice(0, 60)}」搞定了，详细结果：`, ...chunks]) {
          await sendToScope(privateScope, c).catch((e) => log('私聊投递失败:', e))
        }
        if (rec.artifact_url) {
          await sendToScope(privateScope, `产物打包下载（${this.deps.config.archiveRetentionDays}天内有效，每次新任务自动续期）：\n${rec.artifact_url}`).catch(() => undefined)
        }
        await this.injectToScope(privateScope, `[系统] 你的任务 ${rec.task_id} 已完成。结论：${rec.summary}\n详细结果：\n${rec.result.slice(0, 3000)}`)
        if (rec.group_id) {
          await this.injectToScope(
            rec.scope,
            `[系统通知] 你之前受理的任务「${rec.task.slice(0, 60)}」(编号 ${rec.task_id}) 已经完成了。结论：${rec.summary}。详细结果已经私聊发给发起人(QQ ${rec.owner_qq})。请你现在用一两句话把结论发到群里，记得@发起人并回复他提问的那条消息（send_message 的 at_qq 填 ${rec.owner_qq}，reply_to 填 ${rec.message_id ?? ''}）。`
          )
        }
      } else {
        await sendToScope(privateScope, `你的任务「${rec.task.slice(0, 60)}」没跑成：${rec.error}`).catch(() => undefined)
        await this.injectToScope(privateScope, `[系统] 任务 ${rec.task_id} 失败：${rec.error}`)
        if (rec.group_id) {
          await this.injectToScope(
            rec.scope,
            `[系统通知] 任务「${rec.task.slice(0, 60)}」(编号 ${rec.task_id}) 失败了：${rec.error}。请你用一句话告诉发起人(QQ ${rec.owner_qq})，@他并回复他提问的那条消息（send_message 的 at_qq 填 ${rec.owner_qq}，reply_to 填 ${rec.message_id ?? ''}），语气自然点。`
          )
        }
      }
    } catch (e) {
      log('结果投递失败:', e)
    }
  }

  private async injectToScope(scope: string, text: string) {
    const sessionId = this.deps.sessions.sessionIdOf(scope)
    if (!sessionId) return
    if (text.startsWith('[系统通知]')) {
      await this.deps.oc.promptAsync(sessionId, text)
    } else {
      await this.deps.oc.inject(sessionId, text)
    }
  }

  private chunk(text: string, size: number): string[] {
    const out: string[] = []
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
    return out.length > 0 ? out : ['(没有详细输出)']
  }
}
