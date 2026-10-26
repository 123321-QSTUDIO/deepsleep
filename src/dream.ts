import fs from 'node:fs'
import path from 'node:path'
import { PluginConfig } from './config'
import { cleanCqForDisplay } from './format'
import { dayKey, MsgDB } from './msgdb'
import { OcMessage, OpencodeClient } from './opencode'
import { MEMORY_FILE, MEMORY_TEMPLATE, SessionController } from './sessions'

// 梦境记忆：每天凌晨 fork 每个会话，用当天群聊记录更新 MEMORY.md，
// 原子替换后删除临时 fork 会话，再 compact 原会话（compact 会让原会话重新读取 instructions）

export interface DreamDeps {
  config: PluginConfig
  db: MsgDB
  sessions: SessionController
  oc: OpencodeClient
  dataPath: string
  log: (msg: string, ...args: unknown[]) => void
}

export interface DreamStateEntry {
  date: string
  at: number
  ok: boolean
  error?: string
  transcriptChars?: number
  memoryChars?: number
  compacted?: boolean
  durationMs?: number
}

export interface DreamResult {
  ok: boolean
  scope: string
  skipped?: string
  error?: string
  dreamSessionId?: string
  transcriptChars?: number
  memoryChars?: number
  compacted?: boolean
  durationMs?: number
}

type DreamState = Record<string, DreamStateEntry>

const TICK_MS = 60_000
const CATCH_UP_MS = 3 * 3600_000
const DREAM_TIMEOUT_MS = 6 * 60_000
const COMPACT_TIMEOUT_MS = 5 * 60_000

export class DreamMemory {
  private stateFile: string
  private state: DreamState = {}
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private runningScopes = new Set<string>()

  constructor(private deps: DreamDeps) {
    this.stateFile = path.join(deps.dataPath, 'dream.json')
    this.load()
  }

