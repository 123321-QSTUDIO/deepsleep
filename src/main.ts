import fs from 'node:fs'
import path from 'node:path'
import { createApp } from './app'
import { OneBotClient } from './onebot'
import { OB11MessageEvent } from './types'

// 独立服务入口：OneBot v11 WS 连 NapCat（仅作为 QQ 消息网关），全部业务在 app.ts
const dataDir = process.env.QQBOT_DATA ?? path.join(process.cwd(), 'data')
fs.mkdirSync(dataDir, { recursive: true })

const log = (...args: unknown[]) => console.log(new Date().toISOString(), '[deepsleep]', ...args)
const logErr = (...args: unknown[]) => console.error(new Date().toISOString(), '[deepsleep]', ...args)

let ob: OneBotClient | null = null
let running = true

const app = await createApp({
  configPath: path.join(dataDir, 'config.json'),
  dataPath: dataDir,
  logger: { info: log, warn: log, error: logErr },
  actions: { call: (action, params) => ob!.call(action, params) },
  onebotConnected: () => ob?.isConnected() ?? false,
})

ob = new OneBotClient(app.config.onebotUrl, app.config.onebotToken, (ev) => {
  void app.onMessage(ev as unknown as OB11MessageEvent)
}, log)
ob.start(() => running)


const healthy = await app.oc.health()
log(`启动完成 botName=${app.config.botName} onebot=${app.config.onebotUrl} opencode=${app.config.opencodeUrl} (${healthy ? '在线' : '离线'}) MCP ${app.config.mcpHost}:${app.config.mcpPort} 数据目录=${dataDir}`)

async function shutdown() {
  if (!running) return
  running = false
  ob?.close()
  await app.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
