import fs from 'node:fs'
import path from 'node:path'

export interface VoiceRecord {
  description: string
  updatedAt: number
}

// 每个 scope（群/私聊）独立的声音描述；为空时用配置里的 ttsDefaultVoice
export class VoiceStore {
  private file: string
  private items = new Map<string, VoiceRecord>()

  constructor(private dataPath: string, private log: (msg: string, ...args: unknown[]) => void) {
    this.file = path.join(dataPath, 'voices.json')
    this.load()
  }

  private load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, VoiceRecord>
      for (const [scope, rec] of Object.entries(raw)) {
        if (rec && typeof rec.description === 'string') this.items.set(scope, rec)
      }
    } catch (e) {
      this.log('voices.json 读取失败，从零开始:', e)
    }
  }

  private save() {
    try {
      fs.mkdirSync(this.dataPath, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.items), null, 2))
    } catch (e) {
      this.log('voices.json 写入失败:', e)
    }
  }

  get(scope: string): string | null {
    return this.items.get(scope)?.description ?? null
  }

  set(scope: string, description: string): string | null {
    const desc = description.trim().slice(0, 500)
    if (!desc) {
      this.items.delete(scope)
      this.save()
      return null
    }
    this.items.set(scope, { description: desc, updatedAt: Math.floor(Date.now() / 1000) })
    this.save()
    return desc
  }

  list(): { scope: string; description: string; updatedAt: number }[] {
    return [...this.items.entries()].map(([scope, rec]) => ({ scope, ...rec }))
  }
}