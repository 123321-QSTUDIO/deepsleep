import { loadConfig, PluginConfig } from './config'
import { MsgDB } from './msgdb'
import { extractReplyTo, extractText, MsgSegment } from './format'
import { OB11MessageEvent, PluginContext } from './types'
import { OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRegistry } from './tasks'
import { TaskExecutor } from './executor'
import { QqMcpServer } from './mcp'

let config: PluginConfig
let db: MsgDB | null = null
let oc: OpencodeClient | null = null
let sessions: SessionController | null = null
let executor: TaskExecutor | null = null
let mcp: QqMcpServer | null = null
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

  mcp = new QqMcpServer({
    config,
    db,
    sessions,
    tasks,
    enqueueTask: (rec) => executor!.enqueue(rec),
    log: (m, ...a) => ctx.logger.warn(m, ...a),
  })
  await mcp.start()

  running = true
  executor.recoverQueued()

  const healthy = await oc.health()
  ctx.logger.info(`[qqbot] 初始化完成, botName=${config.botName}, opencode=${config.opencodeUrl} (${healthy ? '在线' : '离线, 将在收到消息时重试'}), MCP :${config.mcpPort}`)

  oc.subscribeEvents((ev) => {
    void handleEvent(ctx, ev)
  }, () => running)
}

async function handleEvent(ctx: PluginContext, ev: { type: string; properties: Record<string, unknown> }) {
  try {
    if (ev.type === 'message.part.updated') {
      const part = ev.properties.part as { type?: string; sessionID?: string; text?: string } | undefined
      if (part?.type === 'text' && part.sessionID && typeof part.text === 'string') {
        sessions?.onAssistantText(part.sessionID, part.text)
      }
      return
    }
    if (ev.type === 'session.idle' || (ev.type === 'session.status' && (ev.properties.status as { type?: string })?.type === 'idle')) {
      const sessionId = (ev.properties.sessionID ?? (ev.properties.info as { id?: string })?.id) as string | undefined
      if (sessionId) await sessions?.onSessionIdle(sessionId)
      return
    }
    if (ev.type === 'session.error') {
      ctx.logger.error('[qqbot] opencode 会话错误', JSON.stringify(ev.properties))
    }
  } catch (e) {
    ctx.logger.error('[qqbot] 事件处理失败', e)
  }
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
  mcp?.stop()
  mcp = null
  executor = null
  db?.close()
  db = null
  sessions = null
  oc = null
  ctx.logger.info('[qqbot] 已清理')
}
