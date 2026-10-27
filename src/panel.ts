import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { defaultConfig, PluginConfig, resolveConfigFile, saveConfig } from './config'
import { dayKey, MsgDB } from './msgdb'
import { OcMessage, OpencodeClient } from './opencode'
import { SessionController } from './sessions'
import { TaskRegistry } from './tasks'
import { DreamMemory } from './dream'
import { StickerStore } from './stickers'
import panelHtml from './panel.html'

const PANEL_VERSION = '0.1.0'
const BODY_LIMIT = 1024 * 1024
const MAX_TEXT = 5000

export interface PanelDeps {
  config: PluginConfig
  configPath: string
  dataPath: string
  mode: 'plugin' | 'service'
  sessions: SessionController
  db: MsgDB
  oc: OpencodeClient
  tasks: TaskRegistry
  dream: DreamMemory
  stickers: StickerStore
  log: (msg: string, ...args: unknown[]) => void
  onebotConnected?: () => boolean
}

interface FieldDef {
  key: keyof PluginConfig
  label: string
  group: string
  type: 'string' | 'number' | 'boolean' | 'json' | 'password'
  help?: string
  min?: number
  max?: number
}

const FIELDS: FieldDef[] = [
  { key: 'botName', label: 'botName（机器人自称）', group: '基础', type: 'string', help: '写入群/私聊工作区的人设，下一条消息触发时重建 AGENTS.md' },
  { key: 'hostModel', label: 'hostModel（主模型）', group: '模型', type: 'string' },
  { key: 'visionModel', label: 'visionModel（识图子代理模型）', group: '模型', type: 'string' },

  { key: 'opencodeUrl', label: 'opencodeUrl', group: '连接', type: 'string', help: 'host opencode V2 地址' },
  { key: 'opencodePassword', label: 'opencodePassword', group: '连接', type: 'password', help: '必须与 serve 的 OPENCODE_PASSWORD 一致' },
  { key: 'onebotUrl', label: 'onebotUrl（OneBot WS 地址）', group: '连接', type: 'string', help: 'SnowLuma/NapCat 等 OneBot v11 网关的 WebSocket 地址，默认 ws://127.0.0.1:3001' },
  { key: 'onebotToken', label: 'onebotToken（独立服务模式）', group: '连接', type: 'password' },

  { key: 'contextMessageCount', label: 'contextMessageCount（上下文条数）', group: '消息与回复', type: 'number', min: 1 },
  { key: 'groupContextBatchEnabled', label: 'groupContextBatchEnabled（群聊上下文批量投喂）', group: '消息与回复', type: 'boolean', help: '每 N 秒把这段时间的新群聊记录作为一次 user prompt 交给模型，由模型决定要不要回复；@ 仍然立即触发。受顶部「自动回复」总开关控制' },
  { key: 'groupContextBatchIntervalSec', label: 'groupContextBatchIntervalSec（批量投喂间隔秒）', group: '消息与回复', type: 'number', min: 10, help: '默认 600 秒（10 分钟）；没有新消息时不触发模型' },
  { key: 'groupContextBatchMaxMessages', label: 'groupContextBatchMaxMessages（单次最多消息数）', group: '消息与回复', type: 'number', min: 1 },
  { key: 'groupContextBatchMaxChars', label: 'groupContextBatchMaxChars（单次最多字符数）', group: '消息与回复', type: 'number', min: 500 },
  { key: 'groupContextBatchIdleFlushSec', label: 'groupContextBatchIdleFlushSec（冷场跳出秒数）', group: '消息与回复', type: 'number', min: 10, help: '最后一条消息后这么久没人再说话，就提前把当前窗口投喂给模型；默认 120 秒' },
  { key: 'groupContextBatchIdleCutoffSec', label: 'groupContextBatchIdleCutoffSec（冷场跳出截止秒数）', group: '消息与回复', type: 'number', min: 10, help: '窗口开始超过这么久后不再启用冷场跳出，等正常间隔到点；默认 480 秒（8 分钟）' },
  { key: 'replyDelayMinMs', label: 'replyDelayMinMs（兜底分句最小间隔）', group: '消息与回复', type: 'number', min: 0 },
  { key: 'replyDelayMaxMs', label: 'replyDelayMaxMs（兜底分句最大间隔）', group: '消息与回复', type: 'number', min: 0 },
  { key: 'maxLinesPerReply', label: 'maxLinesPerReply（单轮最多消息条数）', group: '消息与回复', type: 'number', min: 1, help: '模型一轮回复建议最多几条消息，超过不会拦截，但 MCP 会提醒模型收尾' },
  { key: 'normalCharsPerMessage', label: 'normalCharsPerMessage（普通对话单条建议字数）', group: '消息与回复', type: 'number', min: 5, help: '写进人格提示词：普通聊天单条尽量不超过这个字数（默认 20），解释类内容可适当加长' },
  { key: 'maxCharsPerMessage', label: 'maxCharsPerMessage（单条消息硬上限）', group: '消息与回复', type: 'number', min: 20, help: '单条超过这个长度不会拦截，但 MCP 会在结果里提醒模型收敛（默认 200）' },
  { key: 'turnTimeoutSec', label: 'turnTimeoutSec（单轮超时秒数）', group: '消息与回复', type: 'number', min: 10 },

  { key: 'mcpHost', label: 'mcpHost（MCP 绑定地址）', group: 'MCP', type: 'string' },
  { key: 'mcpPort', label: 'mcpPort', group: 'MCP', type: 'number', min: 1, max: 65535 },
  { key: 'mcpToken', label: 'mcpToken', group: 'MCP', type: 'password' },
  { key: 'mcpUrl', label: 'mcpUrl（host 侧工作区注入）', group: 'MCP', type: 'string' },
  { key: 'mcpUrlForDocker', label: 'mcpUrlForDocker（容器内地址）', group: 'MCP', type: 'string' },

  { key: 'taskConcurrency', label: 'taskConcurrency（任务并发）', group: '任务沙箱', type: 'number', min: 1 },
  { key: 'taskTimeoutSec', label: 'taskTimeoutSec（任务超时秒数）', group: '任务沙箱', type: 'number', min: 30 },
  { key: 'dockerImage', label: 'dockerImage', group: '任务沙箱', type: 'string' },
  { key: 'dockerHost', label: 'dockerHost（远程 docker 主机）', group: '任务沙箱', type: 'string' },
  { key: 'dockerEnv', label: 'dockerEnv（容器环境变量 JSON）', group: '任务沙箱', type: 'json', help: '给容器注入的 API key 等，形如 {"KEY":"value"}' },
  { key: 'remoteSsh', label: 'remoteSsh（远程文件操作 SSH）', group: '任务沙箱', type: 'string' },
  { key: 'remoteSshKey', label: 'remoteSshKey（SSH 私钥路径）', group: '任务沙箱', type: 'string' },
  { key: 'remoteWorkRoot', label: 'remoteWorkRoot', group: '任务沙箱', type: 'string' },
  { key: 'archiveRetentionDays', label: 'archiveRetentionDays（产物留存天数）', group: '任务沙箱', type: 'number', min: 1 },
  { key: 'storageQuotaMB', label: 'storageQuotaMB（每 QQ 配额 MB）', group: '任务沙箱', type: 'number', min: 10 },

  { key: 'artifactBaseUrl', label: 'artifactBaseUrl（产物下载服务）', group: '产物下载', type: 'string' },
  { key: 'artifactToken', label: 'artifactToken', group: '产物下载', type: 'password' },
  { key: 'linkTtlMinutes', label: 'linkTtlMinutes（下载链接有效期）', group: '产物下载', type: 'number', min: 1 },

  { key: 'panelEnabled', label: 'panelEnabled（启用控制面板）', group: '控制面板', type: 'boolean' },
  { key: 'panelHost', label: 'panelHost（绑定地址）', group: '控制面板', type: 'string', help: '默认 127.0.0.1，只允许本机访问' },
  { key: 'panelPort', label: 'panelPort', group: '控制面板', type: 'number', min: 1, max: 65535 },
  { key: 'panelToken', label: 'panelToken（访问 Token）', group: '控制面板', type: 'password', help: '非空时 API 需要 Authorization: Bearer <token> 或 URL ?token=' },

  { key: 'ttsEnabled', label: 'ttsEnabled（启用语音 TTS）', group: '语音', type: 'boolean', help: '开启后 Agent 可以用 qqbot_send_voice 发语音（MiMo TTS，OpenAI 兼容接口）' },
  { key: 'ttsBaseUrl', label: 'ttsBaseUrl（TTS 服务地址）', group: '语音', type: 'string', help: '默认 https://api.xiaomimimo.com/v1' },
  { key: 'ttsApiKey', label: 'ttsApiKey（MiMo API Key）', group: '语音', type: 'password' },
  { key: 'ttsModel', label: 'ttsModel', group: '语音', type: 'string', help: 'mimo-v2.5-tts-voicedesign（文本描述定制音色，不支持唱歌）/ mimo-v2.5-tts（预置音色，支持唱歌）' },
  { key: 'ttsPresetVoice', label: 'ttsPresetVoice（预置音色）', group: '语音', type: 'string', help: 'ttsModel=mimo-v2.5-tts 或唱歌时使用：冰糖 / 茉莉 / 苏打 / 白桦 / Mia / Chloe / Milo / Dean' },
  { key: 'ttsSingMaxChars', label: 'ttsSingMaxChars（唱歌最大字数）', group: '语音', type: 'number', min: 100 },
  { key: 'ttsFormat', label: 'ttsFormat（音频格式）', group: '语音', type: 'string', help: 'mp3 / wav；网关会转成 QQ 语音格式' },
  { key: 'ttsDefaultVoice', label: 'ttsDefaultVoice（默认音色描述）', group: '语音', type: 'string', help: '每个群可以用 qqbot_set_voice 覆盖；这里是没有单独设置时用的声音' },
  { key: 'ttsMaxChars', label: 'ttsMaxChars（语音最大字数）', group: '语音', type: 'number', min: 1 },
  { key: 'voiceSendBase64', label: 'voiceSendBase64（Base64 发送语音）', group: '语音', type: 'boolean', help: '开启后用 base64:// 发送语音，WS 连远端网关也能用；关闭则发本地文件路径（仅同机网关可用）' },
  { key: 'ttsTimeoutSec', label: 'ttsTimeoutSec（TTS 超时秒数）', group: '语音', type: 'number', min: 10 },
  { key: 'voiceAsrEnabled', label: 'voiceAsrEnabled（入站语音转文字）', group: '语音', type: 'boolean', help: '收到语音时尝试用网关 fetch_ptt_text 取 QQ 转写结果；失败则只显示 [语音]' },
  { key: 'autoApprovePermissions', label: 'autoApprovePermissions（自动批准权限请求）', group: '权限与安全', type: 'boolean', help: 'OpenCode 首次调用搜索/网络等工具会弹权限确认；开启后服务端自动回应，避免会话卡住' },
  { key: 'permissionAutoReply', label: 'permissionAutoReply（批准方式）', group: '权限与安全', type: 'string', help: 'always=记住并长期允许（默认，少弹）；once=只批准这一次' },
  { key: 'remindersEnabled', label: 'remindersEnabled（定时提醒）', group: '定时提醒', type: 'boolean', help: '允许 Agent 用 qqbot_set_reminder 设置倒计时提醒' },
  { key: 'reminderMode', label: 'reminderMode（投递模式）', group: '定时提醒', type: 'string', help: 'agent=到点唤醒模型用自己的语气提醒（默认）；static=直接发固定文案' },
  { key: 'reminderCheckSec', label: 'reminderCheckSec（检查间隔秒）', group: '定时提醒', type: 'number', min: 1, help: '调度器多久检查一次到期提醒' },
  { key: 'reminderMaxPerScope', label: 'reminderMaxPerScope（单会话上限）', group: '定时提醒', type: 'number', min: 1 },
  { key: 'reminderMaxDays', label: 'reminderMaxDays（最大天数）', group: '定时提醒', type: 'number', min: 1 },
  { key: 'proactiveChance', label: 'proactiveChance（候选概率 %）', group: '主动参与（测试）', type: 'number', min: 0, max: 100, help: '满足最少消息数/冷却后，每条候选消息进入判官的概率；本地判官便宜，默认 100' },
  { key: 'proactiveMinIntervalSec', label: 'proactiveMinIntervalSec（冷却秒数）', group: '主动参与（测试）', type: 'number', min: 0 },
  { key: 'proactiveMinMessages', label: 'proactiveMinMessages（最少新消息数）', group: '主动参与（测试）', type: 'number', min: 1 },
  { key: 'proactiveMaxPerHour', label: 'proactiveMaxPerHour（每小时上限）', group: '主动参与（测试）', type: 'number', min: 1 },
  { key: 'proactiveJudgeMode', label: 'proactiveJudgeMode（判官模式）', group: '主动参与（测试）', type: 'string', help: 'auto=有本地判官就用，否则启发式；local=只用本地判官（失败回退启发式）；heuristic=只用规则' },
  { key: 'proactiveJudgeBaseUrl', label: 'proactiveJudgeBaseUrl（本地判官地址）', group: '主动参与（测试）', type: 'string', help: 'OpenAI 兼容服务，如 http://127.0.0.1:11434/v1（Ollama）或 llama.cpp 的 /v1' },
  { key: 'proactiveJudgeModel', label: 'proactiveJudgeModel（本地判官模型）', group: '主动参与（测试）', type: 'string', help: '如 qwen3:0.6b 或本地 GGUF 服务里的模型名；留空=不用本地判官' },
  { key: 'proactiveJudgeApiKey', label: 'proactiveJudgeApiKey（可选）', group: '主动参与（测试）', type: 'password' },
  { key: 'pokeFollowUpSec', label: 'pokeFollowUpSec（被戳后跟进窗口秒）', group: '主动参与（测试）', type: 'number', min: 1, help: '被戳后这段时间内，戳你的人再发消息会直接交给模型判断要不要回（不再走轻量判官）' },
  { key: 'botReplyWindowSec', label: 'botReplyWindowSec（发言后接话窗口秒）', group: '主动参与（测试）', type: 'number', min: 1, help: '机器人刚发过消息后这段时间内，群里有人接话会直接交给模型判断是不是在回它' },
  { key: 'pokeReplyCooldownSec', label: 'pokeReplyCooldownSec（拍一拍回复冷却秒）', group: '主动参与（测试）', type: 'number', min: 1, help: '同一会话两次戳一戳唤醒的最小间隔；模型会像处理消息一样决定回话/回拍/不理' },
  { key: 'contextReplyCooldownSec', label: 'contextReplyCooldownSec（语境回复冷却秒）', group: '主动参与（测试）', type: 'number', min: 0, help: '两次语境自动回复之间的最小间隔' },
  { key: 'proactiveJudgeTimeoutSec', label: 'proactiveJudgeTimeoutSec（判官超时）', group: '主动参与（测试）', type: 'number', min: 1 },
  { key: 'dreamMemoryEnabled', label: 'dreamMemoryEnabled（启用梦境记忆）', group: '梦境记忆', type: 'boolean', help: '每天凌晨 fork 会话更新 MEMORY.md，然后压缩原 session' },
  { key: 'dreamMemoryWindowStartHour', label: 'dreamMemoryWindowStartHour（记忆窗口开始小时）', group: '梦境记忆', type: 'number', min: 0, max: 23 },
  { key: 'dreamMemoryWindowStartMinute', label: 'dreamMemoryWindowStartMinute（窗口开始分钟）', group: '梦境记忆', type: 'number', min: 0, max: 59 },
  { key: 'dreamMemoryWindowEndHour', label: 'dreamMemoryWindowEndHour（记忆窗口结束小时，到点强制）', group: '梦境记忆', type: 'number', min: 0, max: 23 },
  { key: 'dreamMemoryWindowEndMinute', label: 'dreamMemoryWindowEndMinute（窗口结束分钟）', group: '梦境记忆', type: 'number', min: 0, max: 59 },
  { key: 'dreamMemoryIdleMinutes', label: 'dreamMemoryIdleMinutes（群内无消息多久才整理）', group: '梦境记忆', type: 'number', min: 0, max: 240 },
  { key: 'dreamMaxTranscriptChars', label: 'dreamMaxTranscriptChars（喂给梦境的聊天记录上限字符数）', group: '梦境记忆', type: 'number', min: 1000 },
  { key: 'dreamMemoryMaxChars', label: 'dreamMemoryMaxChars（MEMORY.md 建议上限字符数）', group: '梦境记忆', type: 'number', min: 500 },
]

