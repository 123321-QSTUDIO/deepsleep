import fs from 'node:fs'
import path from 'node:path'
import { PluginConfig } from './config'
import { MsgDB, dayKey } from './msgdb'
import { OpencodeClient, OpencodeEvent } from './opencode'
import { buildGroupAgentsMd, buildPrivateAgentsMd, ALLOWED_FACE_IDS, VisionStrategy } from './agentsmd'
import { cleanCqForDisplay, dedupeImages, extractAtTargets, extractImages, extractImagesFromRaw, extractReplyTo, extractText, MsgSegment, textToSegments } from './format'
import { MuteStore } from './mutes'
import { OB11MessageEvent, SessionRuntime } from './types'
import { TtsClient } from './tts'
import { ProactiveJudge } from './proactive'
import { VoiceStore } from './voices'

function extractPttText(result: unknown): string {
  if (!result) return ''
  if (typeof result === 'string') return result.trim()
  const obj = result as Record<string, unknown>
  if (typeof obj.text === 'string') return obj.text.trim()
  const data = obj.data as Record<string, unknown> | undefined
  if (data && typeof data.text === 'string') return data.text.trim()
  return ''
}

interface SessionEntry {
  sessionId: string
  directory: string
}

// 梦境记忆维护的结构化记忆文件：instructions 注入，夜间由 dream.ts 更新
export const MEMORY_FILE = 'MEMORY.md'
export const MEMORY_TEMPLATE = `# 记忆 · MEMORY.md

> 这个文件是机器人的长期记忆，由每日"梦境整理"自动维护，也可以手工编辑。
> 原则：只记长期有用的事实/关系/偏好/未完成事项，不记流水账，不记隐私敏感信息。
> OpenCode 通过 workspace opencode.json 的 instructions 注入本文件。

## 群聊概况
- 待补充

## 长期事实
- 待补充

## 群成员
- 待补充

## 话题与偏好
- 待补充

## 未完成的事
- 待补充

## 更新时间
- 尚未整理
`

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
  private hostVisionCache: { model: string; vision: boolean; at: number } | null = null
  private sendQueues = new Map<string, Promise<void>>()
  // 同一 scope 短时间内的重复发送（模型重复调工具/工具重试）直接忽略
  private lastSent = new Map<string, { text: string; at: number }>()
  private static readonly DUPLICATE_SEND_WINDOW_MS = 8000
  private runtime!: SessionRuntime
  private tts: TtsClient | null = null
  private voices: VoiceStore | null = null
  private judge: ProactiveJudge | null = null
  // 主动参与：新消息计数 / 上次尝试 / 近一小时尝试时间戳
  private proactiveNewCount = new Map<string, number>()
  private proactiveLastAt = new Map<string, number>()
  private proactiveAttempts = new Map<string, number[]>()

  constructor(
    private config: PluginConfig,
    private db: MsgDB,
    private oc: OpencodeClient,
    private dataPath: string,
    private log: (msg: string, ...args: unknown[]) => void,
    public mutes: MuteStore = new MuteStore(dataPath)
  ) {
    this.mapFile = path.join(dataPath, 'sessions.json')
    this.workspacesDir = path.join(dataPath, 'workspaces')
    this.load()
  }

  attach(runtime: SessionRuntime) {
    this.runtime = runtime
  }

  attachVoice(tts: TtsClient, voices: VoiceStore) {
    this.tts = tts
    this.voices = voices
  }

  attachJudge(judge: ProactiveJudge) {
    this.judge = judge
  }

  // 入站语音：优先取网关自带转写；否则调用 OneBot fetch_ptt_text（SnowLuma 支持）；都失败则存 [语音]
  async enrichVoiceEvent(event: OB11MessageEvent): Promise<void> {
    const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
    const records = segments.filter((seg) => seg.type === 'record')
    if (records.length === 0) return
    const hasText = records.some((seg) => typeof seg.data?.text === 'string' && String(seg.data.text).trim())
    if (this.config.voiceAsrEnabled && !hasText) {
      const mid = typeof event.message_id === 'number' ? event.message_id : Number(event.message_id)
      if (Number.isFinite(mid)) {
        try {
          const result = await Promise.race([
            this.runtime.actions.call('fetch_ptt_text', { message_id: mid }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15_000)),
          ])
          const text = extractPttText(result)
          if (text) {
            for (const seg of records) {
              if (!seg.data?.text) seg.data = { ...(seg.data ?? {}), text }
            }
            this.log('语音转文字成功: ' + text.slice(0, 40))
          }
        } catch (e) {
          this.log('语音转文字不可用: ' + String((e as Error)?.message ?? e))
        }
      }
    }
    // 语音消息统一用可读文本入库/进上下文（避免 raw_message 只剩 [CQ:record,...]）
    const readable = extractText(segments)
    if (readable) event.raw_message = readable
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

  // ---- 控制面板用：只读快照 + 会话语义操作 ----

  listScopes(): { scope: string; sessionId: string; directory: string }[] {
    return [...this.map.entries()].map(([scope, entry]) => ({ scope, ...entry }))
  }

  workspaceOf(scope: string): string | null {
    return this.map.has(scope) ? this.workspaceFor(scope) : null
  }

  pendingOf(scope: string): { id: number | null; userId: number; line: string }[] {
    return [...(this.pendingRequests.get(scope) ?? [])]
  }

  selfIdOf(): number {
    return this.selfId
  }

  // 面板触发：删除并重建 session（与群命令 /reset 的区别是不往 QQ 发提示）
  async resetScope(scope: string): Promise<boolean> {
    if (!this.map.has(scope)) return false
    await this.reset(scope)
    return true
  }

  async abortScope(scope: string): Promise<boolean> {
    const entry = this.map.get(scope)
    if (!entry) return false
    await this.oc.abort(entry.sessionId)
    return true
  }

  // 把模型写入单个工作区 opencode.json（默认模型 / vision-bridge 子代理模型）
  // visionModel: string=更新；null=移除 vision-bridge；undefined=不动
  private patchWorkspaceModel(scope: string, hostModel?: string, visionModel?: string | null): boolean {
    const file = path.join(this.workspaceFor(scope), 'opencode.json')
    try {
      if (!fs.existsSync(file)) return false
      const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>
      if (hostModel) json.model = hostModel
      if (visionModel !== undefined) {
        const agents = (json.agents ?? {}) as Record<string, Record<string, unknown>>
        if (visionModel === null) delete agents['vision-bridge']
        else agents['vision-bridge'] = { ...(agents['vision-bridge'] ?? {}), model: visionModel }
        json.agents = agents
      }
      fs.writeFileSync(file, JSON.stringify(json, null, 2))
      return true
    } catch (e) {
      this.log('更新工作区模型失败 ' + scope + ':', e)
      return false
    }
  }

  // 切换所有已登记 Session 的模型（保留上下文），并同步工作区默认配置
  async switchModelForAll(modelId: string): Promise<{ switched: number; failed: { scope: string; error: string }[] }> {
    const parts = modelId.split('/')
    const providerID = parts.shift() ?? ''
    const id = parts.join('/')
    if (!providerID || !id) throw new Error('模型 ID 格式应为 provider/model')
    this.hostVisionCache = null
    const native = await this.hostSupportsVision()
    const result = { switched: 0, failed: [] as { scope: string; error: string }[] }
    for (const [scope, entry] of this.map.entries()) {
      this.patchWorkspaceModel(scope, modelId, native ? null : this.config.visionModel)
      try {
        await this.oc.switchSessionModel(entry.sessionId, { providerID, id })
        result.switched++
      } catch (e) {
        result.failed.push({ scope, error: String((e as Error)?.message ?? e) })
      }
    }
    this.log('切换模型 ' + modelId + ': 成功 ' + result.switched + '，失败 ' + result.failed.length)
    return result
  }

  // 更新所有工作区的识图子代理模型（新会话/子代理调用生效）
  async updateAllWorkspaceVisionModel(modelId: string): Promise<number> {
    if (await this.hostSupportsVision()) return 0
    let updated = 0
    for (const scope of this.map.keys()) {
      if (this.patchWorkspaceModel(scope, undefined, modelId)) updated++
    }
    return updated
  }

  // 定时提醒到点：构造 synthetic 上下文唤醒模型，让它用自己的语气发提醒；模型 90s 内没发则退回固定文案
  async deliverReminder(scope: string, text: string, fallbackText: string): Promise<'agent'> {
    const entry = await this.ensureSession(scope, this.syntheticEventForScope(scope))
    if (!entry) throw new Error('会话建立失败')
    // 只把提醒内容交给模型，怎么处理由它结合上下文决定
    const notice = '[系统提醒] 你之前设置的定时提醒到时间了：' + text
    const injectedAt = Math.floor(Date.now() / 1000)
    await this.prompt(entry.sessionId, notice)
    const timer = setTimeout(() => {
      try {
        const rows = this.db.query(
          scope,
          dayKey(Math.floor(Date.now() / 1000)),
          'SELECT 1 FROM message WHERE user_id = ? AND time >= ? LIMIT 1',
          [this.selfId, injectedAt]
        )
        if (rows.length === 0) {
          this.log('提醒唤醒后未检测到发言，退回直接发送 scope=' + scope)
          void this.sendTextToScope(scope, fallbackText)
        }
      } catch {
        // 查询失败就不兜底，避免重复发送
      }
    }, 90_000)
    timer.unref?.()
    return 'agent'
  }

  private syntheticEventForScope(scope: string): OB11MessageEvent {
    const now = Math.floor(Date.now() / 1000)
    if (scope.startsWith('group-')) {
      return { post_type: 'message', message_type: 'group', group_id: Number(scope.slice(6)), self_id: this.selfId, time: now, user_id: 0, sender: { user_id: 0, nickname: '系统' }, message: [] }
    }
    const user = Number(scope.slice(8))
    return { post_type: 'message', message_type: 'private', user_id: user, self_id: this.selfId, time: now, sender: { user_id: user, nickname: '对方' }, message: [] }
  }

  private workspaceFor(scope: string): string {
    return path.join(this.workspacesDir, scope)
  }

  // 主模型是否声明了图片输入能力（多模态）；查 OpenCode 模型目录并缓存 5 分钟
  async hostSupportsVision(): Promise<boolean> {
    const modelId = this.config.hostModel
    const now = Date.now()
    if (this.hostVisionCache && this.hostVisionCache.model === modelId && now - this.hostVisionCache.at < 5 * 60_000) {
      return this.hostVisionCache.vision
    }
    let vision = false
    try {
      const parts = modelId.split('/')
      const providerID = parts.shift() ?? ''
      const id = parts.join('/')
      const models = await this.oc.listModels()
      const found = models.find((m) => m.providerID === providerID && (m.modelID ?? m.id) === id)
      vision = !!found && Array.isArray(found.capabilities?.input) && found.capabilities.input.includes('image')
    } catch (e) {
      this.log('读取主模型能力失败（按纯文本处理，识图子代理兜底）:', e)
      vision = false
    }
    this.hostVisionCache = { model: modelId, vision, at: now }
    return vision
  }

  // 图片处理策略：主模型多模态→直接读图；否则配置了 visionModel 就用 vision-bridge；否则看图不可用
  async visionStrategy(): Promise<VisionStrategy> {
    if (await this.hostSupportsVision()) return 'native'
    return this.config.visionModel ? 'bridge' : 'none'
  }

  private async ensureWorkspaceFiles(scope: string, event: OB11MessageEvent) {
    const directory = this.workspaceFor(scope)
    fs.mkdirSync(directory, { recursive: true })
    const vision = await this.visionStrategy()
    const agentsMd =
      event.message_type === 'group'
        ? buildGroupAgentsMd(this.config, String(event.group_id), event.group_name ?? '', vision)
        : buildPrivateAgentsMd(this.config, String(event.user_id), event.sender?.nickname ?? '', vision)
    // 只有主模型没有视觉能力时才注册 vision-bridge 子代理；多模态主模型直接读图
    const ocConfig: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      // instructions 是 session 级快照：新会话生效；已有会话在 compact 后重新读取
      instructions: ['./' + MEMORY_FILE],
      model: this.config.hostModel,
      mcp: {
        servers: {
          qqbot: {
            type: 'remote',
            url: this.config.mcpUrl,
            disabled: false,
            codemode: false,
            oauth: false,
            timeout: { startup: 8000, catalog: 8000, execution: 8000 },
            headers: {
              authorization: `Bearer ${this.config.mcpToken}`,
              'x-qqbot-scope': scope,
            },
          },
        },
      },
    }
    if (vision === 'bridge') {
      ocConfig.agents = {
        'vision-bridge': {
          description: '视觉跳板：读取图片/视频文件并输出详细文字描述，供纯文本模型调用',
          model: this.config.visionModel,
          mode: 'subagent',
          system:
            '你是视觉跳板。用户会给你一个图片或视频的文件路径（在工作目录下，如 inbox/xxx.jpg）。用 read 工具读取该文件，然后用中文输出详细、客观的内容描述（画面主体、文字、细节、氛围）。只输出描述本身，不要评价、不要回答用户其他问题。',
        },
      }
    }
    const ocJson = JSON.stringify(ocConfig, null, 2)
    // 记忆文件只做"不存在则创建"，永不覆盖（梦境整理会原子替换它）
    try {
      const memoryPath = path.join(directory, MEMORY_FILE)
      if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, MEMORY_TEMPLATE)
        this.log(`工作区文件已创建: ${scope}/${MEMORY_FILE}`)
      }
    } catch (e) {
      this.log(`创建 ${MEMORY_FILE} 失败:`, e)
    }
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
    await this.ensureWorkspaceFiles(scope, event)
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

  // 主动参与：节流检查 → 调轻量判官决定是否让主模型判断/接话
  private async tryProactive(scope: string, event: OB11MessageEvent, segments: MsgSegment[]): Promise<boolean> {
    const cfg = this.config
    if (!cfg.proactiveEnabled) return false
    if (event.message_type !== 'group') return false
    if ((this.pendingRequests.get(scope) ?? []).length > 0) return false
    const now = Date.now()
    const recentBot = this.lastSent.get(scope)?.at ?? 0
    if (recentBot && now - recentBot < 15_000) return false
    const lastAt = this.proactiveLastAt.get(scope) ?? 0
    if (lastAt && now - lastAt < Math.max(0, cfg.proactiveMinIntervalSec) * 1000) return false
    const count = (this.proactiveNewCount.get(scope) ?? 0) + 1
    this.proactiveNewCount.set(scope, count)
    if (count < Math.max(1, cfg.proactiveMinMessages)) return false
    const attempts = (this.proactiveAttempts.get(scope) ?? []).filter((t) => now - t < 3_600_000)
    this.proactiveAttempts.set(scope, attempts)
    if (attempts.length >= Math.max(1, cfg.proactiveMaxPerHour)) return false
    const text = extractText(segments).trim()
    if (!text && !segments.some((seg) => seg.type === 'image')) return false
    if (Math.random() * 100 >= Math.max(0, Math.min(100, cfg.proactiveChance))) return false
    this.proactiveNewCount.set(scope, 0)
    this.proactiveLastAt.set(scope, now)
    this.proactiveAttempts.set(scope, [...attempts, now])
    if (!this.judge) return false
    const recent = this.recentChatLines(scope, 12)
    if (recent.length === 0) {
      const nick = event.sender?.card || event.sender?.nickname || String(event.user_id ?? '')
      recent.push('[' + hhmm(event.time ?? Math.floor(now / 1000)) + '] ' + nick + '(' + (event.user_id ?? '') + '): ' + (text || '[图片]'))
    }
    const decision = await this.judge.decide(recent)
    this.log('主动参与判断 -> ' + (decision.participate ? 'REPLY' : 'SILENT') + ' (' + decision.source + (decision.reason ? ', ' + decision.reason : '') + ') scope=' + scope)
    return decision.participate
  }

  private recentChatLines(scope: string, limit: number): string[] {
    const out: { time: number; line: string }[] = []
    const now = Math.floor(Date.now() / 1000)
    const seen = new Set<number>()
    for (const day of [dayKey(now - 86400), dayKey(now)]) {
      try {
        const rows = this.db.query(scope, day, 'SELECT msg_pk, time, nickname, user_id, text FROM message ORDER BY msg_pk DESC LIMIT ?', [limit])
        for (const r of rows.reverse()) {
          const pk = Number(r.msg_pk)
          if (seen.has(pk)) continue
          seen.add(pk)
          out.push({ time: Number(r.time), line: '[' + hhmm(Number(r.time)) + '] ' + String(r.nickname || r.user_id) + '(' + r.user_id + '): ' + cleanCqForDisplay(String(r.text ?? '')) })
        }
      } catch {
        // day db missing
      }
    }
    out.sort((a, b) => a.time - b.time)
    return out.slice(-limit).map((x) => x.line)
  }

  private buildPrompt(event: OB11MessageEvent, proactive = false): string {
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
          if (!proactive && currentId !== null && mid === currentId) continue
          if (sent.has(mid)) continue
          if (pending.some((p) => p.id === mid)) continue
          const nick = String(r.nickname || r.user_id)
          candidates.push({ mid, line: `[${hhmm(Number(r.time))}] ${nick}(${r.user_id}): ${cleanCqForDisplay(String(r.text ?? ''))}` })
        }
      } catch {
        // no db for that day
      }
    }
    let context = candidates.slice(-this.config.contextMessageCount)
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
    if (proactive) {
      // 主动参与：当前消息只是普通聊天记录，不进入「待回应清单」
      context = [...context, { mid: currentId ?? 0, line: currentLine }].slice(-this.config.contextMessageCount)
    } else {
      pending.push({ id: currentId, userId: event.user_id ?? 0, line: currentLine })
      this.pendingRequests.set(scope, pending)
    }

    const parts: string[] = []
    const d = new Date()
    const p2 = (n: number) => String(n).padStart(2, '0')
    const week = '日一二三四五六'[d.getDay()]
    parts.push(`[当前时间] ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())} 星期${week}（以此为准，下面消息前面的方括号是它们的发送时间）`)
    if (context.length > 0) parts.push('[新的聊天记录]\n' + context.map((c) => c.line).join('\n'))
    if (proactive) {
      parts.unshift(
        '[系统] 这条消息没有@你，也不是在回复你。你可以根据最近的群聊自己判断要不要主动接一句：' +
          '只有真的有趣、有梗、能帮上忙或者适合插话的时候，才用 qqbot_send_message 发言；' +
          '不想说、没把握、或者别人在聊私事/严肃话题时，只输出 [SILENT]，系统不会发任何消息。' +
          '不要为了刷存在感硬接，宁可沉默。'
      )
    } else {
      parts.push(
        `[待回应的请求，共 ${pending.length} 条，请逐条回应]\n` + pending.map((p, i) => `${i + 1}. ${p.line}`).join('\n')
      )
    }
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

    const triggered = this.isTriggered(event, segments)
    let proactive = false
    if (!triggered) {
      if (!(await this.tryProactive(scope, event, segments))) return
      proactive = true
    } else {
      // 正常被叫到后重置主动参与节流，避免刚回复完又主动插话
      this.proactiveNewCount.set(scope, 0)
      this.proactiveLastAt.set(scope, Date.now())
    }

    const mid = typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || null
    const pendingNow = this.pendingRequests.get(scope) ?? []
    if (mid !== null && pendingNow.some((p) => p.id === mid)) return

    this.log((proactive ? '主动参与 ' : '触发 ') + `scope=${scope} msg_id=${event.message_id} user=${event.user_id}`)

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
    const prompt = this.buildPrompt(event, proactive)
    if (!prompt) return
    const replyTo = extractReplyTo(segments)
    // 商城/收藏表情在 SnowLuma 里是带 emoji_id 的 image 段：交给视觉模型没意义，
    // 由上下文文本里的 [表情包: ...] 描述代替（见 app.ts storeMessage）
    const stickerUrls = new Set(
      segments
        .filter((seg) => seg.type === 'image' && seg.data?.emoji_id && typeof seg.data.url === 'string')
        .map((seg) => String(seg.data.url))
    )
    const images = dedupeImages([
      ...extractImages(segments),
      ...extractImagesFromRaw(event.raw_message ?? ''),
      ...(replyTo !== null ? this.quotedImages(scope, replyTo) : []),
    ]).filter((img) => !stickerUrls.has(img.url))
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
    const strategy = await this.visionStrategy()
    if (strategy === 'native') {
      return `\n[系统] 这条消息带了图片，已存到工作目录：${notes.join('、')}。你的模型支持图片输入，直接用 read 工具读取图片内容。`
    }
    if (strategy === 'bridge') {
      return `\n[系统] 这条消息带了图片，已存到工作目录：${notes.join('、')}。用 subagent 工具调 vision-bridge 子代理读取图片内容后再回答。`
    }
    return `\n[系统] 这条消息带了图片，已存到工作目录：${notes.join('、')}。你当前没有可用的看图能力，回复里直接说明看不到图或请对方描述。`
  }

  private async reset(scope: string) {
    const entry = this.map.get(scope)
    if (!entry) return
    await this.oc.deleteSession(entry.sessionId).catch(() => undefined)
    this.map.delete(scope)
    this.reverse.delete(entry.sessionId)
    this.save()
  }

  private clearPending(scope: string) {
    const pending = this.pendingRequests.get(scope) ?? []
    if (pending.length > 0) this.markSent(scope, pending.map((p) => p.id))
    this.pendingRequests.delete(scope)
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
        try {
          const map = await this.oc.getStatus()
          present = map[sessionId] !== undefined
        } catch {
          continue
        }
        if (present) {
          sawBusy = true
          if (busySince === 0) busySince = Date.now()
          if (Date.now() - busySince > this.config.turnTimeoutSec * 1000) {
            this.log(`轮次超时(${this.config.turnTimeoutSec}s)，中断 session=${sessionId}`)
            await this.oc.abort(sessionId).catch(() => undefined)
            const scope = this.reverse.get(sessionId)
            if (scope) {
              this.clearPending(scope)
              await this.sendTextToScope(scope, '我这边卡住了，刚才那条没接上，再说一次呗')
            }
            return
          }
          continue
        }
        busySince = 0
        if (!sawBusy && Date.now() < busyDeadline) continue
        await this.onSessionIdle(sessionId)
        return
      }
      this.log(`watchdog 超时 session=${sessionId}`)
      const scope = this.reverse.get(sessionId)
      if (scope) this.clearPending(scope)
    })()
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.oc.promptAsync(sessionId, text)
    this.watch(sessionId)
  }

  onAssistantText(sessionId: string, text: string) {
    if (!this.reverse.has(sessionId)) return
    const previous = this.lastText.get(sessionId)
    this.lastText.set(sessionId, previous ? `${previous}\n${text}` : text)
  }

  async handleOpencodeEvent(ev: OpencodeEvent): Promise<void> {
    const sessionId = typeof ev.data.sessionID === 'string' ? ev.data.sessionID : ''
    if (!sessionId) return
    if (ev.type === 'session.text.ended') {
      if (typeof ev.data.text === 'string') this.onAssistantText(sessionId, ev.data.text)
      return
    }
    if (ev.type === 'session.execution.succeeded') {
      await this.onSessionIdle(sessionId)
      return
    }
    if (ev.type === 'session.execution.failed') {
      const scope = this.reverse.get(sessionId)
      if (!scope) return
      this.clearPending(scope)
      this.sentViaTool.delete(sessionId)
      this.lastText.delete(sessionId)
      this.log(`opencode 执行失败 session=${sessionId}:`, ev.data.error)
      await this.sendTextToScope(scope, '我这边刚才出了点问题，再说一次呗')
      return
    }
    if (ev.type === 'session.execution.interrupted') {
      this.lastText.delete(sessionId)
      if (ev.data.reason !== 'user') return
      const scope = this.reverse.get(sessionId)
      if (scope) this.clearPending(scope)
      this.sentViaTool.delete(sessionId)
    }
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
    await this.runtime.actions.call('send_msg', params)
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
    // Agent 一轮可能并发调多次 qqbot_send_message；按 scope 串行化 + 小间隔，保证 QQ 端显示顺序与调用顺序一致
    const prev = this.sendQueues.get(scope) ?? Promise.resolve()
    const next = prev.then(() => this.doSendToScope(scope, text, opts)).catch((e) => {
      this.log('发送失败:', e)
    })
    this.sendQueues.set(scope, next)
    return next
  }

  private async doSendToScope(scope: string, text: string, opts?: { replyTo?: number | string; atQq?: number | string }): Promise<void> {
    const previous = this.lastSent.get(scope)
    if (previous && previous.text === text && Date.now() - previous.at < SessionController.DUPLICATE_SEND_WINDOW_MS) {
      this.log('忽略重复发送(' + scope + '): ' + text.slice(0, 40))
      return
    }
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
    await this.runtime.actions.call('send_msg', params)
    this.recordSent(scope, text)
    this.lastSent.set(scope, { text, at: Date.now() })
    await this.delay()
  }

  // ---- 语音：TTS 生成后以 record 段发送；每个 scope 可设置独立音色描述 ----
  voiceOf(scope: string): string {
    return this.voices?.get(scope) ?? this.config.ttsDefaultVoice
  }

  setVoiceForScope(scope: string, description: string): string | null {
    if (!this.voices) throw new Error('VoiceStore 未初始化')
    return this.voices.set(scope, description)
  }

  async sendVoiceToScope(scope: string, text: string): Promise<void> {
    const prev = this.sendQueues.get(scope) ?? Promise.resolve()
    const next = prev.then(() => this.doSendVoice(scope, text)).catch((e) => {
      this.log('发送语音失败:', e)
    })
    this.sendQueues.set(scope, next)
    return next
  }

  private async doSendVoice(scope: string, text: string): Promise<void> {
    if (!this.tts) throw new Error('TTS 未初始化')
    const trimmed = text.trim()
    if (!trimmed) throw new Error('语音文本为空')
    const max = Math.max(1, this.config.ttsMaxChars || 200)
    if (trimmed.length > max) throw new Error('语音文本过长（最多 ' + max + ' 字，当前 ' + trimmed.length + ' 字）')
    const voice = this.voiceOf(scope)
    const { buffer, format } = await this.tts.synthesize(trimmed, voice)
    const dir = path.join(this.dataPath, 'tts-tmp')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'tts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + format)
    fs.writeFileSync(file, buffer)
    const params: Record<string, unknown> = { message: [{ type: 'record', data: { file } }] }
    if (scope.startsWith('group-')) {
      params.message_type = 'group'
      params.group_id = scope.slice(6)
    } else {
      params.message_type = 'private'
      params.user_id = scope.slice(8)
    }
    try {
      await this.runtime.actions.call('send_msg', params)
      this.recordSent(scope, '[语音]')
      this.lastSent.set(scope, { text: '[语音]', at: Date.now() })
      await this.delay()
    } finally {
      try {
        fs.unlinkSync(file)
      } catch {
        // 临时音频清理失败不影响已发送
      }
    }
  }

  async sendPokeToScope(scope: string, qq: string): Promise<void> {
    if (scope.startsWith('group-')) {
      await this.runtime.actions.call('group_poke', { group_id: scope.slice(6), user_id: qq })
    } else {
      await this.runtime.actions.call('friend_poke', { user_id: qq })
    }
  }

  // ---- 收藏表情（SnowLuma / NapCat：fetch_custom_face_detail + send_custom_face）----

  // 从网关拉取账号收藏表情的原始详情（同步到本地表情库用，不直接给 Agent）
  async fetchStickerDetails(limit = 200): Promise<{ id: string; md5: string; url: string; desc: string }[]> {
    const count = Math.min(Math.max(1, Math.floor(limit)), 500)
    const raw = await this.runtime.actions.call('fetch_custom_face_detail', { count })
    const data =
      raw && typeof raw === 'object' && !Array.isArray(raw) && 'data' in raw ? (raw as { data?: unknown }).data : raw
    const list = Array.isArray(data)
      ? (data as { emoji_id?: unknown; resId?: unknown; md5?: unknown; url?: unknown; desc?: unknown }[])
      : []
    return list
      .map((d) => ({
        id: String(d.emoji_id ?? d.resId ?? ''),
        md5: String(d.md5 ?? ''),
        url: String(d.url ?? ''),
        desc: String(d.desc ?? ''),
      }))
      .filter((d) => d.id.length > 0)
  }

  async sendStickerToScope(scope: string, sticker: string, opts?: { replyTo?: number | string }): Promise<void> {
    const prev = this.sendQueues.get(scope) ?? Promise.resolve()
    const next = prev.then(() => this.doSendSticker(scope, sticker, opts)).catch((e) => {
      this.log('发表情失败:', e)
    })
    this.sendQueues.set(scope, next)
    return next
  }

  private async doSendSticker(scope: string, sticker: string, opts?: { replyTo?: number | string }): Promise<void> {
    const params: Record<string, unknown> = { emoji_id: sticker }
    if (scope.startsWith('group-')) {
      params.group_id = scope.slice(6)
    } else {
      params.user_id = scope.slice(8)
    }
    if (opts?.replyTo) params.reply_to = String(opts.replyTo)
    await this.runtime.actions.call('send_custom_face', params)
    this.recordSent(scope, '[表情]')
    await this.delay()
  }
}
