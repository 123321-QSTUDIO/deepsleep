export interface OpencodeEvent {
  type: string
  data: Record<string, unknown>
}

export interface SessionInfo {
  id: string
  title?: string
  location?: { directory: string }
  cost?: number
  tokens?: Record<string, unknown>
  outcome?: string
  time?: { created?: number; updated?: number; idle?: number }
}

export interface OcMessagePart {
  type?: string
  text?: string
  [key: string]: unknown
}

// OpenCode V2 会话消息：user/assistant/system/synthetic/idle 等类型
export interface OcModelCost {
  input: number
  output: number
  cache?: { read?: number; write?: number }
}

export interface OcModelInfo {
  id: string
  modelID?: string
  providerID: string
  name: string
  cost?: OcModelCost[]
  status?: 'alpha' | 'beta' | 'deprecated' | 'active'
  enabled?: boolean
  limit?: { context: number; output: number; input?: number }
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
}

// 请求体 PromptInput.FileAttachment 只接受 { uri }（响应体 Prompt.FileAttachment 才是 data/mime/source）
export interface OcPromptFile {
  uri: string
  name?: string
  description?: string
}

export interface OcProviderInfo {
  id: string
  name?: string
  activation?: string
}

export interface OcMessage {
  id: string
  type?: string
  text?: string
  content?: OcMessagePart[]
  payload?: { text?: string } & Record<string, unknown>
  time?: { created?: number; completed?: number; streamed?: number }
  model?: { id?: string; providerID?: string; variant?: string }
  cost?: number
  finish?: string
  description?: string
  metadata?: unknown
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

  getSessionInfo(sessionId: string): Promise<SessionInfo> {
    return this.requestData('GET', `/api/session/${sessionId}`)
  }

  listSessions(limit = 100): Promise<SessionInfo[]> {
    return this.requestData('GET', `/api/session?limit=${limit}`)
  }

  // V2 返回按时间倒序（最新在前）的消息列表
  getMessages(sessionId: string, limit = 50): Promise<OcMessage[]> {
    return this.requestData('GET', `/api/session/${sessionId}/message?limit=${limit}`)
  }

  // 回应 OpenCode 的权限请求（permission.asked 事件）：decision = once | always | reject
  async replyPermission(sessionId: string, requestId: string, decision: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.request('POST', `/api/session/${sessionId}/permission/${requestId}/reply`, message ? { decision, message } : { decision })
  }

  async promptAsync(sessionId: string, text: string, files?: OcPromptFile[]): Promise<void> {
    const body: Record<string, unknown> = { text }
    // OpenCode V2 Prompt 请求的 files 是 PromptInput.FileAttachment，只接受 { uri }；
    // 传 data URI（data:image/png;base64,...）或 file:// URI，不能传响应体的 data/mime/source 结构。
    if (files && files.length > 0) body.files = files
    await this.requestData('POST', `/api/session/${sessionId}/prompt`, body)
  }

  async inject(sessionId: string, text: string): Promise<void> {
    await this.requestData('POST', `/api/session/${sessionId}/synthetic`, {
      text,
      delivery: 'queue',
      resume: false,
    })
  }

  // 会话 fork（继承到最新消息的上下文），用于夜间"梦境整理"短命会话
  forkSession(sessionId: string): Promise<SessionInfo> {
    return this.requestData('POST', `/api/session/${sessionId}/fork`, {})
  }

  // 压缩会话：入队一条 compaction 消息，OpenCode 生成摘要后接管后续上下文
  async compactSession(sessionId: string): Promise<void> {
    await this.requestData('POST', `/api/session/${sessionId}/compact`, {})
  }

  async abort(sessionId: string): Promise<void> {
    await this.request('POST', `/api/session/${sessionId}/interrupt`)
  }

  // 可用模型目录（OpenCode 按 provider/model 注册表 + 当前目录配置解析；免费模型也在其中）
  listModels(directory?: string): Promise<OcModelInfo[]> {
    const query = directory ? '?location[directory]=' + encodeURIComponent(directory) : ''
    return this.requestData('GET', '/api/model' + query)
  }

  listProviders(directory?: string): Promise<OcProviderInfo[]> {
    const query = directory ? '?location[directory]=' + encodeURIComponent(directory) : ''
    return this.requestData('GET', '/api/provider' + query)
  }

  getDefaultModel(directory?: string): Promise<OcModelInfo | null> {
    const query = directory ? '?location[directory]=' + encodeURIComponent(directory) : ''
    return this.requestData('GET', '/api/model/default' + query)
  }

  // 切换已存在 Session 后续请求使用的模型（不重置上下文）
  async switchSessionModel(sessionId: string, model: { providerID: string; id: string }): Promise<void> {
    await this.request('POST', '/api/session/' + sessionId + '/model', { model })
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
