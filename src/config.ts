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
  // 控制面板（WebUI）
  panelEnabled: boolean
  panelHost: string
  panelPort: number
  panelToken: string
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
  panelEnabled: true,
  panelHost: '127.0.0.1',
  panelPort: 5101,
  panelToken: '',
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
