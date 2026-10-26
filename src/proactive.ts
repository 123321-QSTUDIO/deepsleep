import { PluginConfig } from './config'

export interface JudgeResult {
  participate: boolean
  source: 'local' | 'heuristic'
  reason: string
}

const LOCAL_PROMPT = [
  '你是群聊参与判断器。根据最近的群聊，判断机器人现在主动插话是否自然、有价值。',
  '只输出一个词：REPLY（值得接话）或 SILENT（保持沉默）。',
  '参考标准：有人提问/需要帮忙/聊到机器人/明显适合接梗→REPLY；普通闲聊、别人私事、严肃或悲伤话题、信息不足→SILENT。',
  '示例：',
  '群聊：A: 这个报错有人遇到过吗 map is not a function',
  'REPLY',
  '群聊：A: 今天好累 B: 早点睡',
  'SILENT',
].join('\n')

// 主动参与判官：优先用本地小模型（OpenAI 兼容接口，如 Ollama/llama.cpp），
// 未配置或调用失败时退回零依赖启发式，保证低配机器也能用。
export class ProactiveJudge {
  constructor(private config: PluginConfig, private log: (msg: string, ...args: unknown[]) => void) {}

  async decide(recentLines: string[]): Promise<JudgeResult> {
    const mode = this.config.proactiveJudgeMode || 'auto'
    if (mode === 'heuristic') return this.heuristicResult(recentLines, '强制启发式')
    const hasLocal = !!(this.config.proactiveJudgeBaseUrl && this.config.proactiveJudgeModel)
    if (mode !== 'local' && !hasLocal) return this.heuristicResult(recentLines, '未配置本地判官')
    try {
      const local = await this.localJudge(recentLines)
      if (local !== null) return { participate: local, source: 'local', reason: local ? 'REPLY' : 'SILENT' }
      return this.heuristicResult(recentLines, '本地判官输出无法解析')
    } catch (e) {
      this.log('本地判官不可用，退回启发式:', e)
      return this.heuristicResult(recentLines, '本地判官不可用')
    }
  }

  private heuristicResult(recentLines: string[], reason: string): JudgeResult {
    return { participate: this.heuristic(recentLines), source: 'heuristic', reason }
  }

  private async localJudge(recentLines: string[]): Promise<boolean | null> {
    const base = this.config.proactiveJudgeBaseUrl.replace(/\/+$/, '')
    const timeoutMs = Math.max(500, (this.config.proactiveJudgeTimeoutSec || 3) * 1000)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const transcript = recentLines.join('\n').slice(-1600)
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.config.proactiveJudgeApiKey) headers.authorization = 'Bearer ' + this.config.proactiveJudgeApiKey
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.proactiveJudgeModel,
          messages: [
            { role: 'system', content: LOCAL_PROMPT },
            { role: 'user', content: '群聊记录：\n' + transcript },
          ],
          temperature: 0,
          max_tokens: 8,
          stream: false,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('judge HTTP ' + res.status)
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const raw = String(json.choices?.[0]?.message?.content ?? '')
      const cleaned = raw.replace(/<\/?think>/gi, '').trim()
      if (/SILENT|沉默/i.test(cleaned)) return false
      if (/REPLY|接话|回复/i.test(cleaned)) return true
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // 零依赖启发式：问句/求助/提到机器人加权，私事严肃话题降权
  private heuristic(recentLines: string[]): boolean {
    const text = recentLines.join('\n')
    if (!text.trim()) return false
    let score = 0
    if (/[?？]/.test(text)) score += 1.5
    if (/机器人|deep|\bbot\b|小助手|\bAI\b/i.test(text)) score += 2
    if (/有人吗|在吗|谁在|帮忙|求助|怎么|为什么|如何/.test(text)) score += 1
    if (/哈哈|草|笑死|绷不住|泪目|无语/.test(text)) score += 0.5
    const lastLine = recentLines[recentLines.length - 1] ?? ''
    if (lastLine.length > 24) score += 0.5
    if ((text.match(/[?？]/g) ?? []).length >= 2) score += 0.5
    if (/生病|医院|去世|分手|吵架|隐私|密码|身份证|手机号/.test(text)) score -= 2
    return score >= 2
  }
}