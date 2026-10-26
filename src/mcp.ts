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
import { StickerStore } from './stickers'
import { ReminderStore } from './reminders'

interface McpDeps {
  config: PluginConfig
  db: MsgDB
  sessions: SessionController
  tasks: TaskRegistry
  mutes: MuteStore
  stickers: StickerStore
  reminders: ReminderStore
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
        description: '发送一条消息到当前QQ对话（群或私聊）。想发几条就调几次；普通聊天尽量短，解释类可适当加长。可以用[CQ:at,qq=QQ号]@人；内置小黄脸用[CQ:face,id=数字]写在文本里（收藏表情包不能用文本/CQ码，必须用 qqbot_send_sticker）。',
        inputSchema: {
          text: z.string().describe('消息内容；普通闲聊尽量简短，解释类可适当加长，超长会收到警告'),
          reply_to: z.string().optional().describe('要引用的消息ID（回复某条消息时用）'),
          at_qq: z.string().optional().describe('要@的人的QQ号'),
        },
      },
      async ({ text: t, reply_to, at_qq }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能发消息')
        const cfg = this.deps.config
        const maxChars = Math.max(20, cfg.maxCharsPerMessage || 200)
        const maxLines = Math.max(1, cfg.maxLinesPerReply || 4)
        const countBefore = sessions.toolSendCountOfScope(scope)
        await sessions.sendTextToScope(scope, t, { replyTo: reply_to, atQq: at_qq })
        sessions.markSentByScope(scope)
        // 不拦截发送，只在工具结果里提醒模型自己收敛，避免回复戛然而止
        const notes: string[] = []
        if (t.length > maxChars) {
          notes.push('这条消息偏长（' + t.length + ' 字，建议单条不超过 ' + maxChars + ' 字），之后请精简或拆成几条')
        }
        const countAfter = countBefore + 1
        const pendingPeople = sessions.pendingCountOfScope(scope)
        if (countAfter > maxLines && pendingPeople < 2) {
          notes.push('本轮已经发了 ' + countAfter + ' 条，超过建议的 ' + maxLines + ' 条，接下来请收尾，不要再刷屏')
        }
        return text('已发送' + (notes.length > 0 ? '。警告：' + notes.join('；') : ''))
      }
    )
    mcp.registerTool(
      'list_stickers',
      {
        description: '列出当前 QQ 账号可用的收藏表情（已打标+启用）。返回 {id, collection, label, display}；display 是「合集:描述」，同名表情靠合集区分；发送时用 id。',
        inputSchema: {
          query: z.string().optional().describe('按描述关键词筛选，可不传'),
          limit: z.number().optional().describe('最多返回多少个，默认 30，最多 100'),
        },
      },
      async ({ query, limit }) => {
        if (!scope) return text('错误: 未知对话上下文')
        const list = this.deps.stickers.listForAgent(query)
        if (list.length === 0) {
          return text(
            '当前没有可用的收藏表情（需要先在控制面板「表情」页同步并打标签/启用）。' +
              (query ? '换个关键词试试。' : '')
          )
        }
        return text(JSON.stringify(list.slice(0, Math.min(Math.max(limit ?? 30, 1), 50))))
      }
    )

    mcp.registerTool(
      'send_sticker',
      {
        description: '发送一个**收藏表情包**（不是内置小黄脸；内置小黄脸用 [CQ:face,id=] 写在 send_message 文本里）。id 见系统提示的收藏表情列表或 qqbot_list_stickers；一次回复最多 1-2 个，别刷屏。',
        inputSchema: {
          sticker: z.string().describe('收藏表情的 emoji_id（来自 qqbot_list_stickers）或 32 位 MD5'),
          reply_to: z.string().optional().describe('要引用的消息ID，可选'),
        },
      },
      async ({ sticker, reply_to }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能发消息')
        const record = this.deps.stickers.findEnabled(sticker)
        if (!record) {
          return text('这个表情不在可用列表里：请先 qqbot_list_stickers 挑一个已打标/启用的表情（id 或 MD5）')
        }
        try {
          await sessions.sendStickerToScope(scope, record.id, { replyTo: reply_to })
          sessions.markSentByScope(scope)
          return text('已发送收藏表情: ' + record.label)
        } catch (e) {
          return text('发送收藏表情失败: ' + String((e as Error)?.message ?? e))
        }
      }
    )

    mcp.registerTool(
      'send_voice',
      {
        description: '把一段话用 TTS 合成语音发到当前对话（群里就是语音消息）。适合想用声音表达时；文本尽量短（默认最多 200 字）。音色由本群/本会话设定的声音决定。',
        inputSchema: { text: z.string().describe('要念出来的文本，尽量口语化、简短') },
      },
      async ({ text: t }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能发消息')
        const content = String(t ?? '').trim()
        if (!content) return text('错误: 语音文本为空')
        try {
          await sessions.sendVoiceToScope(scope, content)
          return text('已发送语音')
        } catch (e) {
          return text('发送语音失败: ' + String((e as Error)?.message ?? e))
        }
      }
    )

    mcp.registerTool(
      'set_voice',
      {
        description: '设置当前群/私聊里机器人说话的声音（用一段音色描述）。传空字符串恢复默认声音。设置后之后发的语音都用这个声音；建议结合群氛围/角色来写。',
        inputSchema: { description: z.string().describe('音色描述（年龄/性别/音色质感/语速/情绪底色），空字符串=恢复默认') },
      },
      async ({ description }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能改声音')
        try {
          const saved = sessions.setVoiceForScope(scope, String(description ?? ''))
          return text(saved ? '已设置这个会话的声音：' + saved : '已恢复默认声音')
        } catch (e) {
          return text('设置声音失败: ' + String((e as Error)?.message ?? e))
        }
      }
    )

    mcp.registerTool(
      'send_poke',
      {
        description: '戳一戳某个群友（或私聊里的对方）。被戳的人会收到 QQ 的戳一戳提示；适合回应别人戳你或开玩笑。',
        inputSchema: { qq: z.string().optional().describe('要戳的 QQ 号；私聊里可省略（默认戳对方）') },
      },
      async ({ qq }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能发消息')
        const target = qq ? String(qq) : scope.startsWith('private-') ? scope.slice(8) : ''
        if (!target) return text('错误: 群聊里需要指定要戳的 QQ 号')
        try {
          await sessions.sendPokeToScope(scope, target)
          return text('已戳一戳 ' + target)
        } catch (e) {
          return text('戳一戳失败: ' + String((e as Error)?.message ?? e))
        }
      }
    )

    mcp.registerTool(
      'set_reminder',
      {
        description: '设置一个倒计时提醒，到时间系统会自动在群里/私聊发出提醒。适合“X 分钟后提醒我/大家”的请求；也可以用来自我提醒过多久再跟进某件事。',
        inputSchema: {
          minutes: z.number().describe('多少分钟后提醒，大于 0，最多 reminderMaxDays 天'),
          text: z.string().describe('提醒内容'),
          at_qq: z.string().optional().describe('要@的 QQ 号；群聊里建议填发起人，到点会 @ta'),
        },
      },
      async ({ minutes, text: reminderText, at_qq }) => {
        if (!scope) return text('错误: 未知对话上下文')
        if (taskMode) return text('错误: 沙箱任务中不能设置提醒')
        const cfg = this.deps.config
        if (!cfg.remindersEnabled) return text('错误: 定时提醒未启用')
        const mins = Number(minutes)
        if (!Number.isFinite(mins) || mins <= 0) return text('错误: minutes 必须大于 0')
        const maxMinutes = Math.max(1, cfg.reminderMaxDays) * 1440
        if (mins > maxMinutes) return text('错误: 提醒最多 ' + maxMinutes + ' 分钟（' + cfg.reminderMaxDays + ' 天）')
        const content = String(reminderText ?? '').trim()
        if (!content) return text('错误: 提醒内容不能为空')
        if (this.deps.reminders.pendingCount(scope) >= Math.max(1, cfg.reminderMaxPerScope)) {
          return text('错误: 这个会话待触发的提醒太多（上限 ' + cfg.reminderMaxPerScope + ' 条），先取消一些')
        }
        const rem = this.deps.reminders.add({
          scope,
          text: content,
          dueAt: Date.now() / 1000 + mins * 60,
          atUserId: at_qq ? Number(at_qq) : undefined,
        })
        return text('已设置提醒 ' + rem.id + '：约 ' + mins + ' 分钟后' + (rem.atUserId ? '（会 @' + rem.atUserId + '）' : ''))
      }
    )

    mcp.registerTool(
      'list_reminders',
      {
        description: '查看当前会话还没触发的定时提醒。',
        inputSchema: {},
      },
      async () => {
        if (!scope) return text('错误: 未知对话上下文')
        const list = this.deps.reminders.pendingOfScope(scope)
        if (list.length === 0) return text('当前没有待触发的提醒')
        return text(JSON.stringify(list.map((r) => ({ id: r.id, inMinutes: Math.max(0, Math.round((r.dueAt - Date.now() / 1000) / 60)), text: r.text, atUserId: r.atUserId }))))
      }
    )

    mcp.registerTool(
      'cancel_reminder',
      {
        description: '取消一个还没触发的定时提醒（用 list_reminders 拿到的 id）。',
        inputSchema: { id: z.string().describe('提醒 id') },
      },
      async ({ id }) => {
        if (!scope) return text('错误: 未知对话上下文')
        const rem = this.deps.reminders.cancel(String(id), scope)
        if (!rem) return text('没有找到这个待触发的提醒（可能已触发或已取消）')
        return text('已取消提醒 ' + rem.id)
      }
    )

    mcp.registerTool(
      'wait_for_messages',
      {
        description: '等群友把话说完或等后续消息：purpose=reply 等到最后一条新消息安静下来（判断对方说完了没）；purpose=messages 等到有新消息就返回。等待期间新消息不会再单独触发一轮模型，返回值里的 newMessages 直接决定要不要接话。',
        inputSchema: {
          purpose: z.enum(['reply', 'messages']).optional().describe('reply=等安静（默认）；messages=等新消息'),
          timeout_sec: z.number().optional().describe('最长等待秒数，默认 30，最大 60'),
          quiet_sec: z.number().optional().describe('purpose=reply 时，最后一条消息后安静多少秒算说完，默认 10，最大 30'),
        },
      },
      async ({ purpose, timeout_sec, quiet_sec }) => {
        if (!scope) return text('错误: 未知对话上下文')
        const mode = purpose === 'messages' ? 'messages' : 'reply'
        const result = await sessions.waitForMessages(scope, {
          purpose: mode,
          timeoutSec: timeout_sec ?? (mode === 'reply' ? 30 : 20),
          quietSec: quiet_sec ?? (mode === 'reply' ? 10 : 0),
        })
        return text(JSON.stringify(result))
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
        description: '临时屏蔽某个群友：在指定时间内他的消息不会触发你回复。谨慎使用（见 AGENTS.md 的使用原则）。屏蔽时建议你用 qqbot_send_message 告知对方原因和时长。',
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
