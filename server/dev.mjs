import http from 'node:http'
import chat from '../api/chat.mjs'
import search from '../api/search.mjs'
import health from '../api/health.mjs'

const handlers = { '/api/chat': chat, '/api/search': search, '/api/health': health }
const PORT = Number(process.env.JARVIS_API_PORT) || 8788

const server = http.createServer(async (req, res) => {
  const handler = handlers[req.url?.split('?')[0]]
  if (!handler) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'rota desconhecida' }))
  }

  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 250_000) {
      res.writeHead(413, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'pedido grande demais' }))
    }
  }

  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  if (raw && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const request = new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: raw || undefined })
  const response = await handler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    res.end(buf)
  } else {
    res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`[jarvis] API local em http://127.0.0.1:${PORT}`))
