import http from 'node:http'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { PluginConfig } from './config'
import { MsgDB, dayKey } from './msgdb'
import { SessionController } from './sessions'
import { TaskRec, TaskRegistry } from './tasks'
import { MuteStore } from './mutes'

interface McpDeps {
  config: PluginConfig
  db: MsgDB
  sessions: SessionController
  tasks: TaskRegistry
  mutes: MuteStore
  enqueueTask: (rec: TaskRec) => void
  log: (msg: string, ...args: unknown[]) => void
}

function hhmm(timeSec: number): string {
  const d = new Date(timeSec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function text(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export class QqMcpServer {
  private server: http.Server | null = null
  private issuedLinks = new Map<string, { url: string; exp: number }>()

  constructor(private deps: McpDeps) {}

  private searchChatLog(scope: string, keyword: string | undefined, hours: number, limit: number): string {
    const now = Math.floor(Date.now() / 1000)
    const since = now - hours * 3600
    const sinceDay = dayKey(since)
    const days = this.deps.db.listDays(scope).filter((d) => d >= sinceDay)
    const rows: { time: number; nickname: string; user_id: number; text: string }[] = []
    for (const day of days) {
      try {
        const r = this.deps.db.query(
          scope,
          day,
          `SELECT time, nickname, user_id, text FROM message
           WHERE time >= ? ${keyword ? 'AND text LIKE ?' : ''}
           ORDER BY msg_pk DESC LIMIT ?`,
          keyword ? [since, `%${keyword}%`, limit] : [since, limit]
        )
        rows.push(...(r as unknown as typeof rows))
      } catch {
        // skip unreadable day file
      }
    }
    rows.sort((a, b) => a.time - b.time)
    const sliced = rows.slice(-limit)
    if (sliced.length === 0) return '没有找到符合条件的聊天记录'
    return sliced.map((r) => `[${hhmm(r.time)}] ${r.nickname || r.user_id}(${r.user_id}): ${r.text}`).join('\n')
  }

  private buildServer(scope: string, taskMode: boolean): McpServer {
    const { sessions, tasks, enqueueTask } = this.deps
    const mcp = new McpServer({ name: 'qqbot', version: '0.1.0' })

    mcp.registerTool(
      'send_message',
      {
        description: '发送一条消息到当前QQ对话（群或私聊）。每说一句话调用一次。可以用[CQ:at,qq=QQ号]@人、[CQ:face,id=数字]发表情。',
        inputSchema: {
          text: z.string().describe('消息内容，尽量不超过30个字'),
          reply_to: z.string().optional().describe('要引用的消息ID（回复某条消息时用）'),
          at_qq: z.string().optional().describe('要@的人的QQ号'),
        },
      },
      async ({ text: t, reply_to, at_qq }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能发消息')
        await sessions.sendTextToScope(scope, t, { replyTo: reply_to, atQq: at_qq })
        sessions.markSentByScope(scope)
        return text('已发送')
      }
    )

    mcp.registerTool(
      'query_chat_log',
      {
        description: '查询当前对话的聊天记录库',
        inputSchema: {
          keyword: z.string().optional().describe('关键词，模糊匹配，不传则查最近消息'),
          hours: z.number().optional().describe('往前查多少小时，默认24'),
          limit: z.number().optional().describe('最多返回多少条，默认50'),
        },
      },
      async ({ keyword, hours, limit }) => {
        if (!scope) return text('错误: 未知对话上下文')
        return text(this.searchChatLog(scope, keyword, hours ?? 24, Math.min(limit ?? 50, 200)))
      }
    )

    mcp.registerTool(
      'submit_task',
      {
        description: '把复杂任务提交给后台沙箱执行（探索代码、跑命令、查资料等）。提交后立即返回，完成后系统会自动把结论发到群里、详细结果私聊发给提问的人。',
        inputSchema: { task: z.string().describe('任务描述，写清楚要做什么、相关的上下文') },
      },
      async ({ task }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务不能嵌套提交任务')
        const trigger = sessions.triggerOf(scope)
        if (!trigger || !trigger.userId) return text('错误: 找不到任务发起人')
        const rec = tasks.create({
          owner_qq: String(trigger.userId),
          group_id: trigger.groupId !== null ? String(trigger.groupId) : null,
          message_id: trigger.messageId || null,
          scope,
          task,
        })
        enqueueTask(rec)
        return text(`任务已受理，编号 ${rec.task_id}`)
      }
    )

    mcp.registerTool(
      'list_tasks',
      { description: '查询当前私聊对象自己发起过的任务列表（仅私聊可用）', inputSchema: {} },
      async () => {
        if (!scope.startsWith('private-')) return text('错误: 请在私聊中查询任务')
        const list = tasks.byOwner(scope.slice(8)).slice(0, 20)
        if (list.length === 0) return text('你还没有提交过任务')
        return text(
          list
            .map((t) => {
              const statusText = { queued: '排队中', running: '执行中', done: '已完成', error: '出错了' }[t.status]
              return `${t.task_id} [${statusText}] ${t.task.slice(0, 50)}${t.summary ? ` —— ${t.summary}` : ''}`
            })
            .join('\n')
        )
      }
    )

    mcp.registerTool(
      'get_task_detail',
      {
        description: '查看某个任务的详细状态和结果（只能查自己发起的任务）',
        inputSchema: { task_id: z.string() },
      },
      async ({ task_id }) => {
        const rec = tasks.get(task_id)
        if (!rec) return text('错误: 任务不存在')
        if (!scope.startsWith('private-') || rec.owner_qq !== scope.slice(8)) {
          return text(`任务 ${task_id} 当前状态: ${rec.status}（详细内容只有任务发起人可以查看）`)
        }
        const parts = [`任务 ${rec.task_id}`, `状态: ${rec.status}`, `内容: ${rec.task}`]
        if (rec.summary) parts.push(`结论: ${rec.summary}`)
        if (rec.result) parts.push(`结果:\n${rec.result.slice(0, 4000)}`)
        if (rec.error) parts.push(`错误: ${rec.error}`)
        return text(parts.join('\n'))
      }
    )

    mcp.registerTool(
      'get_download_link',
      {
        description: '为当前私聊对象生成其任务产物的临时下载链接（签名有过期时间）。不传 task_id 时取最近一次有产物的任务。',
        inputSchema: { task_id: z.string().optional().describe('任务编号，不传取最近') },
      },
      async ({ task_id }) => {
        if (!scope.startsWith('private-')) return text('错误: 请在私聊中使用')
        const { config } = this.deps
        if (!config.artifactBaseUrl || !config.artifactToken) return text('错误: 产物下载服务未配置')
        const owner = scope.slice(8)
        const rec = task_id
          ? tasks.get(task_id)
          : tasks.byOwner(owner).find((t) => t.artifact_file)
        if (!rec) return text('没有找到对应的任务')
        if (rec.owner_qq !== owner) return text('只能下载自己的任务产物')
        if (!rec.artifact_file) return text('这个任务没有产物包')
        const now = Math.floor(Date.now() / 1000)
        const existing = this.issuedLinks.get(rec.task_id)
        if (existing && existing.exp > now) {
          const leftMin = Math.ceil((existing.exp - now) / 60)
          return text(`之前的链接还没失效（还剩约${leftMin}分钟），继续用这个：\n${existing.url}`)
        }
        const exp = now + config.linkTtlMinutes * 60
        const rel = `${owner}/archive/${rec.artifact_file}`
        const sig = crypto.createHmac('sha256', config.artifactToken).update(`${rel}:${exp}`).digest('hex')
        const url = `${config.artifactBaseUrl.replace(/\/$/, '')}/${rel}?exp=${exp}&sig=${sig}`
        this.issuedLinks.set(rec.task_id, { url, exp })
        return text(`下载链接（${config.linkTtlMinutes}分钟内有效）：\n${url}`)
      }
    )

    mcp.registerTool(
      'mute_user',
      {
        description: '临时屏蔽某个群友：在指定时间内他的消息不会触发你回复。谨慎使用（见 AGENTS.md 的使用原则）。屏蔽时建议你用 send_message 告知对方原因和时长。',
        inputSchema: {
          qq: z.string().describe('对方QQ号'),
          minutes: z.number().describe('屏蔽时长（分钟），最大1440'),
          reason: z.string().optional().describe('原因（自己记录用）'),
        },
      },
      async ({ qq, minutes, reason }) => {
        if (!scope.startsWith('group-')) return text('错误: 屏蔽功能仅在群聊中使用')
        const mins = Math.min(Math.max(1, Math.floor(minutes)), 1440)
        const until = this.deps.mutes.mute(scope, qq, mins, reason ?? '')
        return text(`已屏蔽 ${qq} ${mins} 分钟（到 ${new Date(until * 1000).toLocaleTimeString('zh-CN')}）`)
      }
    )

    mcp.registerTool(
      'unmute_user',
      {
        description: '解除对某个群友的屏蔽',
        inputSchema: { qq: z.string() },
      },
      async ({ qq }) => {
        if (!scope.startsWith('group-')) return text('错误: 屏蔽功能仅在群聊中使用')
        return text(this.deps.mutes.unmute(scope, qq) ? `已解除对 ${qq} 的屏蔽` : `${qq} 本来就没被屏蔽`)
      }
    )

    return mcp
  }

  start(): Promise<void> {
    const { config, log } = this.deps
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/mcp') {
          res.writeHead(404).end()
          return
        }
        if (this.deps.config.mcpToken) {
          const auth = req.headers.authorization ?? ''
          if (auth !== `Bearer ${this.deps.config.mcpToken}`) {
            res.writeHead(401).end()
            return
          }
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' }).end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'stateless server: POST only' }, id: null })
          )
          return
        }
        const scope = String(req.headers['x-qqbot-scope'] ?? '')
        const taskMode = req.headers['x-qqbot-task'] === '1'
        const mcp = this.buildServer(scope, taskMode)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void mcp.close()
        })
        await mcp.connect(transport)
        await transport.handleRequest(req, res)
      } catch (e) {
        log('MCP 请求处理失败:', e)
        if (!res.headersSent) res.writeHead(500).end()
      }
    })
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(config.mcpPort, config.mcpHost, () => {
        log(`MCP server 监听 ${config.mcpHost}:${config.mcpPort}`)
        resolve()
      })
    })
  }

  stop() {
    this.server?.close()
    this.server = null
  }
}
