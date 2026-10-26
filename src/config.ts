import fs from 'node:fs'
import path from 'node:path'

export interface PluginConfig {
  botName: string
  onebotUrl: string
  onebotToken: string
  hostModel: string
  visionModel: string
  opencodeUrl: string
  opencodePassword: string
  mcpPort: number
  mcpHost: string
  mcpToken: string
  mcpUrl: string
  mcpUrlForDocker: string
  dockerImage: string
  dockerHost: string
  remoteSsh: string
  remoteSshKey: string
  remoteWorkRoot: string
  archiveRetentionDays: number
  storageQuotaMB: number
  artifactBaseUrl: string
  artifactToken: string
  linkTtlMinutes: number
  dockerEnv: Record<string, string>
  taskTimeoutSec: number
  taskConcurrency: number
  turnTimeoutSec: number
  contextMessageCount: number
  replyDelayMinMs: number
  replyDelayMaxMs: number
  maxLinesPerReply: number
  normalCharsPerMessage: number
  maxCharsPerMessage: number
  // 控制面板（WebUI）
  panelEnabled: boolean
  panelHost: string
  panelPort: number
  panelToken: string
  // 主动参与：没人@时先由轻量判官决定要不要让主模型接话（判官可本地小模型/启发式）
  proactiveEnabled: boolean
  proactiveChance: number
  proactiveMinIntervalSec: number
  proactiveMinMessages: number
  proactiveMaxPerHour: number
  proactiveJudgeMode: string
  proactiveJudgeBaseUrl: string
  proactiveJudgeModel: string
  proactiveJudgeApiKey: string
  proactiveJudgeTimeoutSec: number
  // 语境自动回复：被戳后/机器人发言后的窗口内，直接交给模型判断要不要回
  pokeFollowUpSec: number
  botReplyWindowSec: number
  contextReplyCooldownSec: number
  pokeReplyCooldownSec: number
  // 权限：OpenCode 首次调用搜索/网络等工具会请求确认，服务端自动批准避免卡住
  autoApprovePermissions: boolean
  permissionAutoReply: string
  // 定时提醒：机器人可自设倒计时，系统到点投递
  remindersEnabled: boolean
  reminderMode: string
  reminderCheckSec: number
  reminderMaxPerScope: number
  reminderMaxDays: number
  // 语音：TTS（MiMo，OpenAI 兼容接口）+ 入站语音转文字
  ttsEnabled: boolean
  ttsBaseUrl: string
  ttsApiKey: string
  ttsModel: string
  ttsFormat: string
  ttsDefaultVoice: string
  ttsMaxChars: number
  ttsTimeoutSec: number
  // 语音发送：base64 可跨 WS 远端网关，file 仅网关与本机同机时可用
  voiceSendBase64: boolean
  voiceAsrEnabled: boolean
  // 梦境记忆：每晚 fork 会话整理 MEMORY.md，然后压缩原 session
  dreamMemoryEnabled: boolean
  dreamMemoryHour: number
  dreamMemoryMinute: number
  dreamMaxTranscriptChars: number
  dreamMemoryMaxChars: number
}

