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
import { TtsClient } from './tts'
import { VoiceStore } from './voices'
import { ProactiveJudge } from './proactive'
import { ReminderScheduler, ReminderStore } from './reminders'
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
  /** OneBot 事件入口：message 交给 onMessage，戳一戳等 notice 单独处理 */
  onEvent: (event: Record<string, unknown>) => Promise<void>
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
  const tts = new TtsClient(config, (m, ...x) => logger.warn(m, ...x))
  const voices = new VoiceStore(options.dataPath, (m, ...x) => logger.warn(m, ...x))
  const judge = new ProactiveJudge(config, (m, ...x) => logger.warn(m, ...x))
  sessions.attachVoice(tts, voices)
  sessions.attachJudge(judge)
  sessions.attachStickers(stickers)
  const reminders = new ReminderStore(options.dataPath, (m, ...x) => logger.warn(m, ...x))
  const reminderScheduler = new ReminderScheduler(
    reminders,
    async (reminder) => {
      if ((config.reminderMode || 'agent') === 'static') {
        const staticText = (reminder.atUserId ? '[CQ:at,qq=' + reminder.atUserId + '] ' : '') + '提醒：' + reminder.text
        await sessions.sendTextToScope(reminder.scope, staticText)
        return
      }
      try {
        await sessions.deliverReminder(reminder.scope, reminder.text)
      } catch (e) {
        logErr('提醒唤醒失败（下轮重试）:', e)
        throw e
      }
    },
    () => config.remindersEnabled,
    config.reminderCheckSec,
    (m, ...a) => logger.info(m, ...a)
  )
  reminderScheduler.start()
  const mcp = new QqMcpServer({
    config,
    db,
    sessions,
    tasks,
    mutes: sessions.mutes,
    stickers,
    reminders,
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
  // 网关重连/重复投递防护：同一 message_id 短时间内只处理一次
  const seenInbound = new Map<string, number>()
  const inboundKey = (event: OB11MessageEvent): string | null => {
    if (event.message_id === undefined || event.message_id === null) return null
    return `${event.self_id ?? ''}:${event.message_type}:${event.group_id ?? event.user_id ?? ''}:${event.message_id}`
  }
  const onMessage = async (event: OB11MessageEvent): Promise<void> => {
    if (event.post_type !== 'message') return
    if (event.user_id && event.self_id && event.user_id === event.self_id) return
    const key = inboundKey(event)
    if (key) {
      const now = Date.now()
      const last = seenInbound.get(key)
      if (last && now - last < 5 * 60_000) {
        log('忽略重复入站消息: ' + key)
        return
      }
      seenInbound.set(key, now)
      if (seenInbound.size > 5000) {
        for (const [k, t] of seenInbound) if (now - t > 5 * 60_000) seenInbound.delete(k)
      }
    }
    try {
      await sessions.enrichVoiceEvent(event)
    } catch (e) {
      logErr('语音转写失败', e)
    }
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

  // 戳一戳：像普通消息一样入库并交给模型决定（回话/回拍/不理）
  const handlePoke = async (notice: Record<string, unknown>): Promise<void> => {
    const selfId = Number(notice.self_id ?? 0)
    const poker = Number(notice.user_id ?? notice.sender_id ?? 0)
    const target = Number(notice.target_id ?? 0)
    if (!selfId || !poker || poker === selfId) return
    // 只回应「戳机器人自己」的；戳别人不处理
    if (target !== selfId) return
    const groupId = notice.group_id != null ? Number(notice.group_id) : null
    const scope = groupId ? 'group-' + groupId : 'private-' + poker
    const senderInfo = (notice.sender as Record<string, unknown> | undefined) ?? {}
    const nickname = String((senderInfo as { card?: unknown }).card || (senderInfo as { nickname?: unknown }).nickname || 'QQ' + poker)
    try {
      await sessions.handlePoke(scope, poker, nickname, selfId)
    } catch (e) {
      logErr('处理戳一戳失败', e)
    }
  }
  const onEvent = async (event: Record<string, unknown>): Promise<void> => {
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      await handlePoke(event)
      return
    }
    await onMessage(event as unknown as OB11MessageEvent)
  }

  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    active = false
    reminderScheduler.stop()
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
    onEvent,
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
