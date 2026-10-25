import { loadConfig, PluginConfig } from './config'
import { MsgDB } from './msgdb'
import { extractReplyTo, extractText, MsgSegment } from './format'
import { OB11MessageEvent, PluginContext } from './types'
import { OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRegistry } from './tasks'
import { TaskExecutor } from './executor'
import { QqMcpServer } from './mcp'
import { ControlPanel } from './panel'
import { DreamMemory } from './dream'

let config: PluginConfig
let db: MsgDB | null = null
let oc: OpencodeClient | null = null
let sessions: SessionController | null = null
let executor: TaskExecutor | null = null
let mcp: QqMcpServer | null = null
let panel: ControlPanel | null = null
let dream: DreamMemory | null = null
let reminderTimer: ReturnType<typeof setInterval> | null = null
let running = false

export async function plugin_init(ctx: PluginContext) {
  config = loadConfig(ctx.configPath)
  db = new MsgDB(ctx.dataPath + '/messages')
  await db.init()
  oc = new OpencodeClient(config.opencodeUrl, config.opencodePassword, (m, ...a) => ctx.logger.warn(m, ...a))
  sessions = new SessionController(config, db, oc, ctx.dataPath, (m, ...a) => ctx.logger.info(m, ...a))
  sessions.attach(ctx)

  const tasks = new TaskRegistry(ctx.dataPath)
  executor = new TaskExecutor({
    config,
    tasks,
    sessions,
    db,
    oc,
    dataPath: ctx.dataPath,
    sendToScope: (scope, text) => sessions!.sendTextToScope(scope, text),
    log: (m, ...a) => ctx.logger.info(m, ...a),
  })

  dream = new DreamMemory({
    config,
    db,
    sessions,
    oc,
    dataPath: ctx.dataPath,
    log: (m, ...a) => ctx.logger.info(m, ...a),
  })
  dream.start()

  mcp = new QqMcpServer({
    config,
    db,
    sessions,
    tasks,
    mutes: sessions.mutes,
    enqueueTask: (rec) => executor!.enqueue(rec),
    log: (m, ...a) => ctx.logger.warn(m, ...a),
  })
  await mcp.start()

  panel = new ControlPanel({
    config,
    configPath: ctx.configPath,
    dataPath: ctx.dataPath,
    mode: 'plugin',
    sessions,
    db,
    oc,
    tasks,
    dream,
    log: (m, ...a) => ctx.logger.info(m, ...a),
  })
  await panel.start()

  running = true
  executor.recoverQueued()

  reminderTimer = setInterval(() => {
    void executor?.checkExpiryReminders()
  }, 3600_000)
  setTimeout(() => void executor?.checkExpiryReminders(), 30_000)

  const healthy = await oc.health()
  ctx.logger.info(`[qqbot] 初始化完成, botName=${config.botName}, opencode=${config.opencodeUrl} (${healthy ? '在线' : '离线, 将在收到消息时重试'}), MCP :${config.mcpPort}`)

  oc.subscribeEvents((ev) => {
    const controller = sessions
    if (!controller) return
    void controller.handleOpencodeEvent(ev).catch((e) => ctx.logger.error('[qqbot] 事件处理失败', e))
  }, () => running)
}

function scopeOf(event: OB11MessageEvent): string {
  return event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
}

function storeMessage(event: OB11MessageEvent) {
  if (!db) return
  const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
  db.insert(scopeOf(event), {
    message_id: typeof event.message_id === 'number' ? event.message_id : Number(event.message_id) || null,
    user_id: event.user_id ?? null,
    nickname: event.sender?.nickname ?? '',
    card: event.sender?.card ?? '',
    time: event.time ?? Math.floor(Date.now() / 1000),
    reply_to: extractReplyTo(segments),
    text: typeof event.raw_message === 'string' && event.raw_message ? event.raw_message : extractText(segments),
    segments: JSON.stringify(event.message ?? []),
  })
}

export async function plugin_onmessage(ctx: PluginContext, event: OB11MessageEvent) {
  if (event.post_type !== 'message') return
  if (event.user_id && event.self_id && event.user_id === event.self_id) return
  try {
    storeMessage(event)
  } catch (e) {
    ctx.logger.error('[qqbot] 写消息库失败', e)
  }
  try {
    await sessions?.handleMessage(event)
  } catch (e) {
    ctx.logger.error('[qqbot] 处理消息失败', e)
  }
}

export async function plugin_cleanup(ctx: PluginContext) {
  running = false
  if (reminderTimer) {
    clearInterval(reminderTimer)
    reminderTimer = null
  }
  dream?.stop()
  dream = null
  panel?.stop()
  panel = null
  mcp?.stop()
  mcp = null
  executor = null
  db?.close()
  db = null
  sessions = null
  oc = null
  ctx.logger.info('[qqbot] 已清理')
}
