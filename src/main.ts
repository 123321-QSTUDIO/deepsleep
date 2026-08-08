import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config'
import { MsgDB } from './msgdb'
import { extractReplyTo, extractText, MsgSegment } from './format'
import { OB11MessageEvent, PluginContext } from './types'
import { OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRegistry } from './tasks'
import { TaskExecutor } from './executor'
import { QqMcpServer } from './mcp'
import { OneBotClient } from './onebot'

const dataDir = process.env.QQBOT_DATA ?? path.join(process.cwd(), 'data')
fs.mkdirSync(dataDir, { recursive: true })

const log = (...args: unknown[]) => console.log(new Date().toISOString(), '[qqbot]', ...args)
const logErr = (...args: unknown[]) => console.error(new Date().toISOString(), '[qqbot]', ...args)

const config = loadConfig(path.join(dataDir, 'config.json'))
const db = new MsgDB(path.join(dataDir, 'messages'))
await db.init()

const oc = new OpencodeClient(config.opencodeUrl, config.opencodePassword, (m, ...a) => logErr(m, ...a))

let ob: OneBotClient
const sessions = new SessionController(config, db, oc, dataDir, log)
const tasks = new TaskRegistry(dataDir)

const ctxShim: PluginContext = {
  pluginName: 'qqbot-service',
  pluginPath: dataDir,
  configPath: path.join(dataDir, 'config.json'),
  dataPath: dataDir,
  adapterName: 'onebot-ws',
  logger: { info: log, warn: log, error: logErr },
  actions: { call: (action, params) => ob.call(action, params) },
  pluginManager: { config: {} },
}
sessions.attach(ctxShim)

const executor = new TaskExecutor({
  config,
  tasks,
  sessions,
  db,
  oc,
  dataPath: dataDir,
  sendToScope: (scope, text) => sessions.sendTextToScope(scope, text),
  log,
})

const mcp = new QqMcpServer({
  config,
  db,
  sessions,
  tasks,
  enqueueTask: (rec) => executor.enqueue(rec),
  log: (m, ...a) => logErr(m, ...a),
})
await mcp.start()

let running = true
executor.recoverQueued()
const reminderTimer = setInterval(() => {
  void executor.checkExpiryReminders()
}, 3600_000)
setTimeout(() => void executor.checkExpiryReminders(), 30_000)

function onOneBotEvent(ev: Record<string, unknown>) {
  if (ev.post_type !== 'message') return
  const event = ev as unknown as OB11MessageEvent
  if (event.user_id && event.self_id && event.user_id === event.self_id) return
  try {
    storeMessage(event)
  } catch (e) {
    logErr('写消息库失败', e)
  }
  void sessions.handleMessage(event).catch((e) => logErr('处理消息失败', e))
}

function storeMessage(event: OB11MessageEvent) {
  const segments = (Array.isArray(event.message) ? event.message : []) as MsgSegment[]
  const scope = event.message_type === 'group' ? `group-${event.group_id}` : `private-${event.user_id}`
  db.insert(scope, {
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

ob = new OneBotClient(config.onebotUrl, config.onebotToken, onOneBotEvent, log)
ob.start(() => running)

oc.subscribeEvents((ev) => {
  void (async () => {
    try {
      if (ev.type === 'message.part.updated') {
        const part = ev.properties.part as { type?: string; sessionID?: string; text?: string } | undefined
        if (part?.type === 'text' && part.sessionID && typeof part.text === 'string') {
          sessions.onAssistantText(part.sessionID, part.text)
        }
        return
      }
      if (ev.type === 'session.idle' || (ev.type === 'session.status' && (ev.properties.status as { type?: string })?.type === 'idle')) {
        const sessionId = (ev.properties.sessionID ?? (ev.properties.info as { id?: string })?.id) as string | undefined
        if (sessionId) await sessions.onSessionIdle(sessionId)
      }
    } catch (e) {
      logErr('opencode 事件处理失败', e)
    }
  })()
}, () => running)

const healthy = await oc.health()
log(`启动完成 botName=${config.botName} onebot=${config.onebotUrl} opencode=${config.opencodeUrl} (${healthy ? '在线' : '离线'}) MCP ${config.mcpHost}:${config.mcpPort} 数据目录=${dataDir}`)

async function shutdown() {
  if (!running) return
  running = false
  clearInterval(reminderTimer)
  mcp.stop()
  ob.close()
  db.close()
  log('已退出')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
