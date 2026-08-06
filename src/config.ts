import fs from 'node:fs'
import path from 'node:path'

export interface PluginConfig {
  botName: string
  hostModel: string
  opencodeUrl: string
  opencodePassword: string
  mcpPort: number
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

export function loadConfig(configDir: string): PluginConfig {
  const file = path.join(configDir, 'config.json')
  try {
    if (fs.existsSync(file)) {
      return { ...defaultConfig, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }
    }
  } catch {
    // fall through to defaults
  }
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(defaultConfig, null, 2))
  return { ...defaultConfig }
}
