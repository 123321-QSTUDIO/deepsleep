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

  async synthesize(text: string, voiceDescription: string, opts?: { sing?: boolean }): Promise<TtsResult> {
    if (!this.enabled()) throw new Error('TTS 未启用或未配置 API Key（面板「语音」组）')
    const base = this.config.ttsBaseUrl.replace(/\/+$/, '')
    const format = this.config.ttsFormat || 'mp3'
    const configuredModel = this.config.ttsModel || 'mimo-v2.5-tts-voicedesign'
    // 只有预置音色模型（mimo-v2.5-tts）支持唱歌；voicedesign/voiceclone 不支持，
    // 所以 sing=true 时强制切到预置模型，voicedesign 的音色描述这时只能当风格提示。
    const model = opts?.sing ? 'mimo-v2.5-tts' : configuredModel
    const voicedesign = model.includes('voicedesign')
    const preset = model.includes('mimo-v2.5-tts') && !voicedesign && !model.includes('voiceclone')
    const presetVoice = this.config.ttsPresetVoice || '冰糖'
    let target = text
    if (opts?.sing) {
      target = text.replace(/^\s*(?:\(|（|\[)\s*(?:唱歌|sing|singing)\s*(?:\)|）|\])\s*/i, '').trim()
      if (!target) throw new Error('唱歌文本为空（歌词不能为空）')
      target = '(唱歌)' + target
    }
    const messages: { role: string; content: string }[] = []
    if (voicedesign) {
      if (voiceDescription) messages.push({ role: 'user', content: voiceDescription })
      messages.push({ role: 'assistant', content: target })
    } else if (preset) {
      // 预置音色模型：user 是可选的风格描述，assistant 是要唱/念的文本；音色由 audio.voice 指定
      if (voiceDescription) messages.push({ role: 'user', content: voiceDescription })
      messages.push({ role: 'assistant', content: target })
    } else {
      messages.push({ role: 'assistant', content: target })
    }
    const audio: Record<string, unknown> = { format }
    if (preset) audio.voice = presetVoice
    const body: Record<string, unknown> = { model, messages, audio }
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
