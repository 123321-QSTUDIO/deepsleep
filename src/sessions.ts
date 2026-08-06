import fs from 'node:fs'
import path from 'node:path'
import { PluginConfig } from './config'
import { MsgDB, dayKey } from './msgdb'
import { OpencodeClient } from './opencode'
import { buildGroupAgentsMd, buildPrivateAgentsMd } from './agentsmd'
import { extractAtTargets, extractReplyTo, MsgSegment } from './format'
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
  private ctx!: PluginContext

  constructor(
    private config: PluginConfig,
    private db: MsgDB,
    private oc: OpencodeClient,
    dataPath: string,
    private log: (msg: string, ...args: unknown[]) => void
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

  private async ensureSession(scope: string, event: OB11MessageEvent): Promise<SessionEntry | null> {
    const existing = this.map.get(scope)
    if (existing) return existing
    const directory = this.workspaceFor(scope)
    fs.mkdirSync(directory, { recursive: true })
    const agentsMd =
      event.message_type === 'group'
        ? buildGroupAgentsMd(this.config, String(event.group_id), event.group_name ?? '')
        : buildPrivateAgentsMd(this.config, String(event.user_id), event.sender?.nickname ?? '')
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), agentsMd)
    fs.writeFileSync(
      path.join(directory, 'opencode.json'),
      JSON.stringify(
        {
          model: this.config.hostModel,
          mcp: {
            qqbot: {
              type: 'remote',
              url: this.config.mcpUrl,
              enabled: true,
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
    )
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
    if (selfId && extractAtTargets(segments).includes(selfId)) return true
    const replyTo = extractReplyTo(segments)
    if (replyTo !== null && selfId) {
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

  private buildPrompt(event: OB11MessageEvent): string {
    const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
    const now = Math.floor(Date.now() / 1000)
    const lines: string[] = []
    const seen = new Set<number>()
    for (const day of [dayKey(now - 86400), dayKey(now)]) {
      try {
        const rows = this.db.query(
          scope,
          day,
          'SELECT msg_pk, time, nickname, user_id, text FROM message ORDER BY msg_pk DESC LIMIT ?',
          [this.config.contextMessageCount]
        )
        for (const r of rows.reverse()) {
          const pk = Number(r.msg_pk)
          if (seen.has(pk)) continue
          seen.add(pk)
          const nick = String(r.nickname || r.user_id)
          lines.push(`[${hhmm(Number(r.time))}] ${nick}(${r.user_id}): ${String(r.text ?? '')}`)
        }
      } catch {
        // no db for that day
      }
    }
    const context = lines.slice(-this.config.contextMessageCount)
    const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
    const replyTo = extractReplyTo(segments)
    if (replyTo !== null) {
      for (const day of [dayKey(now), dayKey(now - 86400)]) {
        try {
          const rows = this.db.query(scope, day, 'SELECT nickname, user_id, text FROM message WHERE message_id = ? LIMIT 1', [replyTo])
          if (rows.length > 0) {
            context.push(`> 引用 ${rows[0].nickname || rows[0].user_id}(${rows[0].user_id}): ${String(rows[0].text ?? '').slice(0, 200)}`)
            break
          }
        } catch {
          // ignore
        }
      }
    }
    return context.join('\n')
  }

  async handleMessage(event: OB11MessageEvent): Promise<void> {
    const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
    const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
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
    await this.oc.promptAsync(entry.sessionId, prompt)
  }

  private async reset(scope: string) {
    const entry = this.map.get(scope)
    if (!entry) return
    await this.oc.deleteSession(entry.sessionId).catch(() => undefined)
    this.map.delete(scope)
    this.reverse.delete(entry.sessionId)
    this.save()
  }

  onAssistantText(sessionId: string, text: string) {
    if (this.reverse.has(sessionId)) this.lastText.set(sessionId, text)
  }

  async onSessionIdle(sessionId: string): Promise<void> {
    const scope = this.reverse.get(sessionId)
    if (!scope) return
    const usedTool = this.sentViaTool.get(sessionId) ?? 0
    this.sentViaTool.delete(sessionId)
    const text = this.lastText.get(sessionId) ?? ''
    this.lastText.delete(sessionId)
    if (usedTool > 0 || !text.trim()) return
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    for (const line of lines) {
      await this.sendTextToScope(scope, line)
      await this.delay()
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
  }

  async sendTextToScope(scope: string, text: string, opts?: { replyTo?: number | string; atQq?: number | string }): Promise<void> {
    let message: unknown = text
    if (opts?.replyTo || opts?.atQq) {
      const segments: Record<string, unknown>[] = []
      if (opts.replyTo) segments.push({ type: 'reply', data: { id: String(opts.replyTo) } })
      if (opts.atQq) segments.push({ type: 'at', data: { qq: String(opts.atQq) } })
      segments.push({ type: 'text', data: { text: opts.atQq ? ` ${text}` : text } })
      message = segments
    }
    const params: Record<string, unknown> = { message }
    if (scope.startsWith('group-')) {
      params.message_type = 'group'
      params.group_id = scope.slice(6)
    } else {
      params.message_type = 'private'
      params.user_id = scope.slice(8)
    }
    await this.ctx.actions.call('send_msg', params, this.ctx.adapterName, this.ctx.pluginManager.config)
  }
}
