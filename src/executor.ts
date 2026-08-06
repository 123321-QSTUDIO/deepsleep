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

export class TaskExecutor {
  private queue: TaskRec[] = []
  private running = 0
  private workRoot: string
  private dockerChecked = false
  private dockerOk = false

  constructor(private deps: ExecutorDeps) {
    this.workRoot = path.join(deps.dataPath, 'task-workspaces')
    fs.mkdirSync(this.workRoot, { recursive: true })
  }

  enqueue(rec: TaskRec) {
    this.queue.push(rec)
    void this.pump()
  }

  recoverQueued() {
    for (const rec of this.deps.tasks.pending()) this.queue.push(rec)
    void this.pump()
  }

  private async ensureDocker(): Promise<boolean> {
    if (this.dockerChecked) return this.dockerOk
    this.dockerChecked = true
    this.dockerOk = await new Promise((resolve) => {
      const p = spawn('docker', ['--version'], { stdio: 'ignore' })
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
      void this.run(rec).finally(() => {
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

  private buildPrompt(rec: TaskRec): string {
    return `你是后台任务执行助手，一个QQ群友请求了以下任务：

${rec.task}

背景（最近群聊记录，供你理解上下文）：
${this.contextFor(rec)}

要求：
- 你在一个一次性的隔离沙箱里，可以随意使用命令行、网络、读写文件（当前目录 /workspace）。
- 你可以用 MCP 工具 query_chat_log 查询更多群聊记录来理解上下文。
- 不要尝试调用 send_message 发消息（已禁用）。
- 完成后，你的最终回复第一行用一句话总结结论（不超过50个字，不要加"结论："以外的前缀），从第二行开始写详细结果（中文，可以包含必要的细节、代码、链接）。`
  }

  private async dockerRun(rec: TaskRec, workdir: string): Promise<{ code: number | null; out: string }> {
    const { config } = this.deps
    const name = `qqbot-task-${rec.task_id}`
    const args = [
      'run', '--rm',
      '--name', name,
      '--add-host=host.docker.internal:host-gateway',
      '-v', `${workdir}:/workspace`,
      '-w', '/workspace',
      '-e', `QQBOT_MCP_URL=${config.mcpUrlForDocker}`,
      '-e', `MCP_TOKEN=${config.mcpToken}`,
      '-e', `QQBOT_SCOPE=${rec.scope}`,
    ]
    for (const [k, v] of Object.entries(config.dockerEnv)) {
      if (v) args.push('-e', `${k}=${v}`)
    }
    args.push(config.dockerImage, 'run', this.buildPrompt(rec))

    return new Promise((resolve, reject) => {
      const p = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        spawn('docker', ['kill', name], { stdio: 'ignore' })
        reject(new Error(`任务超时 (${config.taskTimeoutSec}s)`))
      }, config.taskTimeoutSec * 1000)
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

  private async run(rec: TaskRec) {
    const { tasks, log } = this.deps
    log(`任务 ${rec.task_id} 开始执行`)
    tasks.update(rec.task_id, { status: 'running' })
    const workdir = path.join(this.workRoot, rec.task_id)
    fs.mkdirSync(workdir, { recursive: true })

    if (!(await this.ensureDocker())) {
      tasks.update(rec.task_id, { status: 'error', error: '沙箱环境不可用（docker 未安装或未启动）', finished_at: Math.floor(Date.now() / 1000) })
      await this.deliver(tasks.get(rec.task_id)!)
      return
    }

    try {
      const { out } = await this.dockerRun(rec, workdir)
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
