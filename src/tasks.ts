import fs from 'node:fs'
import path from 'node:path'

export interface TaskRec {
  task_id: string
  owner_qq: string
  group_id: string | null
  message_id: number | null
  scope: string
  task: string
  status: 'queued' | 'running' | 'done' | 'error'
  created_at: number
  finished_at: number | null
  summary: string
  result: string
  error: string
}

export class TaskRegistry {
  private tasks = new Map<string, TaskRec>()
  private file: string

  constructor(dataPath: string) {
    this.file = path.join(dataPath, 'tasks.json')
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as TaskRec[]
        for (const t of raw) {
          if (t.status === 'running') t.status = 'queued'
          this.tasks.set(t.task_id, t)
        }
      }
    } catch {
      // start fresh
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify([...this.tasks.values()], null, 2))
  }

  create(input: Pick<TaskRec, 'owner_qq' | 'group_id' | 'message_id' | 'scope' | 'task'>): TaskRec {
    const rec: TaskRec = {
      task_id: `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ...input,
      status: 'queued',
      created_at: Math.floor(Date.now() / 1000),
      finished_at: null,
      summary: '',
      result: '',
      error: '',
    }
    this.tasks.set(rec.task_id, rec)
    this.save()
    return rec
  }

  update(taskId: string, patch: Partial<TaskRec>): TaskRec | null {
    const rec = this.tasks.get(taskId)
    if (!rec) return null
    Object.assign(rec, patch)
    this.save()
    return rec
  }

  get(taskId: string): TaskRec | null {
    return this.tasks.get(taskId) ?? null
  }

  byOwner(ownerQq: string): TaskRec[] {
    return [...this.tasks.values()]
      .filter((t) => t.owner_qq === ownerQq)
      .sort((a, b) => b.created_at - a.created_at)
  }

  pending(): TaskRec[] {
    return [...this.tasks.values()].filter((t) => t.status === 'queued')
  }
}
