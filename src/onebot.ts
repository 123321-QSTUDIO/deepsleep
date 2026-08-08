import WebSocket from 'ws'

interface PendingCall {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class OneBotClient {
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<string, PendingCall>()
  private connected = false

  constructor(
    private url: string,
    private token: string,
    private onEvent: (ev: Record<string, unknown>) => void,
    private log: (msg: string, ...args: unknown[]) => void
  ) {}

  start(shouldRun: () => boolean) {
    const connect = () => {
      if (!shouldRun()) return
      const headers: Record<string, string> = {}
      if (this.token) headers['authorization'] = `Bearer ${this.token}`
      const ws = new WebSocket(this.url, { headers })
      this.ws = ws

      ws.on('open', () => {
        this.connected = true
        this.log('OneBot WS 已连接')
      })
      ws.on('message', (data) => {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data.toString())
        } catch {
          return
        }
        const echo = parsed.echo as string | undefined
        if (echo && this.pending.has(echo)) {
          const p = this.pending.get(echo)!
          this.pending.delete(echo)
          clearTimeout(p.timer)
          if (parsed.retcode === 0) p.resolve(parsed.data)
          else p.reject(new Error(`retcode ${parsed.retcode}: ${parsed.message ?? ''}`))
          return
        }
        if (parsed.post_type) {
          try {
            this.onEvent(parsed)
          } catch (e) {
            this.log('事件处理失败:', e)
          }
        }
      })
      ws.on('close', () => {
        this.connected = false
        this.ws = null
        this.failAll(new Error('ws closed'))
        if (shouldRun()) {
          this.log('OneBot WS 断开, 3s 后重连')
          setTimeout(connect, 3000)
        }
      })
      ws.on('error', (e) => {
        this.log('OneBot WS 错误:', e.message)
        ws.close()
      })
    }
    connect()
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  isConnected(): boolean {
    return this.connected
  }

  call(action: string, params: unknown): Promise<never> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error('OneBot WS 未连接'))
        return
      }
      const echo = `q${Date.now().toString(36)}${(this.seq++).toString(36)}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`action ${action} 超时`))
      }, 15000)
      this.pending.set(echo, { resolve: resolve as (d: unknown) => void, reject, timer })
      this.ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  close() {
    this.failAll(new Error('closed'))
    this.ws?.close()
    this.ws = null
  }
}
