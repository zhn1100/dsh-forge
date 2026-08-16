// Drive one Forge agent session: create (or reuse), prompt, poll until the
// turn ends, printing tool calls/results. Task-agnostic harness for the
// Forge control plane; nothing here is specific to any plugin.
//
// Usage:
//   node session-drive.mjs --prompt "call forge_doctor" [--cwd DIR] [--session SESSION_ID] [--timeout-ms N]
// Env: FORGE_BASE (default http://127.0.0.1:3188/api)
import { randomUUID } from 'node:crypto'

const BASE = process.env.FORGE_BASE ?? 'http://127.0.0.1:3188/api'
const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const prompt = option('--prompt') ?? ''
const cwd = option('--cwd')
const sessionId = option('--session')
const timeoutMs = Number(option('--timeout-ms') ?? 300_000)
if (!prompt) throw new Error('--prompt is required')

async function call(method, payload) {
  const rpcId = randomUUID()
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await res.json()
  if (!body.result?.ok) throw new Error(`${method}: ${JSON.stringify(body.result?.error ?? body)}`)
  return body.result
}

let activeSession = sessionId
if (!activeSession) {
  const created = await call('session.create', { presetId: option('--preset') ?? 'cordis-developer', ...(cwd ? { cwd } : {}) })
  activeSession = created.value.sessionId
  console.log(`SESSION ${activeSession}`)
}

await call('session.prompt', { sessionId: activeSession, mode: 'queue', content: [{ type: 'text', text: prompt }] })

const deadline = Date.now() + timeoutMs
let lastSeq = 0
const initial = await call('session.history', { sessionId: activeSession })
if (initial.value.events.length > 0) {
  lastSeq = Math.max(...initial.value.events.map(e => e.event.seq))
}
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 4000))
  const history = await call('session.history', { sessionId: activeSession })
  const events = history.value.events
  if (events.length === 0) continue
  const max = Math.max(...events.map(e => e.event.seq))
  const turnEnd = events.some(e => e.event.type === 'turn/end' && e.event.seq > lastSeq)
  for (const entry of events) {
    if (entry.event.seq <= lastSeq) continue
    const e = entry.event
    if (e.type === 'tool/call') {
      console.log(`CALL ${e.data.name} ${String(e.data.arguments).slice(0, 160)}`)
    }
    if (e.type === 'tool/result') {
      const text = e.data?.message?.content?.[0]?.content?.[0]?.text
      console.log(`RESULT ${text ? text.slice(0, 400).replace(/\n/g, ' ') : ''}`)
    }
  }
  lastSeq = max
  if (turnEnd) {
    console.log('TURN_END')
    process.exit(0)
  }
}
console.error('timeout waiting for turn end')
process.exit(1)
