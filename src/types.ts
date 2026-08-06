export interface PluginLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug?: (...args: unknown[]) => void
}

export interface ActionMap {
  call: (action: string, params: unknown, adapter?: string, config?: unknown) => Promise<never>
}

export interface PluginManagerLike {
  config: unknown
}

export interface PluginContext {
  pluginName: string
  pluginPath: string
  configPath: string
  dataPath: string
  adapterName: string
  logger: PluginLogger
  actions: ActionMap
  pluginManager: PluginManagerLike
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
