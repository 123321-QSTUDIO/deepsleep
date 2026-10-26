import fs from 'node:fs'
import path from 'node:path'

export interface Reminder {
  id: string
  scope: string
  text: string
  dueAt: number
  atUserId?: number
  createdAt: number
  createdBy?: number
  status: 'pending' | 'sent' | 'cancelled'
  sentAt?: number
  attempts: number
}

// 机器人自设倒计时：持久化到期时间，由常驻调度器到点投递
export class ReminderStore {
  private file: string
  private items = new Map<string, Reminder>()
  private seq = 0

  constructor(private dataPath: string, private log: (msg: string, ...args: unknown[]) => void) {
    this.file = path.join(dataPath, 'reminders.json')
    this.load()
  }

  private load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Reminder[]
      for (const r of raw) {
        if (!r || typeof r.text !== 'string' || !r.scope) continue
        this.items.set(r.id, r)
      }
      this.seq = this.items.size
    } catch (e) {
      this.log('reminders.json 读取失败，从零开始:', e)
    }
  }

  private save() {
    try {
      fs.mkdirSync(this.dataPath, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify([...this.items.values()], null, 2))
    } catch (e) {
      this.log('reminders.json 写入失败:', e)
    }
  }

  add(opts: { scope: string; text: string; dueAt: number; atUserId?: number; createdBy?: number }): Reminder {
    const rem: Reminder = {
      id: 'rem_' + Date.now().toString(36) + '_' + (++this.seq),
      scope: opts.scope,
      text: opts.text.trim().slice(0, 500),
      dueAt: Math.floor(opts.dueAt),
      atUserId: opts.atUserId,
      createdBy: opts.createdBy,
      createdAt: Math.floor(Date.now() / 1000),
      status: 'pending',
      attempts: 0,
    }
    this.items.set(rem.id, rem)
    this.save()
    return rem
  }

  pendingOfScope(scope: string): Reminder[] {
    return [...this.items.values()].filter((r) => r.scope === scope && r.status === 'pending').sort((a, b) => a.dueAt - b.dueAt)
  }

  pendingCount(scope: string): number {
    return this.pendingOfScope(scope).length
  }

  due(nowSec: number): Reminder[] {
    return [...this.items.values()].filter((r) => r.status === 'pending' && r.dueAt <= nowSec)
  }

  markSent(id: string) {
    const r = this.items.get(id)
    if (!r) return
    r.status = 'sent'
    r.sentAt = Math.floor(Date.now() / 1000)
    this.save()
  }

  markAttempt(id: string) {
    const r = this.items.get(id)
    if (!r) return
    r.attempts++
    this.save()
  }

  cancel(id: string, scope?: string): Reminder | null {
    const r = this.items.get(id)
    if (!r || r.status !== 'pending') return null
    if (scope && r.scope !== scope) return null
    r.status = 'cancelled'
    this.save()
    return r
  }

  list(scope?: string): Reminder[] {
    const all = [...this.items.values()]
    return (scope ? all.filter((r) => r.scope === scope) : all).sort((a, b) => b.dueAt - a.dueAt)
  }
}

// 常驻调度器：每 N 秒检查到期提醒并投递；投递失败下轮重试
export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private store: ReminderStore,
    private deliver: (reminder: Reminder) => Promise<void>,
    private enabled: () => boolean,
    private intervalSec: number,
    private log: (msg: string, ...args: unknown[]) => void
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), Math.max(1, this.intervalSec) * 1000)
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick() {
    if (this.ticking || !this.enabled()) return
    this.ticking = true
    try {
      const now = Math.floor(Date.now() / 1000)
      for (const r of this.store.due(now)) {
        this.store.markAttempt(r.id)
        try {
          await this.deliver(r)
          this.store.markSent(r.id)
          this.log('已投递提醒 ' + r.id + ' -> ' + r.scope)
        } catch (e) {
          this.log('提醒投递失败（将重试） ' + r.id + ':', e)
        }
      }
    } finally {
      this.ticking = false
    }
  }
}