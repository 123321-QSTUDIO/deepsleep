import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, PluginConfig } from './config'
import { extractReplyTo, extractText, MsgSegment } from './format'
import { MsgDB } from './msgdb'
import { OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRegistry } from './tasks'
import { TaskExecutor } from './executor'
import { QqMcpServer } from './mcp'
import { ControlPanel } from './panel'
import { DreamMemory } from './dream'
import { StickerStore } from './stickers'
import { AppLogger, OB11MessageEvent, OutboundActions } from './types'

// 独立服务形态的组装层：main.ts（CLI 入口）与冒烟测试共用
export interface AppOptions {
  /** config 目录或 config.json 路径（loadConfig 会自己解析） */
  configPath: string
  /** 数据目录：messages/、workspaces/、sessions.json、tasks.json、dream.json 都在这里 */
  dataPath: string
  logger?: AppLogger
  /** 出站动作（send_msg 等）：独立服务注入 OneBot WS，测试注入 mock */
  actions?: OutboundActions
  onebotConnected?: () => boolean
}

export interface App {
  config: PluginConfig
  db: MsgDB
  oc: OpencodeClient
  sessions: SessionController
  tasks: TaskRegistry
  executor: TaskExecutor
  dream: DreamMemory
  stickers: StickerStore
  mcp: QqMcpServer
  panel: ControlPanel
  dataPath: string
  /** 处理一条 OneBot 消息（入库 + 触发判定 + 交给 OpenCode） */
  onMessage: (event: OB11MessageEvent) => Promise<void>
  /** 停止所有后台组件并落盘 */
  stop: () => Promise<void>
}

export async function createApp(options: AppOptions): Promise<App> {
  const logger: AppLogger = options.logger ?? {
    info: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  }
  const log = (msg: string, ...args: unknown[]) => logger.info(msg, ...args)
  const logErr = (msg: string, ...args: unknown[]) => logger.error(msg, ...args)

  fs.mkdirSync(options.dataPath, { recursive: true })
  const config = loadConfig(options.configPath)
  const db = new MsgDB(path.join(options.dataPath, 'messages'))
  await db.init()
  const oc = new OpencodeClient(config.opencodeUrl, config.opencodePassword, (m, ...a) => logger.warn(m, ...a))
  const sessions = new SessionController(config, db, oc, options.dataPath, (m, ...a) => logger.info(m, ...a))
  sessions.attach({
    logger,
    actions: options.actions ?? {
      call: async () => {
        throw new Error('未注入出站 actions：独立服务应在 main.ts 绑定 OneBot WS')
      },
    },
  })
  const tasks = new TaskRegistry(options.dataPath)
  const executor = new TaskExecutor({
    config,
    tasks,
    sessions,
    db,
    oc,
    dataPath: options.dataPath,
    sendToScope: (scope, text) => sessions.sendTextToScope(scope, text),
    log: (m, ...a) => logger.info(m, ...a),
  })
  const dream = new DreamMemory({
    config,
    db,
    sessions,
    oc,
    dataPath: options.dataPath,
    log: (m, ...a) => logger.info(m, ...a),
  })
  dream.start()
  const stickers = new StickerStore(options.dataPath, (m, ...x) => logger.warn(m, ...x))
  const mcp = new QqMcpServer({
    config,
    db,
    sessions,
    tasks,
    mutes: sessions.mutes,
    stickers,
    enqueueTask: (rec) => executor.enqueue(rec),
    log: (m, ...a) => logger.warn(m, ...a),
  })
  await mcp.start()
  const panel = new ControlPanel({
    config,
    configPath: options.configPath,
    dataPath: options.dataPath,
    mode: 'service',
    sessions,
    db,
    oc,
    tasks,
    dream,
    stickers,
    log: (m, ...a) => logger.info(m, ...a),
    onebotConnected: options.onebotConnected,
  })
  await panel.start()

  let active = true
  oc.subscribeEvents((ev) => {
    void sessions.handleOpencodeEvent(ev).catch((e) => logger.error('opencode 事件处理失败', e))
  }, () => active)

  executor.recoverQueued()
  const reminderTimer = setInterval(() => {
    void executor.checkExpiryReminders()
  }, 3600_000)
  setTimeout(() => void executor.checkExpiryReminders(), 30_000)

  let stopped = false
  const onMessage = async (event: OB11MessageEvent): Promise<void> => {
    if (event.post_type !== 'message') return
    if (event.user_id && event.self_id && event.user_id === event.self_id) return
    try {
      storeMessage(db, event)
    } catch (e) {
      logErr('写消息库失败', e)
    }
    try {
      await sessions.handleMessage(event)
    } catch (e) {
      logErr('处理消息失败', e)
    }
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    active = false
    clearInterval(reminderTimer)
    dream.stop()
    panel.stop()
    mcp.stop()
    db.close()
    log('已停止')
  }

  return {
    config,
    db,
    oc,
    sessions,
    tasks,
    executor,
    dream,
    stickers,
    mcp,
    panel,
    dataPath: options.dataPath,
    onMessage,
    stop,
  }
}

function storeMessage(db: MsgDB, event: OB11MessageEvent): void {
  const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
  const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
  // 入站收藏/商城表情（SnowLuma 会转成带 emoji_id 的 image 段）：给上下文补一句可读描述，
  // 否则 raw_message 里只是 [CQ:image,...]，Agent 无法接梗
  const stickerNotes = segments
    .filter((seg) => seg.type === 'image' && (seg.data?.emoji_id || seg.data?.summary))
    .map((seg) => `[表情包${seg.data?.summary ? ':' + String(seg.data.summary) : ''}]`)
  let text = typeof event.raw_message === 'string' && event.raw_message ? event.raw_message : extractText(segments)
  if (stickerNotes.length > 0) text += ' ' + stickerNotes.join('')
  db.insert(scope, {
    message_id: typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || null,
    user_id: event.user_id ?? null,
    nickname: event.sender?.nickname ?? '',
    card: event.sender?.card ?? '',
    time: event.time ?? Math.floor(Date.now() / 1000),
    reply_to: extractReplyTo(segments),
    text,
    segments: JSON.stringify(event.message ?? []),
  })
}
