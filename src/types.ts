export interface AppLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface OutboundActions {
  call: (action: string, params: unknown) => Promise<unknown>
}

/** SessionController 的出站/日志接口：独立服务由 OneBot WS 注入，测试可注入 mock */
export interface SessionRuntime {
  logger: AppLogger
  actions: OutboundActions
}

export interface OB11Sender {
  user_id?: number
  nickname?: string
  card?: string
  role?: string
}

export interface OB11MessageEvent {
  post_type?: string
  message_type?: 'private' | 'group'
  sub_type?: string
  time?: number
  self_id?: number
  user_id?: number
  group_id?: number
  group_name?: string
  message_id?: number
  raw_message?: string
  message?: unknown
  sender?: OB11Sender
}