  start() {
    const { config, log } = this.deps
    if (!config.dreamMemoryEnabled) {
      log('梦境记忆未启用 (dreamMemoryEnabled=false)')
      return
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    const h = String(config.dreamMemoryHour).padStart(2, '0')
    const m = String(config.dreamMemoryMinute).padStart(2, '0')
    log(`梦境记忆已启用: 每天 ${h}:${m} 起整理（错过会在 3 小时内补跑）`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stateOf(scope: string): DreamStateEntry | null {
    return this.state[scope] ?? null
  }

  allState(): DreamState {
    return { ...this.state }
  }

  // ---- 调度 ----

  private scheduledAt(now = new Date()): number {
    const { dreamMemoryHour, dreamMemoryMinute } = this.deps.config
    const d = new Date(now)
    d.setHours(dreamMemoryHour, dreamMemoryMinute, 0, 0)
    return d.getTime()
  }

  private async tick() {
    const { config, sessions, log } = this.deps
    if (!config.dreamMemoryEnabled || this.ticking) return
    const now = Date.now()
    const scheduled = this.scheduledAt()
    if (now < scheduled) return
    if (now - scheduled > CATCH_UP_MS) return // 错过窗口太久，等明天
    const today = dayKey(Math.floor(now / 1000))
    const scopes = sessions.listScopes().filter((e) => e.sessionId)
    if (scopes.length === 0) return
    const todo = scopes.filter((e) => this.state[e.scope]?.date !== today)
    if (todo.length === 0) return
    this.ticking = true
    try {
      for (const entry of todo) {
        const result = await this.runForScope(entry.scope).catch((e) => ({ ok: false, scope: entry.scope, error: String(e?.message ?? e) } as DreamResult))
        log(`梦境整理 ${entry.scope}: ${result.ok ? '完成' : result.skipped ? '跳过(' + result.skipped + ')' : '失败(' + (result.error ?? '?') + ')'}`)
      }
    } finally {
      this.ticking = false
    }
  }

  // ---- 单个会话的梦境整理（面板可手动触发） ----

  async runForScope(scope: string): Promise<DreamResult> {
    const { sessions, oc, config, log } = this.deps
    if (this.runningScopes.has(scope)) return { ok: false, scope, skipped: '正在整理中' }
    const entry = sessions.listScopes().find((e) => e.scope === scope)
    if (!entry?.sessionId) return { ok: false, scope, error: '该会话还没有 OpenCode session' }
    const sessionId = entry.sessionId
    const workspace = entry.directory
    const started = Date.now()
    this.runningScopes.add(scope)
    const state = this.state[scope]
    const now = Math.floor(Date.now() / 1000)
    const since = Math.max((state?.at ?? now - 86400), now - 48 * 3600)
    const today = dayKey(now)
    let dreamSessionId: string | undefined
    try {
      // 群聊上下文批量投喂开启时，当天聊天记录已经在原 session 的上下文里；
      // fork 会继承这段历史，梦境不需要再从 DB 重新拼 transcript。
      const useContext = !!config.groupContextBatchEnabled && !!config.proactiveEnabled
      const transcript = useContext ? '' : this.gatherTranscript(scope, since)
      if (useContext) {
        const existing = await oc.getMessages(sessionId, 1).catch(() => [] as OcMessage[])
        if (existing.length === 0) {
          this.record(scope, today, { ok: true, at: now, error: undefined, transcriptChars: 0, compacted: false })
          return { ok: true, scope, skipped: '会话还没有可整理的上下文' }
        }
      } else if (!transcript.trim()) {
        this.record(scope, today, { ok: true, at: now, error: undefined, transcriptChars: 0, compacted: false })
        return { ok: true, scope, skipped: '没有新的群聊记录' }
      }
      this.ensureMemoryFile(workspace)
      // fork 一份短命会话：继承原会话上下文，专门做记忆整理
      const forked = await oc.forkSession(sessionId)
      dreamSessionId = forked.id
      log(`梦境整理 ${scope}: fork ${sessionId} -> ${dreamSessionId}`)
      const prompt = this.buildPrompt(scope, transcript, useContext)
      await oc.promptAsync(dreamSessionId, prompt)
      const produced = await this.waitForDreamOutput(dreamSessionId, workspace, DREAM_TIMEOUT_MS)
      if (!produced) {
        const err = '梦境会话超时未产出 MEMORY.new.md'
        this.record(scope, today, { ok: false, at: now, error: err })
        return { ok: false, scope, error: err, dreamSessionId }
      }
      const newMemory = this.readNewMemory(workspace)
      if (!newMemory) {
        const err = '梦境会话没有产出有效的 MEMORY.new.md'
        this.record(scope, today, { ok: false, at: now, error: err })
        return { ok: false, scope, error: err, dreamSessionId }
      }
      const memoryChars = newMemory.length
      this.replaceMemory(workspace, newMemory)
      log(`梦境整理 ${scope}: MEMORY.md 已更新 (${memoryChars} 字)`)
      const compacted = await this.compactOriginal(sessionId)
      const durationMs = Date.now() - started
      this.record(scope, today, { ok: true, at: now, transcriptChars: transcript.length, memoryChars, compacted, durationMs })
      return { ok: true, scope, transcriptChars: transcript.length, memoryChars, compacted, durationMs, dreamSessionId }
    } catch (e) {
      const err = String((e as Error)?.message ?? e)
      this.record(scope, today, { ok: false, at: now, error: err })
      log(`梦境整理 ${scope} 失败:`, err)
      return { ok: false, scope, error: err, dreamSessionId }
    } finally {
      // 无论成败都删掉临时 fork 会话
      if (dreamSessionId) await oc.deleteSession(dreamSessionId).catch(() => undefined)
      try {
        const leftover = path.join(workspace, 'MEMORY.new.md')
        if (fs.existsSync(leftover)) fs.rmSync(leftover, { force: true })
      } catch {
        // 清理失败不影响主流程
      }
      this.runningScopes.delete(scope)
    }
  }

  // ---- 内部实现 ----

  private load() {
    try {
      if (fs.existsSync(this.stateFile)) {
        this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) as DreamState
      }
    } catch (e) {
      this.deps.log('dream.json 读取失败，从零开始:', e)
    }
  }

  private record(scope: string, date: string, entry: Omit<DreamStateEntry, 'date'>) {
    this.state[scope] = { date, ...entry }
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2))
    } catch (e) {
      this.deps.log('dream.json 写入失败:', e)
    }
  }

  private gatherTranscript(scope: string, since: number): string {
    const { db, config } = this.deps
    const days = db.listDays(scope).filter((d) => d >= dayKey(since))
    const rows: { time: number; nickname: string; user_id: number | null; text: string }[] = []
    for (const day of days) {
      try {
        const got = db.query(
          scope,
          day,
          'SELECT time, nickname, user_id, text FROM message WHERE time >= ? ORDER BY msg_pk ASC',
          [since]
        ) as unknown as { time: number; nickname: string; user_id: number | null; text: string }[]
        rows.push(...got)
      } catch {
        // 某天文件损坏就跳过
      }
    }
    rows.sort((a, b) => Number(a.time) - Number(b.time))
    const lines: string[] = []
    for (const r of rows) {
      const text = cleanCqForDisplay(String(r.text ?? '')).replace(/\s+/g, ' ').trim()
      if (!text) continue
      const d = new Date(Number(r.time) * 1000)
      const p = (n: number) => String(n).padStart(2, '0')
      const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      lines.push(`[${stamp}] ${r.nickname || '?'}(${r.user_id ?? '?'}): ${text}`)
    }
    let transcript = lines.join('\n')
    const max = Math.max(1000, config.dreamMaxTranscriptChars)
    if (transcript.length > max) {
      transcript = '（更早的记录已省略）\n' + transcript.slice(-max)
    }
    return transcript
  }

  private ensureMemoryFile(workspace: string) {
    const file = path.join(workspace, MEMORY_FILE)
    if (!fs.existsSync(file)) fs.writeFileSync(file, MEMORY_TEMPLATE)
  }

  private readNewMemory(workspace: string): string | null {
    const file = path.join(workspace, 'MEMORY.new.md')
    if (!fs.existsSync(file)) return null
    const text = fs.readFileSync(file, 'utf-8').trim()
    if (text.length < 20) return null
    if (!text.startsWith('#')) return null
    const max = this.deps.config.dreamMemoryMaxChars
    if (text.length > max * 2) return null
    return text + '\n'
  }

  // 原子替换：先备份旧记忆，再用同目录 rename 覆盖（Windows 上 rename 会替换已存在文件）
  private replaceMemory(workspace: string, content: string) {
    const memoryPath = path.join(workspace, MEMORY_FILE)
    const newPath = path.join(workspace, 'MEMORY.new.md')
    const backupPath = memoryPath + '.bak'
    try {
      if (fs.existsSync(memoryPath)) fs.copyFileSync(memoryPath, backupPath)
    } catch {
      // 备份失败不阻塞替换
    }
    fs.writeFileSync(newPath, content)
    fs.renameSync(newPath, memoryPath)
  }

  // 等梦境会话真正把 MEMORY.new.md 写出来（比猜忙碌状态可靠；失败时等待超时）
  private async waitForDreamOutput(sessionId: string, workspace: string, timeoutMs: number): Promise<boolean> {
    const { oc } = this.deps
    const file = path.join(workspace, 'MEMORY.new.md')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(2500)
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 20) {
          // 文件已出现，再确认会话不再忙碌（避免读到写了一半的内容）
          const active: Record<string, unknown> = await oc.getStatus().catch(() => ({}))
          if (active[sessionId] === undefined) return true
          continue
        }
      } catch {
        // 读取失败下轮再试
      }
      const active: Record<string, unknown> = await oc.getStatus().catch(() => ({}))
      if (active[sessionId] === undefined && Date.now() > deadline - timeoutMs + 15_000) return false
    }
    return false
  }

  private async waitIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
    const { oc } = this.deps
    const deadline = Date.now() + timeoutMs
    let sawBusy = false
    while (Date.now() < deadline) {
      await sleep(2500)
      let active: Record<string, unknown> = {}
      try {
        active = await oc.getStatus()
      } catch {
        continue
      }
      if (active[sessionId] !== undefined) {
        sawBusy = true
        continue
      }
      if (sawBusy || Date.now() > deadline - timeoutMs + 8000) return true
    }
    return !sawBusy ? true : false
  }

  private async compactOriginal(sessionId: string): Promise<boolean> {
    const { oc, log } = this.deps
    try {
      await oc.compactSession(sessionId)
      await this.waitIdle(sessionId, COMPACT_TIMEOUT_MS)
      // 确认压缩消息已完成
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const msgs = await oc.getMessages(sessionId, 20).catch(() => [] as OcMessage[])
        const compaction = msgs.find((m) => m.type === 'compaction')
        if (compaction && (compaction as unknown as { status?: string }).status === 'completed') return true
        await sleep(2000)
      }
      log(`梦境整理: compact 已提交但未在预期时间内完成 session=${sessionId}`)
      return true
    } catch (e) {
      log('梦境整理: compact 失败:', e)
      return false
    }
  }

  private buildPrompt(scope: string, transcript: string, useContext = false): string {
    const { config } = this.deps
    const maxChars = config.dreamMemoryMaxChars
    return `# 梦境整理任务（内部维护任务）

你现在运行在一个临时的 fork 会话里，唯一目标是更新长期记忆文件。不是聊天，不要回复群友。

## 你要做的事
1. 用 read 工具读取当前工作目录下的 ${MEMORY_FILE}（现有长期记忆）。
2. 结合「现有记忆」和下方「本时段群聊记录」，重写一份完整、结构化的长期记忆。
3. 用 write 工具把结果写到工作目录下的「MEMORY.new.md」（**不要直接改 ${MEMORY_FILE}**，替换由宿主完成）。
4. 完成后只回复 DONE 三个字母。

## 记忆文件要求
- Markdown，固定小节：「## 群聊概况」「## 长期事实」「## 群成员」「## 话题与偏好」「## 未完成的事」「## 更新时间」（可增减小节但保持结构清晰）。
- 只保留长期有用的信息：稳定事实、群友关系/称谓、偏好与禁忌、持续话题、约定和未完成事项。
- 不记流水账、不复述闲聊；合并同类项、去重，旧记忆里过时/错误的条目要修正或删除。
- 不记录隐私敏感信息（真实姓名住址、手机号、身份证、账号密码等）；聊天里能看到的信息可以记。
- 全文不超过 ${maxChars} 字，宁缺毋滥；每条一行、以「- 」开头。
- 「更新时间」写当前日期时间。
- 必须输出完整文件（含一级标题和全部小节），不要只写增量。

## 禁止事项
- 禁止调用任何 qqbot_ 开头的工具，禁止向任何 QQ 会话发送消息。
- 禁止修改 AGENTS.md / opencode.json / 其他文件。
- 禁止把 MEMORY.new.md 之外的内容写到别处。

## 本时段群聊记录（scope=${scope}）
${useContext ? `本时段的群聊记录已经作为 user prompt 在你从原会话 fork 继承的上下文中（宿主每 ${Math.max(1, Math.round((this.deps.config.groupContextBatchIntervalSec || 600) / 60))} 分钟批量投喂一次）。直接结合这些上下文和现有记忆整理；不要再去读数据库或用 read 找聊天记录。` : '~~~\n' + transcript + '\n~~~'}
`
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
