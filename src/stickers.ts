import fs from 'node:fs'
import path from 'node:path'

// QQ 收藏表情的本地缓存：同步后必须由人（或 AI）打标签并启用，
// Agent 只能看到已打标 + 已启用的表情，避免描述不准/不可发的收藏项被误用。

export interface StickerDetail {
  id: string
  md5?: string
  url?: string
  desc?: string
}

export interface StickerRecord {
  id: string
  md5: string
  url: string
  /** QQ 自带的描述/摘要（可能为空，仅作参考） */
  desc: string
  /** 人工/AI 打的标签，Agent 实际使用的语义描述 */
  label: string
  tags: string[]
  enabled: boolean
  syncedAt: number
  updatedAt: number
}

export class StickerStore {
  private file: string
  private items = new Map<string, StickerRecord>()
  lastSyncAt = 0

  constructor(private dataPath: string, private log: (msg: string, ...args: unknown[]) => void) {
    this.file = path.join(dataPath, 'stickers.json')
    this.load()
  }

  private load() {
    try {
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { lastSyncAt?: number; items?: StickerRecord[] }
      this.lastSyncAt = Number(raw.lastSyncAt ?? 0)
      for (const item of raw.items ?? []) {
        if (item && typeof item.id === 'string' && item.id) this.items.set(item.id, normalize(item))
      }
    } catch (e) {
      this.log('stickers.json 读取失败，从零开始:', e)
    }
  }

  private save() {
    try {
      fs.mkdirSync(this.dataPath, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, lastSyncAt: this.lastSyncAt, items: [...this.items.values()] }, null, 2))
    } catch (e) {
      this.log('stickers.json 写入失败:', e)
    }
  }

  list(): StickerRecord[] {
    return [...this.items.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  get(id: string): StickerRecord | undefined {
    return this.items.get(id)
  }

  stats() {
    const all = [...this.items.values()]
    return {
      total: all.length,
      enabled: all.filter((s) => s.enabled).length,
      labeled: all.filter((s) => s.label.trim().length > 0).length,
      unlabeled: all.filter((s) => s.label.trim().length === 0).length,
      lastSyncAt: this.lastSyncAt,
    }
  }

  /** 同步：保留已有标签/启用状态，只更新 QQ 侧元数据；新表情默认未打标、未启用 */
  upsertSynced(details: StickerDetail[]): { added: number; updated: number; total: number } {
    const now = Math.floor(Date.now() / 1000)
    let added = 0
    let updated = 0
    for (const d of details) {
      const id = String(d.id ?? '').trim()
      if (!id) continue
      const old = this.items.get(id)
      if (old) {
        old.md5 = String(d.md5 ?? old.md5)
        old.url = String(d.url ?? old.url)
        old.desc = String(d.desc ?? old.desc)
        old.syncedAt = now
        updated++
      } else {
        this.items.set(id, normalize({ id, md5: d.md5, url: d.url, desc: d.desc, syncedAt: now }))
        added++
      }
    }
    this.lastSyncAt = now
    this.save()
    return { added, updated, total: this.items.size }
  }

  update(id: string, patch: { label?: unknown; tags?: unknown; enabled?: unknown }): StickerRecord | null {
    const item = this.items.get(id)
    if (!item) return null
    if (patch.label !== undefined) item.label = String(patch.label ?? '').trim().slice(0, 80)
    if (patch.tags !== undefined) {
      const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags ?? '').split(/[,，\s]+/)
      item.tags = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12)
    }
    if (patch.enabled !== undefined) item.enabled = patch.enabled === true || patch.enabled === 'true'
    // 没有标签的表情不允许启用（Agent 无法判断语义）
    if (item.enabled && item.label.length === 0) item.enabled = false
    item.updatedAt = Math.floor(Date.now() / 1000)
    this.save()
    return item
  }

  /** Agent 可见表情：已打标 + 已启用 */
  listForAgent(query?: string): { id: string; label: string; tags: string[] }[] {
    const kw = (query ?? '').trim().toLowerCase()
    return this.list()
      .filter((s) => s.enabled && s.label.trim().length > 0)
      .filter((s) => !kw || (s.label + ' ' + s.tags.join(' ') + ' ' + s.desc).toLowerCase().includes(kw))
      .slice(0, 100)
      .map((s) => ({ id: s.id, label: s.label, tags: s.tags }))
  }

  findEnabled(id: string): StickerRecord | undefined {
    const item = this.items.get(id)
    return item && item.enabled && item.label.trim().length > 0 ? item : undefined
  }
}

function normalize(raw: Partial<StickerRecord> & { id: string }): StickerRecord {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: String(raw.id),
    md5: String(raw.md5 ?? ''),
    url: String(raw.url ?? ''),
    desc: String(raw.desc ?? ''),
    label: String(raw.label ?? '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    enabled: raw.enabled === true && String(raw.label ?? '').trim().length > 0,
    syncedAt: Number(raw.syncedAt ?? now),
    updatedAt: Number(raw.updatedAt ?? now),
  }
}
