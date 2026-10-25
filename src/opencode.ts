export interface OpencodeEvent {
  type: string
  data: Record<string, unknown>
}

interface SessionInfo {
  id: string
  title?: string
  location?: { directory: string }
}

interface DataResponse<T> {
  data: T
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

  private async requestData<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await this.request<DataResponse<T>>(method, urlPath, body)
    return res.data
  }

  createSession(directory: string, title: string): Promise<SessionInfo> {
    return this.requestData('POST', '/api/session', { title, location: { directory } })
  }

  findSessionByDirectory(directory: string): Promise<SessionInfo[]> {
    return this.requestData('GET', `/api/session?directory=${encodeURIComponent(directory)}&limit=1&order=desc&parentID=null`)
  }

  async promptAsync(sessionId: string, text: string): Promise<void> {
    await this.requestData('POST', `/api/session/${sessionId}/prompt`, { text })
  }

  async inject(sessionId: string, text: string): Promise<void> {
    await this.requestData('POST', `/api/session/${sessionId}/synthetic`, {
      text,
      delivery: 'queue',
      resume: false,
    })
  }

  async abort(sessionId: string): Promise<void> {
    await this.request('POST', `/api/session/${sessionId}/interrupt`)
  }

  getStatus(): Promise<Record<string, { type?: string }>> {
    return this.requestData('GET', '/api/session/active')
  }

  async getLastAssistantText(sessionId: string): Promise<string> {
    try {
      const msgs = await this.requestData<
        Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>
      >('GET', `/api/session/${sessionId}/message?type=assistant&order=desc&limit=1`)
      const last = msgs[0]
      if (last?.type !== 'assistant' || !last.content) return ''
      return last.content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('\n')
    } catch {
      return ''
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/session/${sessionId}`)
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl + '/api/info', { headers: this.headers() })
      return res.ok
    } catch {
      return false
    }
  }

  subscribeEvents(onEvent: (ev: OpencodeEvent) => void, shouldRun: () => boolean) {
    const loop = async () => {
      while (shouldRun()) {
        try {
          const res = await fetch(this.baseUrl + '/api/event', {
            headers: { ...this.headers(), accept: 'text/event-stream' },
          })
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
