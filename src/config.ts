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
}

export const defaultConfig: PluginConfig = {
  botName: 'DeepSleep',
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotToken: '',
  hostModel: 'opencode/deepseek-v4-flash-free',
  visionModel: 'opencode/mimo-v2.5-free',
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
}

// NapCat ctx.configPath 语义：插件配置文件路径（<config>/plugins/<id>/config.json）。
// 兼容旧语义：若以 .json 结尾视为文件路径，否则视为目录并拼接 config.json。
export function loadConfig(configPath: string): PluginConfig {
  const file = configPath.endsWith('.json') ? configPath : path.join(configPath, 'config.json')
  try {
    if (fs.existsSync(file)) {
      return { ...defaultConfig, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }
    }
  } catch {
    // fall through to defaults
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(defaultConfig, null, 2))
  return { ...defaultConfig }
}