const RESTART_KEYS = new Set<keyof PluginConfig>([
  'opencodeUrl',
  'opencodePassword',
  'onebotUrl',
  'onebotToken',
  'mcpHost',
  'mcpPort',
  'panelEnabled',
  'panelHost',
  'panelPort',
])

export class ControlPanel {
  private server: http.Server | null = null

  constructor(private deps: PanelDeps) {}

  async start(): Promise<void> {
    const { config, log } = this.deps
    if (!config.panelEnabled) {
      log('控制面板未启用 (panelEnabled=false)')
      return
    }
    const host = config.panelHost || '127.0.0.1'
    const port = Number(config.panelPort) || 5101
    const srv = http.createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        log('控制面板请求失败:', e)
        try {
          this.sendJson(res, 500, { error: String((e as Error)?.message ?? e) })
        } catch {
          // response already sent
        }
      })
    })
    this.server = srv
    await new Promise<void>((resolve) => {
      const onError = (e: Error) => {
        log(`控制面板监听失败 ${host}:${port}:`, e)
        srv.off('error', onError)
        this.server = null
        resolve()
      }
      srv.once('error', onError)
      srv.listen(port, host, () => {
        srv.off('error', onError)
        log(`控制面板已启动: http://${host}:${port}/`)
        if (!config.panelToken && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
          log('警告: 控制面板绑定了非回环地址但没有设置 panelToken，任何人都能改配置，请尽快设置 panelToken')
        }
        resolve()
      })
    })
  }

  stop() {
    this.server?.close()
    this.server = null
  }

  // ---- HTTP ----

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(panelHtml)
      return
    }
    if (!pathname.startsWith('/api/')) {
      this.sendJson(res, 404, { error: 'not found' })
      return
    }
    if (!this.authOk(req, url)) {
      this.sendJson(res, 401, { error: 'unauthorized: 需要 panelToken' })
      return
    }

    if (method === 'GET' && pathname === '/api/status') {
      this.sendJson(res, 200, await this.statusPayload())
      return
    }
    if (method === 'GET' && pathname === '/api/config') {
      this.sendJson(res, 200, this.configPayload())
      return
    }
    if (method === 'PUT' && pathname === '/api/config') {
      const body = await this.readBody(req)
      const result = this.updateConfig(body)
      if ('error' in result) {
        this.sendJson(res, 400, result)
        return
      }
      this.sendJson(res, 200, result)
      return
    }
    if (method === 'GET' && pathname === '/api/models') {
      try {
        const [rawModels, providers, defaultModel] = await Promise.all([
          this.deps.oc.listModels(),
          this.deps.oc.listProviders().catch(() => []),
          this.deps.oc.getDefaultModel().catch(() => null),
        ])
        const providerNames = new Map<string, string>(providers.map((x) => [x.id, x.name ?? x.id]))
        const modelIdOf = (m: { id: string; modelID?: string }) => m.modelID ?? m.id
        const items = rawModels
          .map((m) => {
            const id = m.providerID + '/' + modelIdOf(m)
            const cost = Array.isArray(m.cost) ? m.cost : []
            const free = cost.length > 0 && cost.every((c) => (c.input ?? 0) === 0 && (c.output ?? 0) === 0)
            return {
              id,
              providerID: m.providerID,
              providerName: providerNames.get(m.providerID) ?? m.providerID,
              name: m.name,
              free,
              status: m.status ?? 'active',
              enabled: m.enabled !== false,
              context: m.limit?.context ?? null,
              vision: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes('image'),
              currentHost: id === this.deps.config.hostModel,
              currentVision: id === this.deps.config.visionModel,
            }
          })
          .sort((a, b) => Number(b.free) - Number(a.free) || a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name))
        const hostVision = await this.deps.sessions.hostSupportsVision()
        this.sendJson(res, 200, {
          items,
          hostVision,
          current: { hostModel: this.deps.config.hostModel, visionModel: this.deps.config.visionModel },
          defaultModel: defaultModel ? defaultModel.providerID + '/' + modelIdOf(defaultModel) : null,
          providers: providers.map((x) => ({ id: x.id, name: x.name ?? x.id })),
        })
      } catch (e) {
        this.sendJson(res, 502, { error: '读取 OpenCode 模型目录失败（OpenCode 是否在线？）: ' + String((e as Error)?.message ?? e) })
      }
      return
    }
    if (method === 'POST' && pathname === '/api/models/switch') {
      const body = await this.readBody(req)
      const model = String(body.model ?? '').trim()
      const target = body.target === 'vision' ? 'vision' : 'host'
      const applySessions = body.applySessions !== false
      if (!/^[^/\s]+\/.+$/.test(model)) {
        this.sendJson(res, 400, { error: '模型 ID 格式应为 provider/model' })
        return
      }
      let known = true
      try {
        const models = await this.deps.oc.listModels()
        const ids = new Set(models.map((m) => m.providerID + '/' + (m.modelID ?? m.id)))
        known = ids.has(model)
      } catch {
        known = true
      }
      if (!known) {
        this.sendJson(res, 400, { error: '模型不在当前可用目录中: ' + model })
        return
      }
      if (target === 'host') {
        const upd = this.updateConfig({ hostModel: model })
        if (typeof upd.error === 'string') {
          this.sendJson(res, 400, upd)
          return
        }
        const result = applySessions
          ? await this.deps.sessions.switchModelForAll(model)
          : { switched: 0, failed: [] as { scope: string; error: string }[] }
        const hostVision = await this.deps.sessions.hostSupportsVision()
        this.sendJson(res, 200, {
          ok: true,
          target,
          model,
          hostVision,
          switched: result.switched,
          failed: result.failed,
          sessions: this.deps.sessions.listScopes().length,
          current: { hostModel: this.deps.config.hostModel, visionModel: this.deps.config.visionModel },
        })
        return
      }
      if (await this.deps.sessions.hostSupportsVision()) {
        this.sendJson(res, 400, { error: '当前主模型已声明图片输入能力（多模态），识图模型不会启用；等主模型不支持看图时再来设置' })
        return
      }
      const upd = this.updateConfig({ visionModel: model })
      if (typeof upd.error === 'string') {
        this.sendJson(res, 400, upd)
        return
      }
      const workspaces = await this.deps.sessions.updateAllWorkspaceVisionModel(model)
      this.sendJson(res, 200, {
        ok: true,
        target,
        model,
        workspaces,
        current: { hostModel: this.deps.config.hostModel, visionModel: this.deps.config.visionModel },
      })
      return
    }
    if (method === 'GET' && pathname === '/api/sessions') {
      this.sendJson(res, 200, await this.sessionsPayload())
      return
    }
    const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && detailMatch) {
      const scope = decodeURIComponent(detailMatch[1])
      if (!this.validScope(scope)) {
        this.sendJson(res, 400, { error: '非法 scope' })
        return
      }
      const detail = await this.sessionDetail(scope)
      if (!detail) {
        this.sendJson(res, 404, { error: '会话不存在' })
        return
      }
      this.sendJson(res, 200, detail)
      return
    }
    const actionMatch = /^\/api\/sessions\/([^/]+)\/action$/.exec(pathname)
    if (method === 'POST' && actionMatch) {
      const scope = decodeURIComponent(actionMatch[1])
      if (!this.validScope(scope)) {
        this.sendJson(res, 400, { error: '非法 scope' })
        return
      }
      const body = await this.readBody(req)
      const result = await this.sessionAction(scope, body)
      this.sendJson(res, 'error' in result ? 400 : 200, result)
      return
    }
    if (method === 'GET' && pathname === '/api/stickers') {
      this.sendJson(res, 200, this.stickersPayload())
      return
    }
    if (method === 'POST' && pathname === '/api/stickers/sync') {
      const body = await this.readBody(req)
      try {
        const limit = typeof body.limit === 'number' ? body.limit : 300
        const details = await this.deps.sessions.fetchStickerDetails(limit)
        const result = this.deps.stickers.upsertSynced(details)
        this.sendJson(res, 200, { ok: true, ...result, stats: this.deps.stickers.stats() })
      } catch (e) {
        this.sendJson(res, 502, { error: '同步收藏表情失败: ' + String((e as Error)?.message ?? e) })
      }
      return
    }
    const collectionMatch = /^\/api\/stickers\/collections\/([^/]+)$/.exec(pathname)
    if (method === 'DELETE' && collectionMatch) {
      const name = decodeURIComponent(collectionMatch[1])
      const changed = this.deps.stickers.deleteCollection(name)
      this.sendJson(res, 200, {
        ok: true,
        changed,
        stats: this.deps.stickers.stats(),
        collections: this.deps.stickers.listCollections(),
        items: this.deps.stickers.list(),
      })
      return
    }
    if (method === 'PUT' && collectionMatch) {
      const name = decodeURIComponent(collectionMatch[1])
      const body = await this.readBody(req)
      let changed = 0
      if (typeof body.rename === 'string' && body.rename.trim()) {
        changed = this.deps.stickers.renameCollection(name, body.rename)
      }
      if (body.enabled !== undefined) {
        changed += this.deps.stickers.setCollectionEnabled(name, body.enabled === true || body.enabled === 'true')
      }
      this.sendJson(res, 200, {
        ok: true,
        changed,
        stats: this.deps.stickers.stats(),
        collections: this.deps.stickers.listCollections(),
      })
      return
    }
    if (method === 'PUT' && pathname === '/api/stickers/batch') {
      const body = await this.readBody(req)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      if (ids.length === 0) {
        this.sendJson(res, 400, { error: 'ids 不能为空' })
        return
      }
      const changed = this.deps.stickers.batchUpdate(ids, { collection: body.collection, enabled: body.enabled })
      this.sendJson(res, 200, {
        ok: true,
        changed,
        items: this.deps.stickers.list(),
        stats: this.deps.stickers.stats(),
        collections: this.deps.stickers.listCollections(),
      })
      return
    }
    const stickerMatch = /^\/api\/stickers\/([^/]+)$/.exec(pathname)
    if (method === 'PUT' && stickerMatch) {
      const id = decodeURIComponent(stickerMatch[1])
      const body = await this.readBody(req)
      const updated = this.deps.stickers.update(id, body)
      if (!updated) {
        this.sendJson(res, 404, { error: '表情不存在' })
        return
      }
      this.sendJson(res, 200, { ok: true, item: updated, stats: this.deps.stickers.stats() })
      return
    }
    this.sendJson(res, 404, { error: 'not found' })
  }

  private stickersPayload() {
    return {
      items: this.deps.stickers.list(),
      stats: this.deps.stickers.stats(),
      collections: this.deps.stickers.listCollections(),
    }
  }

  private authOk(req: http.IncomingMessage, url: URL): boolean {
    const token = this.deps.config.panelToken
    if (!token) return true
    if (url.searchParams.get('token') === token) return true
    const auth = req.headers.authorization ?? ''
    if (auth === `Bearer ${token}`) return true
    const cookie = req.headers.cookie ?? ''
    if (cookie.split(';').some((c) => c.trim() === `qqbot_panel=${token}`)) return true
    return false
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown) {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > BODY_LIMIT) throw new Error('请求体过大')
      chunks.push(buf)
    }
    const text = Buffer.concat(chunks).toString('utf-8').trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需要 JSON 对象')
      return parsed as Record<string, unknown>
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }

  private validScope(scope: string): boolean {
    return /^(group|private)-\d{3,12}$/.test(scope)
  }

  // ---- 状态 / 会话 ----

  private async statusPayload() {
    const { config, sessions, tasks, mode, dataPath, oc } = this.deps
    const queued = tasks.pending().length
    const all = tasks.all()
    const count = (status: string) => all.filter((t) => t.status === status).length
    return {
      version: PANEL_VERSION,
      mode,
      botName: config.botName,
      uptime: process.uptime(),
      dataPath,
      opencode: { url: config.opencodeUrl, healthy: await oc.health() },
      onebot: this.deps.onebotConnected ? { connected: this.deps.onebotConnected() } : null,
      mcp: { host: config.mcpHost, port: config.mcpPort, tokenSet: !!config.mcpToken },
      panel: { host: config.panelHost, port: config.panelPort, tokenSet: !!config.panelToken },
      tasks: { queued, running: count('running'), done: count('done'), error: count('error'), total: all.length },
      sessions: { total: sessions.listScopes().length },
      dream: {
      enabled: config.dreamMemoryEnabled,
      windowStartHour: config.dreamMemoryWindowStartHour,
      windowStartMinute: config.dreamMemoryWindowStartMinute,
      windowEndHour: config.dreamMemoryWindowEndHour,
      windowEndMinute: config.dreamMemoryWindowEndMinute,
      idleMinutes: config.dreamMemoryIdleMinutes,
    },
    }
  }

  private async sessionsPayload() {
    const { sessions, db, oc, config } = this.deps
    const entries = sessions.listScopes()
    const byScope = new Map(entries.map((e) => [e.scope, e]))
    // 合并消息库里出现过、但当前没有映射的 scope
    const scopes = new Set<string>(entries.map((e) => e.scope))
    try {
      const dir = path.join(this.deps.dataPath, 'messages')
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) if (this.validScope(name)) scopes.add(name)
      }
    } catch {
      // 忽略消息目录读取失败
    }
    let active: Record<string, unknown> = {}
    try {
      active = await oc.getStatus()
    } catch {
      // opencode 离线时列表仍然可用
    }
    const today = dayKey(Math.floor(Date.now() / 1000))
    const list = await Promise.all(
      [...scopes].map(async (scope) => {
        const entry = byScope.get(scope)
        const sessionId = entry?.sessionId
        const [info, recent, count] = await Promise.all([
          sessionId ? oc.getSessionInfo(sessionId).catch(() => null) : Promise.resolve(null),
          Promise.resolve(this.recentDbMessages(scope, 1)),
          Promise.resolve(this.countToday(scope, today)),
        ])
        return {
          scope,
          sessionId: sessionId ?? null,
          title: info?.title ?? null,
          busy: sessionId ? active[sessionId] !== undefined : false,
          pending: sessions.pendingOf(scope).length,
          todayCount: count,
          lastMessage: recent[0]
            ? { time: Number(recent[0].time), nickname: String(recent[0].nickname ?? ''), user_id: recent[0].user_id, text: cleanText(String(recent[0].text ?? '')) }
            : null,
          workspace: entry?.directory ?? path.join(this.deps.dataPath, 'workspaces', scope),
          botName: config.botName,
        }
      })
    )
    list.sort((a, b) => Number(b.busy) - Number(a.busy) || (b.lastMessage?.time ?? 0) - (a.lastMessage?.time ?? 0) || a.scope.localeCompare(b.scope))
    return { sessions: list }
  }

  private async sessionDetail(scope: string) {
    const { sessions, db, oc } = this.deps
    const entry = sessions.listScopes().find((e) => e.scope === scope)
    const known = !!entry || db.listDays(scope).length > 0
    if (!known) return null
    const workspace = entry?.directory ?? path.join(this.deps.dataPath, 'workspaces', scope)
    const sessionId = entry?.sessionId ?? null
    const id = sessionId ?? sessions.sessionIdOf(scope) ?? null
    let info: Awaited<ReturnType<OpencodeClient['getSessionInfo']>> | null = null
    let busy = false
    let ocMessages: unknown[] = []
    if (id) {
      const [i, status, messages] = await Promise.all([
        oc.getSessionInfo(id).catch(() => null),
        oc.getStatus().catch(() => ({}) as Record<string, unknown>),
        oc.getMessages(id, 60).catch(() => [] as OcMessage[]),
      ])
      info = i
      busy = (status as Record<string, unknown>)[id] !== undefined
      ocMessages = this.normalizeMessages(messages)
    }
    const today = dayKey(Math.floor(Date.now() / 1000))
    return {
      scope,
      sessionId: id,
      workspace,
      title: info?.title ?? null,
      info,
      busy,
      pending: sessions.pendingOf(scope),
      lastTrigger: sessions.triggerOf(scope),
      selfId: sessions.selfIdOf(),
      botName: this.deps.config.botName,
      todayCount: this.countToday(scope, today),
      days: db.listDays(scope).length,
      qqMessages: this.recentDbMessages(scope, 80).map((m) => ({
        time: Number(m.time),
        nickname: String(m.nickname ?? ''),
        user_id: m.user_id,
        text: cleanText(String(m.text ?? '')),
        isBot: sessions.selfIdOf() > 0 ? Number(m.user_id) === sessions.selfIdOf() : String(m.nickname ?? '') === this.deps.config.botName,
      })),
      ocMessages,
      mutes: sessions.mutes.list(scope),
      tasks: this.deps.tasks.all().filter((t) => t.scope === scope).slice(0, 20),
      files: this.readWorkspaceFiles(workspace),
      dream: this.deps.dream.stateOf(scope),
    }
  }

  private recentDbMessages(scope: string, limit: number): Record<string, unknown>[] {
    const { db } = this.deps
    const days = db.listDays(scope)
    const rows: Record<string, unknown>[] = []
    for (const day of [...days].reverse()) {
      try {
        const got = db.query(scope, day, 'SELECT message_id, time, nickname, user_id, text, reply_to FROM message ORDER BY msg_pk DESC LIMIT ?', [limit])
        rows.push(...got)
      } catch {
        // 该天文件读不了就跳过
      }
      if (rows.length >= limit) break
    }
    rows.sort((a, b) => Number(a.time) - Number(b.time))
    return rows.slice(-limit)
  }

  private countToday(scope: string, today: string): number {
    try {
      const rows = this.deps.db.query(scope, today, 'SELECT COUNT(*) AS c FROM message', [])
      return Number(rows[0]?.c ?? 0)
    } catch {
      return 0
    }
  }

  private normalizeMessages(messages: OcMessage[]): unknown[] {
    const out: Record<string, unknown>[] = []
    for (const m of [...messages].reverse()) {
      const time = typeof m.time?.created === 'number' ? Math.floor(m.time.created / 1000) : null
      if (m.type === 'user') {
        out.push({ role: 'user', text: m.text ?? joinText(m.content), time })
        continue
      }
      if (m.type === 'assistant') {
        const content = Array.isArray(m.content) ? m.content : []
        const text = content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim()
        const reasoning = content.filter((c) => c.type === 'reasoning' && typeof c.text === 'string').map((c) => c.text).join('\n').trim()
        const tools = content
          .filter((c) => typeof c.type === 'string' && c.type !== 'text' && c.type !== 'reasoning')
          .map((c) => ({ type: String(c.type), summary: JSON.stringify(c).slice(0, 400) }))
        // 只有工具调用、没有可见文本/思考的中间步骤不展示，避免对话被工具轮次淹没
        if (!text && !reasoning) continue
        out.push({ role: 'assistant', text, reasoning, tools, model: m.model?.id ?? null, time })
        continue
      }
      if (m.type === 'system') {
        out.push({ role: 'system', text: m.text ?? m.description ?? '', time })
        continue
      }
      if (m.type === 'synthetic') {
        out.push({ role: 'system', text: m.payload?.text ?? m.text ?? '', synthetic: true, time })
        continue
      }
      if (m.type === 'idle') continue
      const text = m.text ?? joinText(m.content)
      if (text) out.push({ role: m.type ?? 'system', text, time })
    }
    return out
  }

  private readWorkspaceFiles(workspace: string): { agentsMd: string | null; opencodeJson: string | null; memoryMd: string | null; memoryBackup: string | null } {
    const read = (name: string): string | null => {
      try {
        const file = path.join(workspace, name)
        if (!fs.existsSync(file)) return null
        return fs.readFileSync(file, 'utf-8').slice(0, 200_000)
      } catch {
        return null
      }
    }
    return { agentsMd: read('AGENTS.md'), opencodeJson: read('opencode.json'), memoryMd: read('MEMORY.md'), memoryBackup: read('MEMORY.md.bak') }
  }

  // ---- 配置 ----

  private configPayload() {
    const config = this.deps.config
    return {
      config: { ...config, dockerEnv: { ...config.dockerEnv } },
      fields: FIELDS,
      restartKeys: [...RESTART_KEYS],
      file: resolveConfigFile(this.deps.configPath),
      version: PANEL_VERSION,
    }
  }

  private updateConfig(body: Record<string, unknown>): Record<string, unknown> {
    const input = (body.config ?? body) as Record<string, unknown>
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: '配置必须是 JSON 对象' }
    const defaults = defaultConfig as unknown as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    const errors: string[] = []
    const ignored: string[] = []
    for (const [key, value] of Object.entries(input)) {
      if (!(key in defaults)) {
        ignored.push(key)
        continue
      }
      const def = defaults[key]
      if (key === 'dockerEnv') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push('dockerEnv 必须是对象')
          continue
        }
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            errors.push(`dockerEnv.${k} 必须是字符串`)
            continue
          }
          env[k] = v
        }
        patch[key] = env
        continue
      }
      if (typeof def === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
          errors.push(`${key} 必须是整数`)
          continue
        }
        const field = FIELDS.find((f) => f.key === key)
        if (field?.min != null && value < field.min) {
          errors.push(`${key} 不能小于 ${field.min}`)
          continue
        }
        if (field?.max != null && value > field.max) {
          errors.push(`${key} 不能大于 ${field.max}`)
          continue
        }
        patch[key] = value
        continue
      }
      if (typeof def === 'boolean') {
        if (typeof value !== 'boolean') {
          errors.push(`${key} 必须是布尔值`)
          continue
        }
        patch[key] = value
        continue
      }
      if (typeof value !== 'string') {
        errors.push(`${key} 必须是字符串`)
        continue
      }
      if (value.length > 4096) {
        errors.push(`${key} 过长`)
        continue
      }
      patch[key] = value
    }
    if (errors.length > 0) return { error: errors.join('; ') }
    const keys = Object.keys(patch)
    if (keys.length === 0) return { error: '没有可保存的配置项', ignored }
    // 只把真正变化的值算进 applied/restartRequired：面板保存时会提交整个表单，
    // 未改动的字段不能让提示里冒出一堆“需重启”
    const current = this.deps.config as unknown as Record<string, unknown>
    const changedKeys = keys.filter((k) => JSON.stringify(patch[k]) !== JSON.stringify(current[k]))
    if (changedKeys.length === 0) return { saved: true, applied: [], restartRequired: [], ignored, changed: 0, config: { ...this.deps.config, dockerEnv: { ...this.deps.config.dockerEnv } } }
    Object.assign(this.deps.config, patch)
    let file = ''
    try {
      file = saveConfig(this.deps.configPath, this.deps.config)
    } catch (e) {
      return { error: `写配置文件失败: ${(e as Error)?.message ?? e}` }
    }
    const restartRequired = changedKeys.filter((k) => RESTART_KEYS.has(k as keyof PluginConfig))
    const applied = changedKeys.filter((k) => !RESTART_KEYS.has(k as keyof PluginConfig))
    this.deps.log(`控制面板保存配置: applied=[${applied.join(',')}] restart=[${restartRequired.join(',')}]`)
    return {
      saved: true,
      file,
      applied,
      restartRequired,
      changed: changedKeys.length,
      ignored,
      config: { ...this.deps.config, dockerEnv: { ...this.deps.config.dockerEnv } },
    }
  }

  // ---- 会话操作 ----

  private async sessionAction(scope: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { sessions, config } = this.deps
    const action = String(body.action ?? '')
    if (!sessions.sessionIdOf(scope) && action !== 'send') {
      return { error: '该会话还没有 OpenCode session，先去 QQ 里 @机器人 触发一次' }
    }
    if (action === 'reset') {
      const ok = await sessions.resetScope(scope)
      return ok ? { ok: true, message: '已清空会话记忆，下一条消息会重建 session' } : { error: '会话不存在' }
    }
    if (action === 'abort') {
      const ok = await sessions.abortScope(scope)
      return ok ? { ok: true, message: '已发送打断' } : { error: '会话不存在' }
    }
    if (action === 'dream') {
      if (!sessions.sessionIdOf(scope)) return { error: '该会话还没有 OpenCode session' }
      void this.deps.dream.runForScope(scope).catch((e: unknown) => this.deps.log('手动梦境整理失败:', e))
      return { ok: true, message: '已开始梦境整理，约 1-3 分钟后可在会话详情看到结果' }
    }
    if (action === 'send') {
      const text = String(body.text ?? '').trim()
      if (!text) return { error: '消息内容为空' }
      if (text.length > MAX_TEXT) return { error: `消息过长（最多 ${MAX_TEXT} 字）` }
      const target = String(body.target ?? 'qq')
      if (target === 'qq') {
        await sessions.sendTextToScope(scope, text)
        return { ok: true, message: '已发送到 QQ' }
      }
      if (target === 'agent') {
        const sessionId = sessions.sessionIdOf(scope)
        if (!sessionId) return { error: '该会话还没有 session' }
        await sessions.prompt(sessionId, text)
        return { ok: true, message: `已作为 prompt 发给 Agent（${config.botName} 的回复会正常发到 QQ）` }
      }
      return { error: `未知的发送目标: ${target}` }
    }
    return { error: `未知操作: ${action}` }
  }
}

function joinText(content?: { type?: string; text?: string }[]): string {
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n')
}

// 面板展示用：去掉 CQ 码、压缩空白，避免把原始消息段协议直接暴露在 UI 上
function cleanText(text: string): string {
  return text
    .replace(/\[CQ:[^\]]+\]/g, (m) => (m.startsWith('[CQ:image') ? '[图片]' : ''))
    .replace(/\s+/g, ' ')
    .trim()
}
