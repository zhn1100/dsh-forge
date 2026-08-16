// Generic CDP helpers for headless-Chrome verification of a Harness/Forge page.
// Node >= 22 only (built-in WebSocket/fetch). Usage:
//   import { getPages, connect, pageEval } from './cdp.mjs'
//   const pages = await getPages()
//   await pageEval("document.title")
import http from 'node:http'

export async function getPages() {
  const port = process.env.CDP_PORT ?? 9222
  return await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
      })
    }).on('error', reject)
  })
}

export function connect(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const opened = new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
  return {
    ws,
    ready: opened,
    cmd(method, params = {}) {
      const id = nextId++
      return opened.then(() => new Promise((resolve) => {
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
      }))
    },
  }
}

export async function pageEval(expression, pageIndex = 0) {
  const pages = await getPages()
  const page = pages.filter(p => p.type === 'page')[pageIndex]
  if (!page) throw new Error('no page target')
  const client = connect(page.webSocketDebuggerUrl)
  const response = await client.cmd('Runtime.evaluate', { expression, returnByValue: true })
  client.ws.close()
  return response.result?.result?.value
}
