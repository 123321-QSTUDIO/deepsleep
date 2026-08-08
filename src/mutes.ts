import fs from 'node:fs'
import path from 'node:path'

interface MuteEntry {
  until: number
  reason: string
}

export class MuteStore {
  private map = new Map<string, MuteEntry>()
  private file: string

  constructor(dataPath: string) {
    this.file = path.join(dataPath, 'mutes.json')
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Record<string, MuteEntry>
        for (const [k, v] of Object.entries(raw)) this.map.set(k, v)
      }
    } catch {
      // start fresh
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2))
  }

  private key(scope: string, qq: string) {
    return `${scope}:${qq}`
  }

  isMuted(scope: string, qq: string): boolean {
    const entry = this.map.get(this.key(scope, qq))
    if (!entry) return false
    if (entry.until <= Math.floor(Date.now() / 1000)) {
      this.map.delete(this.key(scope, qq))
      this.save()
      return false
    }
    return true
  }

  mute(scope: string, qq: string, minutes: number, reason: string): number {
    const until = Math.floor(Date.now() / 1000) + minutes * 60
    this.map.set(this.key(scope, qq), { until, reason })
    this.save()
    return until
  }

  unmute(scope: string, qq: string): boolean {
    const existed = this.map.delete(this.key(scope, qq))
    if (existed) this.save()
    return existed
  }
}
