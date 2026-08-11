import fs from 'node:fs'
import path from 'node:path'
import { PluginConfig } from './config'
import { MsgDB, dayKey } from './msgdb'
import { OpencodeClient } from './opencode'
import { buildGroupAgentsMd, buildPrivateAgentsMd, ALLOWED_FACE_IDS } from './agentsmd'
import { cleanCqForDisplay, dedupeImages, extractAtTargets, extractImages, extractImagesFromRaw, extractReplyTo, extractText, MsgSegment, textToSegments } from './format'
import { MuteStore } from './mutes'
import { OB11MessageEvent, PluginContext } from './types'

interface SessionEntry {
  sessionId: string
  directory: string
}

function hhmm(timeSec: number): string {
  const d = new Date(timeSec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export class SessionController {
  private map = new Map<string, SessionEntry>()
  private reverse = new Map<string, string>()
  private mapFile: string
  private workspacesDir: string
  private sentViaTool = new Map<string, number>()
  private lastText = new Map<string, string>()
  private lastTrigger = new Map<string, { userId: number; messageId: number; groupId: number | null }>()
  private selfId = 0
  private sendQueues = new Map<string, Promise<void>>()
  private ctx!: PluginContext

  constructor(
    private config: PluginConfig,
    private db: MsgDB,
    private oc: OpencodeClient,
    dataPath: string,
    private log: (msg: string, ...args: unknown[]) => void,
    public mutes: MuteStore = new MuteStore(dataPath)
  ) {
    this.mapFile = path.join(dataPath, 'sessions.json')
    this.workspacesDir = path.join(dataPath, 'workspaces')
    this.load()
  }

  attach(ctx: PluginContext) {
    this.ctx = ctx
  }

  private load() {
    try {
      if (fs.existsSync(this.mapFile)) {
        const raw = JSON.parse(fs.readFileSync(this.mapFile, 'utf-8')) as Record<string, SessionEntry>
        for (const [scope, entry] of Object.entries(raw)) {
          this.map.set(scope, entry)
          this.reverse.set(entry.sessionId, scope)
        }
      }
    } catch (e) {
      this.log('sessions.json 读取失败, 从零开始:', e)
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.mapFile), { recursive: true })
    fs.writeFileSync(this.mapFile, JSON.stringify(Object.fromEntries(this.map), null, 2))
  }

  markSentViaTool(sessionId: string) {
    this.sentViaTool.set(sessionId, (this.sentViaTool.get(sessionId) ?? 0) + 1)
  }

  markAnsweredByAt(scope: string, qqs: string[]) {
    if (qqs.length === 0) return
    const pend = this.pendingRequests.get(scope)
    if (!pend || pend.length === 0) return
    const left = pend.filter((p) => !p.userId || !qqs.includes(String(p.userId)))
    if (left.length !== pend.length) {
      this.markSent(scope, pend.filter((p) => !left.includes(p)).map((p) => p.id))
      if (left.length === 0) this.pendingRequests.delete(scope)
      else this.pendingRequests.set(scope, left)
    }
  }

  markSentByScope(scope: string) {
    const entry = this.map.get(scope)
    if (entry) this.markSentViaTool(entry.sessionId)
  }

  triggerOf(scope: string) {
    return this.lastTrigger.get(scope) ?? null
  }

  scopeOfSession(sessionId: string): string | undefined {
    return this.reverse.get(sessionId)
  }

  sessionIdOf(scope: string): string | undefined {
    return this.map.get(scope)?.sessionId
  }

  private workspaceFor(scope: string): string {
    return path.join(this.workspacesDir, scope)
  }

  private ensureWorkspaceFiles(scope: string, event: OB11MessageEvent) {
    const directory = this.workspaceFor(scope)
    fs.mkdirSync(directory, { recursive: true })
    const agentsMd =
      event.message_type === 'group'
        ? buildGroupAgentsMd(this.config, String(event.group_id), event.group_name ?? '')
        : buildPrivateAgentsMd(this.config, String(event.user_id), event.sender?.nickname ?? '')
    const ocJson = JSON.stringify(
      {
        model: this.config.hostModel,
        agent: {
          'vision-bridge': {
            description: '视觉跳板：读取图片/视频文件并输出详细文字描述，供纯文本模型调用',
            model: this.config.visionModel,
            mode: 'subagent',
            prompt:
              '你是视觉跳板。用户会给你一个图片或视频的文件路径（在工作目录下，如 inbox/xxx.jpg）。用 read 工具读取该文件，然后用中文输出详细、客观的内容描述（画面主体、文字、细节、氛围）。只输出描述本身，不要评价、不要回答用户其他问题。',
          },
        },
        mcp: {
          qqbot: {
            type: 'remote',
            url: this.config.mcpUrl,
            enabled: true,
            timeout: 8000,
            headers: {
              authorization: `Bearer ${this.config.mcpToken}`,
              'x-qqbot-scope': scope,
            },
          },
        },
      },
      null,
      2
    )
    for (const [name, content] of [
      ['AGENTS.md', agentsMd],
      ['opencode.json', ocJson],
    ] as const) {
      const file = path.join(directory, name)
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) continue
        fs.writeFileSync(file, content)
        this.log(`工作区文件已更新: ${scope}/${name}`)
      } catch (e) {
        this.log(`写 ${name} 失败:`, e)
      }
    }
  }

  private async ensureSession(scope: string, event: OB11MessageEvent): Promise<SessionEntry | null> {
    this.ensureWorkspaceFiles(scope, event)
    const existing = this.map.get(scope)
    if (existing) return existing
    const directory = this.workspaceFor(scope)
    const title = event.message_type === 'group' ? `QQ群 ${event.group_name || event.group_id}` : `私聊 ${event.user_id}`
    try {
      const found = await this.oc.findSessionByDirectory(directory)
      const reusable = Array.isArray(found) ? found[0] : undefined
      const session = reusable ?? (await this.oc.createSession(directory, title))
      const entry: SessionEntry = { sessionId: session.id, directory }
      this.map.set(scope, entry)
      this.reverse.set(session.id, scope)
      this.save()
      this.log(`会话建立 ${scope} -> ${session.id}${reusable ? ' (复用)' : ''}`)
      return entry
    } catch (e) {
      this.log('创建会话失败:', e)
      return null
    }
  }

  private isTriggered(event: OB11MessageEvent, segments: MsgSegment[]): boolean {
    if (event.message_type === 'private') return true
    const selfId = String(event.self_id ?? '')
    const atTargets = extractAtTargets(segments)
    if (selfId && atTargets.includes(selfId)) return true
    const replyTo = extractReplyTo(segments)
    if (replyTo !== null && selfId) {
      // 回复了机器人、但同时在跟其他人说话（@了别人而没@机器人）→ 不触发
      if (atTargets.length > 0) return false
      const scope = `group-${event.group_id}`
      const now = Math.floor(Date.now() / 1000)
      for (const day of [dayKey(now), dayKey(now - 86400)]) {
        try {
          const rows = this.db.query(scope, day, 'SELECT user_id FROM message WHERE message_id = ? LIMIT 1', [replyTo])
          if (rows.length > 0 && String(rows[0].user_id) === selfId) return true
        } catch {
          // db file for that day may not exist
        }
      }
    }
    return false
  }

  private pendingRequests = new Map<string, { id: number | null; userId: number; line: string }[]>()
  private sentMsgIds = new Map<string, Set<number>>()

  private markSent(scope: string, ids: (number | null)[]) {
    const set = this.sentMsgIds.get(scope) ?? new Set<number>()
    for (const id of ids) if (id !== null) set.add(id)
    if (set.size > 300) {
      this.sentMsgIds.set(scope, new Set([...set].slice(-200)))
      return
    }
    this.sentMsgIds.set(scope, set)
  }

  private buildPrompt(event: OB11MessageEvent): string {
    const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
    const now = Math.floor(Date.now() / 1000)
    const currentId = typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || null
    const sent = this.sentMsgIds.get(scope) ?? new Set<number>()
    const pending = this.pendingRequests.get(scope) ?? []

    const candidates: { mid: number; line: string }[] = []
    const seen = new Set<number>()
    for (const day of [dayKey(now - 86400), dayKey(now)]) {
      try {
        const rows = this.db.query(
          scope,
          day,
          'SELECT msg_pk, message_id, time, nickname, user_id, text FROM message ORDER BY msg_pk DESC LIMIT ?',
          [this.config.contextMessageCount * 3]
        )
        for (const r of rows.reverse()) {
          const pk = Number(r.msg_pk)
          if (seen.has(pk)) continue
          seen.add(pk)
          const mid = Number(r.message_id)
          if (currentId !== null && mid === currentId) continue
          if (sent.has(mid)) continue
          if (pending.some((p) => p.id === mid)) continue
          const nick = String(r.nickname || r.user_id)
          candidates.push({ mid, line: `[${hhmm(Number(r.time))}] ${nick}(${r.user_id}): ${cleanCqForDisplay(String(r.text ?? ''))}` })
        }
      } catch {
        // no db for that day
      }
    }
    const context = candidates.slice(-this.config.contextMessageCount)
    this.markSent(scope, context.map((c) => c.mid))

    const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
    const nick = event.sender?.card || event.sender?.nickname || String(event.user_id ?? '')
    const currentText = cleanCqForDisplay(
      typeof event.raw_message === 'string' && event.raw_message ? event.raw_message : extractText(segments)
    )
    let currentLine = `[${hhmm(event.time ?? now)}] ${nick}(${event.user_id}): ${currentText}`
    const replyTo = extractReplyTo(segments)
    if (replyTo !== null) {
      for (const day of [dayKey(now), dayKey(now - 86400)]) {
        try {
          const rows = this.db.query(scope, day, 'SELECT nickname, user_id, text FROM message WHERE message_id = ? LIMIT 1', [replyTo])
          if (rows.length > 0) {
            currentLine += `\n  > 引用 ${rows[0].nickname || rows[0].user_id}(${rows[0].user_id}): ${cleanCqForDisplay(String(rows[0].text ?? '')).slice(0, 200)}`
            break
          }
        } catch {
          // ignore
        }
      }
    }
    pending.push({ id: currentId, userId: event.user_id ?? 0, line: currentLine })
    this.pendingRequests.set(scope, pending)

    const parts: string[] = []
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const week = '日一二三四五六'[d.getDay()]
    parts.push(`[当前时间] ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} 星期${week}（以此为准，下面消息前面的方括号是它们的发送时间）`)
    if (context.length > 0) parts.push('[新的聊天记录]\n' + context.map((c) => c.line).join('\n'))
    parts.push(
      `[待回应的请求，共 ${pending.length} 条，请逐条回应]\n` + pending.map((p, i) => `${i + 1}. ${p.line}`).join('\n')
    )
    return parts.join('\n')
  }

  async handleMessage(event: OB11MessageEvent): Promise<void> {
    if (event.self_id) this.selfId = event.self_id
    if (event.user_id && event.self_id && event.user_id === event.self_id) return
    const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
    const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
    if (event.user_id && this.mutes.isMuted(scope, String(event.user_id))) return
    const raw = (event.raw_message ?? '').trim().replace(/\[CQ:[^\]]+\]/g, '').trim()

    if (raw === '/reset') {
      await this.reset(scope)
      await this.sendText(event, '记忆已清空，我们重新认识一下吧')
      return
    }
    if (raw === '/abort') {
      const entry = this.map.get(scope)
      if (entry) await this.oc.abort(entry.sessionId).catch(() => undefined)
      await this.sendText(event, '停了停了')
      return
    }

    if (!this.isTriggered(event, segments)) return

    const mid = typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || null
    const pendingNow = this.pendingRequests.get(scope) ?? []
    if (mid !== null && pendingNow.some((p) => p.id === mid)) return

    this.log(`触发 scope=${scope} msg_id=${event.message_id} user=${event.user_id}`)

    this.lastTrigger.set(scope, {
      userId: event.user_id ?? 0,
      messageId: typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || 0,
      groupId: event.message_type === 'group' ? event.group_id ?? null : null,
    })

    const entry = await this.ensureSession(scope, event)
    if (!entry) {
      await this.sendText(event, '我现在脑子有点转不动，稍后再找我吧')
      return
    }
    const prompt = this.buildPrompt(event)
    if (!prompt) return
    const replyTo = extractReplyTo(segments)
    const images = dedupeImages([
      ...extractImages(segments),
      ...extractImagesFromRaw(event.raw_message ?? ''),
      ...(replyTo !== null ? this.quotedImages(scope, replyTo) : []),
    ])
    const imageNote = await this.downloadImages(entry.directory, images)
    await this.prompt(entry.sessionId, imageNote ? prompt + imageNote : prompt)
  }

  private quotedImages(scope: string, replyTo: number): { url: string; mime: string }[] {
    const now = Math.floor(Date.now() / 1000)
    for (const day of [dayKey(now), dayKey(now - 86400)]) {
      try {
        const rows = this.db.query(scope, day, 'SELECT segments, text FROM message WHERE message_id = ? LIMIT 1', [replyTo])
        if (rows.length === 0) continue
        const imgs: { url: string; mime: string }[] = []
        try {
          imgs.push(...extractImages(JSON.parse(String(rows[0].segments ?? '[]')) as MsgSegment[]))
        } catch {
          // segments not parseable
        }
        imgs.push(...extractImagesFromRaw(String(rows[0].text ?? '')))
        return imgs
      } catch {
        // no db for that day
      }
    }
    return []
  }

  private async downloadImages(directory: string, images: { url: string; mime: string }[]): Promise<string> {
    if (images.length === 0) return ''
    const inbox = path.join(directory, 'inbox')
    fs.mkdirSync(inbox, { recursive: true })
    const notes: string[] = []
    for (const [i, img] of images.entries()) {
      const name = `${Date.now()}-${i}.jpg`
      try {
        const res = await fetch(img.url, { headers: { 'user-agent': 'Mozilla/5.0' } })
        if (!res.ok) throw new Error(`http ${res.status}`)
        fs.writeFileSync(path.join(inbox, name), Buffer.from(await res.arrayBuffer()))
        notes.push(`inbox/${name}`)
      } catch (e) {
        this.log('图片下载失败:', e)
        notes.push('(图片下载失败)')
      }
    }
    return `\n[系统] 这条消息带了图片，已存到工作目录：${notes.join('、')}。用 Task 工具调 vision-bridge 子代理读取图片内容后再回答。`
  }

  private async reset(scope: string) {
    const entry = this.map.get(scope)
    if (!entry) return
    await this.oc.deleteSession(entry.sessionId).catch(() => undefined)
    this.map.delete(scope)
    this.reverse.delete(entry.sessionId)
    this.save()
  }

  private watch(sessionId: string) {
    void (async () => {
      const deadline = Date.now() + 10 * 60 * 1000
      let sawBusy = false
      let busySince = 0
      const busyDeadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        let present = false
        let type = ''
        try {
          const map = await this.oc.getStatus()
          const st = map[sessionId]
          present = st !== undefined
          type = typeof st === 'string' ? st : ((st as { type?: string })?.type ?? '')
        } catch {
          continue
        }
        if (type === 'busy' || type === 'retry') {
          sawBusy = true
          if (busySince === 0) busySince = Date.now()
          if (Date.now() - busySince > this.config.turnTimeoutSec * 1000) {
            this.log(`轮次超时(${this.config.turnTimeoutSec}s)，中断 session=${sessionId}`)
            await this.oc.abort(sessionId).catch(() => undefined)
            const scope = this.reverse.get(sessionId)
            if (scope) {
              const stuck = this.pendingRequests.get(scope) ?? []
              if (stuck.length > 0) {
                this.markSent(scope, stuck.map((p) => p.id))
                this.pendingRequests.delete(scope)
              }
              await this.sendTextToScope(scope, '我这边卡住了，刚才那条没接上，再说一次呗')
            }
            return
          }
          continue
        }
        busySince = 0
        const idle = !present || type === 'idle'
        if (idle) {
          if (!sawBusy && Date.now() < busyDeadline) continue
          await this.onSessionIdle(sessionId)
          return
        }
      }
      this.log(`watchdog 超时 session=${sessionId}`)
      const scope = this.reverse.get(sessionId)
      if (scope) {
        const stuck = this.pendingRequests.get(scope) ?? []
        if (stuck.length > 0) {
          this.markSent(scope, stuck.map((p) => p.id))
          this.pendingRequests.delete(scope)
        }
      }
    })()
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.oc.promptAsync(sessionId, text)
    this.watch(sessionId)
  }

  onAssistantText(sessionId: string, text: string) {
    if (this.reverse.has(sessionId)) this.lastText.set(sessionId, text)
  }

  async onSessionIdle(sessionId: string): Promise<void> {
    const scope = this.reverse.get(sessionId)
    if (!scope) return
    const answered = this.pendingRequests.get(scope) ?? []
    if (answered.length > 0) {
      this.markSent(scope, answered.map((p) => p.id))
      this.pendingRequests.delete(scope)
    }
    const usedTool = this.sentViaTool.get(sessionId) ?? 0
    this.sentViaTool.delete(sessionId)
    let text = this.lastText.get(sessionId) ?? ''
    this.lastText.delete(sessionId)
    if (usedTool > 0) return
    if (!text.trim()) {
      text = await this.oc.getLastAssistantText(sessionId)
    }
    const trimmed = text.trim()
    if (!trimmed || trimmed === '[SILENT]') return
    let lines = trimmed
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== '[SILENT]')
    if (lines.length > this.config.maxLinesPerReply) {
      lines = [...lines.slice(0, this.config.maxLinesPerReply - 1), lines.slice(this.config.maxLinesPerReply - 1).join('\n')]
    }
    for (const line of lines) {
      await this.sendTextToScope(scope, line)
    }
  }

  private delay(): Promise<void> {
    const { replyDelayMinMs, replyDelayMaxMs } = this.config
    const ms = replyDelayMinMs + Math.random() * Math.max(0, replyDelayMaxMs - replyDelayMinMs)
    return new Promise((r) => setTimeout(r, ms))
  }

  async sendText(event: OB11MessageEvent, text: string): Promise<void> {
    const params: Record<string, unknown> = { message_type: event.message_type, message: text }
    if (event.message_type === 'group' && event.group_id) params.group_id = String(event.group_id)
    if (event.message_type === 'private' && event.user_id) params.user_id = String(event.user_id)
    await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config)
    this.recordSent(
      event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`,
      text
    )
  }

  private recordSent(scope: string, text: string) {
    try {
      this.db.insert(scope, {
        message_id: null,
        user_id: this.selfId || 0,
        nickname: this.config.botName,
        card: '',
        time: Math.floor(Date.now() / 1000),
        reply_to: null,
        text,
        segments: JSON.stringify([{ type: 'text', data: { text } }]),
      })
    } catch (e) {
      this.log('出站消息入库失败:', e)
    }
  }

  async sendTextToScope(scope: string, text: string, opts?: { replyTo?: number | string; atQq?: number | string }): Promise<void> {
    // Agent 一轮可能并发调多次 send_message；按 scope 串行化 + 小间隔，保证 QQ 端显示顺序与调用顺序一致
    const prev = this.sendQueues.get(scope) ?? Promise.resolve()
    const next = prev.then(() => this.doSendToScope(scope, text, opts)).catch((e) => {
      this.log('发送失败:', e)
    })
    this.sendQueues.set(scope, next)
    return next
  }

  private async doSendToScope(scope: string, text: string, opts?: { replyTo?: number | string; atQq?: number | string }): Promise<void> {
    const segments: Record<string, unknown>[] = []
    if (opts?.replyTo) segments.push({ type: 'reply', data: { id: String(opts.replyTo) } })
    let body = text
    if (opts?.atQq && !text.includes(`[CQ:at,qq=${opts.atQq}]`)) {
      segments.push({ type: 'at', data: { qq: String(opts.atQq) } })
      body = ' ' + body
    }
    segments.push(...textToSegments(body))
    const filtered = segments.filter(
      (s) => s.type !== 'face' || ALLOWED_FACE_IDS.has(String((s.data as Record<string, unknown>)?.id ?? ''))
    )
    if (filtered.length < segments.length) this.log('过滤了不支持的表情段')
    const params: Record<string, unknown> = { message: filtered.length > 0 ? filtered : [{ type: 'text', data: { text: ' ' } }] }
    if (scope.startsWith('group-')) {
      params.message_type = 'group'
      params.group_id = scope.slice(6)
    } else {
      params.message_type = 'private'
      params.user_id = scope.slice(8)
    }
    await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config)
    this.recordSent(scope, text)
    await this.delay()
  }
}
