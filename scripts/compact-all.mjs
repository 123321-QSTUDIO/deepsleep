#!/usr/bin/env node
// 升级前手动 Compact 所有托管 Session（不改 MEMORY.md，只让摘要接管旧上下文）
// 用法：
//   QQBOT_DATA=/path/to/data node scripts/compact-all.mjs
//   node scripts/compact-all.mjs --data C:\\qqbot-svc\\data
// 需要 opencode serve 正在运行，且 config.json 里的 opencodeUrl/opencodePassword 正确。
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
function argValue(name, fallback) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const dataDir = path.resolve(argValue('--data', process.env.QQBOT_DATA || path.join(process.cwd(), 'data')))
const timeoutSec = Math.max(10, Number(argValue('--timeout', '180')) || 180)
const configFile = path.join(dataDir, 'config.json')
const sessionsFile = path.join(dataDir, 'sessions.json')
if (!fs.existsSync(configFile)) {
  console.error('找不到配置：' + configFile)
  process.exit(2)
}
if (!fs.existsSync(sessionsFile)) {
  console.log('没有 sessions.json，无需 Compact。' + sessionsFile)
  process.exit(0)
}
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const baseUrl = String(config.opencodeUrl || 'http://127.0.0.1:4096').replace(/\/+$/, '')
const password = String(config.opencodePassword || '')
const headers = () => {
  const h = { 'content-type': 'application/json' }
  if (password) h.authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
  return h
}
const entries = Object.entries(JSON.parse(fs.readFileSync(sessionsFile, 'utf8')))
const scopes = entries.map(([scope, entry]) => ({ scope, sessionId: String(entry?.sessionId || '') })).filter((x) => x.sessionId)
if (scopes.length === 0) { console.log('没有可 Compact 的 Session。'); process.exit(0) }
console.log('OpenCode: ' + baseUrl)
console.log('准备 Compact ' + scopes.length + ' 个 Session（超时 ' + timeoutSec + 's/个）')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(method, p, body) {
  const res = await fetch(baseUrl + p, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, data, text }
}
async function compactOne(scope, sessionId) {
  const before = await api('GET', '/api/session/' + encodeURIComponent(sessionId) + '/message?limit=50')
  if (before.status === 404) return { ok: true, skipped: 'session 不存在（404）' }
  if (before.status !== 200) return { ok: false, error: '读取消息失败 HTTP ' + before.status }
  const oldIds = new Set((before.data?.data ?? []).filter((m) => m.type === 'compaction').map((m) => String(m.id)))
  const started = Date.now()
  const posted = await api('POST', '/api/session/' + encodeURIComponent(sessionId) + '/compact', {})
  if (posted.status === 404) return { ok: true, skipped: 'session 不存在（404）' }
  if (posted.status !== 200 && posted.status !== 204) return { ok: false, error: 'compact HTTP ' + posted.status + ': ' + String(posted.text).slice(0, 200) }
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    await sleep(2000)
    const res = await api('GET', '/api/session/' + encodeURIComponent(sessionId) + '/message?limit=50')
    if (res.status !== 200) continue
    const found = (res.data?.data ?? []).find((m) => m.type === 'compaction' && !oldIds.has(String(m.id)))
    if (found && String(found.status) === 'completed') return { ok: true }
    if (found && String(found.status) === 'failed') return { ok: false, error: 'compaction failed' }
  }
  return { ok: false, error: '等待 compaction 超时' }
}
let failed = 0
for (const { scope, sessionId } of scopes) {
  process.stdout.write('  ' + scope + ' (' + sessionId + ') ... ')
  try {
    const r = await compactOne(scope, sessionId)
    if (r.ok) console.log('OK' + (r.skipped ? '（' + r.skipped + '）' : ''))
    else { failed++; console.log('FAILED: ' + r.error) }
  } catch (e) {
    failed++
    console.log('FAILED: ' + String(e?.message ?? e))
  }
}
if (failed > 0) {
  console.error('\n有 ' + failed + ' 个 Session Compact 失败，请检查 OpenCode 后重跑。')
  process.exit(1)
}
console.log('\n全部 Session 已 Compact。现在可以更新/重启机器人服务。')
process.exit(0)