export const defaultConfig: PluginConfig = {
  botName: 'DeepSleep',
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotToken: '',
  hostModel: 'opencode/deepseek-v4.1-flash-free',
  visionModel: 'opencode/mimo-v2.6-flash-free',
  opencodeUrl: 'http://127.0.0.1:4096',
  opencodePassword: '',
  mcpPort: 5100,
  mcpHost: '127.0.0.1',
  mcpToken: '',
  mcpUrl: 'http://127.0.0.1:5100/mcp',
  mcpUrlForDocker: 'http://host.docker.internal:5100/mcp',
  dockerImage: 'qqbot-opencode-task:latest',
  dockerHost: '',
  remoteSsh: '',
  remoteSshKey: '',
  remoteWorkRoot: '/opt/qqbot-users',
  archiveRetentionDays: 5,
  storageQuotaMB: 500,
  artifactBaseUrl: '',
  artifactToken: '',
  linkTtlMinutes: 10,
  dockerEnv: {},
  taskTimeoutSec: 900,
  taskConcurrency: 3,
  turnTimeoutSec: 240,
  contextMessageCount: 15,
  replyDelayMinMs: 1200,
  replyDelayMaxMs: 3000,
  maxLinesPerReply: 4,
  normalCharsPerMessage: 20,
  maxCharsPerMessage: 200,
  panelEnabled: true,
  panelHost: '127.0.0.1',
  panelPort: 5101,
  panelToken: '',
  proactiveEnabled: true,
  proactiveChance: 100,
  proactiveMinIntervalSec: 180,
  proactiveMinMessages: 3,
  proactiveMaxPerHour: 6,
  proactiveJudgeMode: 'auto',
  proactiveJudgeBaseUrl: '',
  proactiveJudgeModel: '',
  proactiveJudgeApiKey: '',
  proactiveJudgeTimeoutSec: 3,
  pokeFollowUpSec: 120,
  botReplyWindowSec: 90,
  contextReplyCooldownSec: 20,
  pokeReplyCooldownSec: 15,
  autoApprovePermissions: true,
  permissionAutoReply: 'always',
  remindersEnabled: true,
  reminderMode: 'agent',
  reminderCheckSec: 5,
  reminderMaxPerScope: 20,
  reminderMaxDays: 7,
  ttsEnabled: false,
  ttsBaseUrl: 'https://api.xiaomimimo.com/v1',
  ttsApiKey: '',
  ttsModel: 'mimo-v2.5-tts-voicedesign',
  ttsFormat: 'mp3',
  ttsDefaultVoice: '青年女性，语气轻快自然，像群聊里熟络的朋友，语速稍快，情绪松弛。',
  ttsMaxChars: 200,
  ttsTimeoutSec: 90,
  voiceSendBase64: true,
  voiceAsrEnabled: true,
  dreamMemoryEnabled: true,
  dreamMemoryHour: 4,
  dreamMemoryMinute: 30,
  dreamMaxTranscriptChars: 120000,
  dreamMemoryMaxChars: 8000,
}

const modelMigrations: Record<string, string> = {
  'opencode/deepseek-v4-flash-free': 'opencode/deepseek-v4.1-flash-free',
  'opencode/mimo-v2.5-free': 'opencode/mimo-v2.6-flash-free',
  'deepseek/deepseek-v4-flash': 'deepseek/deepseek-flash',
}

// NapCat ctx.configPath 语义：插件配置文件路径（<config>/plugins/<id>/config.json）。
// 兼容旧语义：若以 .json 结尾视为文件路径，否则视为目录并拼接 config.json。
export function resolveConfigFile(configPath: string): string {
  return configPath.endsWith('.json') ? configPath : path.join(configPath, 'config.json')
}

// 控制面板保存配置：写回磁盘（调用方负责先校验并更新内存中的 config 对象）
export function saveConfig(configPath: string, config: PluginConfig): string {
  const file = resolveConfigFile(configPath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

export function loadConfig(configPath: string): PluginConfig {
  const file = resolveConfigFile(configPath)
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PluginConfig>
      let migrated = saved
      for (const key of ['hostModel', 'visionModel'] as const) {
        const current = migrated[key]
        if (current && modelMigrations[current]) migrated = { ...migrated, [key]: modelMigrations[current] }
      }
      if (migrated !== saved) {
        try {
          fs.writeFileSync(file, JSON.stringify(migrated, null, 2))
        } catch {
          // 迁移写回失败（只读/被占用）不影响本次加载：继续使用迁移后的值，不能退回默认配置
        }
      }
      return { ...defaultConfig, ...migrated }
    }
  } catch {
    // fall through to defaults
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(defaultConfig, null, 2))
  return { ...defaultConfig }
}
