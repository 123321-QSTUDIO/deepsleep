import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import initSqlJs, { Database, SqlJsStatic } from 'sql.js'

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS message (
  msg_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  user_id INTEGER,
  nickname TEXT,
  card TEXT,
  role TEXT,
  time INTEGER,
  reply_to INTEGER,
  text TEXT,
  segments TEXT
);
CREATE INDEX IF NOT EXISTS idx_time ON message(time);`

interface Cached {
  db: Database
  file: string
  timer: ReturnType<typeof setTimeout> | null
}

export function dayKey(timeSec: number): string {
  const d = new Date(timeSec * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class MsgDB {
  private sql: SqlJsStatic | null = null
  private cache = new Map<string, Cached>()

  constructor(private baseDir: string) {}

  async init() {
    const wasmPath = fileURLToPath(new URL('./sql-wasm.wasm', import.meta.url))
    const wasmBuffer = fs.readFileSync(wasmPath)
    this.sql = await initSqlJs({
      wasmBinary: wasmBuffer.buffer.slice(wasmBuffer.byteOffset, wasmBuffer.byteOffset + wasmBuffer.byteLength),
    })
  }

  private open(scope: string, day: string): Cached {
    const dir = path.join(this.baseDir, scope)
    const file = path.join(dir, `msg_${day}.db`)
    const hit = this.cache.get(file)
    if (hit) return hit
    fs.mkdirSync(dir, { recursive: true })
    const db = fs.existsSync(file)
      ? new this.sql!.Database(fs.readFileSync(file))
      : new this.sql!.Database()
    db.run(TABLE_SQL)
    // 旧库没有 role 列：补列（群主/管理员/普通成员）
    try { db.run('ALTER TABLE message ADD COLUMN role TEXT') } catch { /* already exists */ }
    const entry: Cached = { db, file, timer: null }
    this.cache.set(file, entry)
    return entry
  }

  private scheduleFlush(entry: Cached) {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      try {
        fs.writeFileSync(entry.file, Buffer.from(entry.db.export()))
      } catch {
        // flush failure is non-fatal; next flush will retry
      }
    }, 1000)
  }

  insert(scope: string, row: {
    message_id: number | null
    user_id: number | null
    nickname: string
    card: string
    role?: string
    time: number
    reply_to: number | null
    text: string
    segments: string
  }) {
    const day = dayKey(row.time || Math.floor(Date.now() / 1000))
    const entry = this.open(scope, day)
    const stmt = entry.db.prepare(
      'INSERT INTO message (message_id, user_id, nickname, card, role, time, reply_to, text, segments) VALUES (?,?,?,?,?,?,?,?,?)'
    )
    stmt.run([
      row.message_id,
      row.user_id,
      row.nickname,
      row.card,
      row.role ?? '',
      row.time,
      row.reply_to,
      row.text,
      row.segments,
    ])
    stmt.free()
    this.scheduleFlush(entry)
  }

  query(scope: string, day: string, sqlText: string, params: (string | number | null)[] = []): Record<string, unknown>[] {
    const entry = this.open(scope, day)
    const stmt = entry.db.prepare(sqlText)
    stmt.bind(params)
    const rows: Record<string, unknown>[] = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    stmt.free()
    return rows
  }

  listDays(scope: string): string[] {
    const dir = path.join(this.baseDir, scope)
    const days = new Set<string>()
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const m = /^msg_(\d{4}-\d{2}-\d{2})\.db$/.exec(f)
        if (m) days.add(m[1])
      }
    }
    const prefix = dir + path.sep + 'msg_'
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) days.add(key.slice(prefix.length, prefix.length + 10))
    }
    return [...days].sort()
  }

  flushAll() {
    for (const entry of this.cache.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      try {
        fs.writeFileSync(entry.file, Buffer.from(entry.db.export()))
      } catch {
        // ignore
      }
    }
  }

  close() {
    this.flushAll()
    for (const entry of this.cache.values()) entry.db.close()
    this.cache.clear()
  }
}
