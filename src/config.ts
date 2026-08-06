import fs from 'node:fs'
import path from 'node:path'

export interface PluginConfig {
  botName: string
  hostModel: string
  opencodeUrl: string
  opencodePassword: string
  mcpPort: number
  mcpHost: string
  mcpToken: string
  mcpUrl: string
  mcpUrlForDocker: string
  dockerImage: string
  dockerEnv: Record<string, string>
  taskTimeoutSec: number
  taskConcurrency: number
  contextMessageCount: number
  replyDelayMinMs: number
  replyDelayMaxMs: number
}

export const defaultConfig: PluginConfig = {
  botName: 'DeepSleep',
  hostModel: 'opencode/deepseek-v4-flash-free',
  opencodeUrl: 'http://127.0.0.1:4096',
  opencodePassword: '',
  mcpPort: 5100,
  mcpHost: '127.0.0.1',
  mcpToken: '',
  mcpUrl: 'http://127.0.0.1:5100/mcp',
  mcpUrlForDocker: 'http://host.docker.internal:5100/mcp',
  dockerImage: 'qqbot-opencode-task:latest',
  dockerEnv: {},
  taskTimeoutSec: 900,
  taskConcurrency: 2,
  contextMessageCount: 15,
  replyDelayMinMs: 300,
  replyDelayMaxMs: 800,
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
