import { PluginConfig } from './config'

export interface TtsResult {
  buffer: Buffer
  format: string
}

// MiMo TTS（OpenAI 兼容 /v1/chat/completions）：user 消息描述音色，assistant 消息是要合成的文本
export class TtsClient {
  constructor(private config: PluginConfig, private log: (msg: string, ...args: unknown[]) => void) {}

  enabled(): boolean {
    return !!this.config.ttsEnabled && !!this.config.ttsApiKey && !!this.config.ttsBaseUrl
  }

  async synthesize(text: string, voiceDescription: string): Promise<TtsResult> {
    if (!this.enabled()) throw new Error('TTS 未启用或未配置 API Key（面板「语音」组）')
    const base = this.config.ttsBaseUrl.replace(/\/+$/, '')
    const model = this.config.ttsModel || 'mimo-v2.5-tts-voicedesign'
    const format = this.config.ttsFormat || 'mp3'
    const voicedesign = model.includes('voicedesign')
    const messages = voicedesign
      ? [
          { role: 'user', content: voiceDescription },
          { role: 'assistant', content: text },
        ]
      : [{ role: 'assistant', content: text }]
    const body: Record<string, unknown> = { model, messages, audio: { format } }
    const controller = new AbortController()
    const timeoutMs = Math.max(10, this.config.ttsTimeoutSec || 90) * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.config.ttsApiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('TTS HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300))
      const json = (await res.json()) as { choices?: { message?: { audio?: { data?: string } } }[] }
      const data = json.choices?.[0]?.message?.audio?.data
      if (typeof data !== 'string' || !data) throw new Error('TTS 未返回音频数据')
      return { buffer: Buffer.from(data, 'base64'), format }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw new Error('TTS 超时（' + Math.round(timeoutMs / 1000) + 's）')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}