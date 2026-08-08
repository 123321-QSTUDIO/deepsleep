export interface OpencodeEvent {
  type: string
  properties: Record<string, unknown>
}

interface SessionInfo {
  id: string
  directory?: string
  title?: string
}

export class OpencodeClient {
  constructor(
    private baseUrl: string,
    private password: string,
    private log: (msg: string, ...args: unknown[]) => void
  ) {}

  private headers(): Record<string, string> {
    if (!this.password) return { 'content-type': 'application/json' }
    return {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64'),
    }
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + urlPath, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`opencode ${method} ${urlPath} -> ${res.status} ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  createSession(directory: string, title: string): Promise<SessionInfo> {
    return this.request('POST', `/session?directory=${encodeURIComponent(directory)}`, { title })
  }

  findSessionByDirectory(directory: string): Promise<SessionInfo[]> {
    return this.request('GET', `/session?directory=${encodeURIComponent(directory)}`)
  }

  promptAsync(sessionId: string, text: string): Promise<void> {
    return this.request('POST', `/session/${sessionId}/prompt_async`, {
      parts: [{ type: 'text', text }],
    })
  }

  inject(sessionId: string, text: string): Promise<void> {
    return this.request('POST', `/session/${sessionId}/message`, {
      noReply: true,
      parts: [{ type: 'text', text }],
    })
  }

  abort(sessionId: string): Promise<void> {
    return this.request('POST', `/session/${sessionId}/abort`)
  }

  getStatus(): Promise<Record<string, unknown>> {
    return this.request('GET', '/session/status')
  }

  async getLastAssistantText(sessionId: string): Promise<string> {
    try {
      const msgs = await this.request<
        Array<{ info?: { role?: string }; role?: string; parts?: Array<{ type?: string; text?: string }> }>
      >('GET', `/session/${sessionId}/message?limit=10`)
      const last = [...msgs].reverse().find((m) => (m.info?.role ?? m.role) === 'assistant')
      if (!last?.parts) return ''
      return last.parts
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('\n')
    } catch {
      return ''
    }
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request('DELETE', `/session/${sessionId}`)
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/session/status', { headers: this.headers() })
      return res.ok
    } catch {
      return false
    }
  }

  subscribeEvents(onEvent: (ev: OpencodeEvent) => void, shouldRun: () => boolean) {
    const loop = async () => {
      while (shouldRun()) {
        try {
          const res = await fetch(this.baseUrl + '/event', { headers: this.headers() })
          if (!res.ok || !res.body) throw new Error(`sse ${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            let idx: number
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx)
              buf = buf.slice(idx + 2)
              const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
              if (!dataLine) continue
              try {
                onEvent(JSON.parse(dataLine.slice(5).trim()) as OpencodeEvent)
              } catch {
                // malformed frame, skip
              }
            }
          }
        } catch (e) {
          this.log('SSE 断开, 3s 后重连:', e)
        }
        if (shouldRun()) await new Promise((r) => setTimeout(r, 3000))
      }
    }
    void loop()
  }
}
