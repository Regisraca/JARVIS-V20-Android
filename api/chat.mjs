import { generateWithFallback } from '../server/providers.mjs'

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers: { 'content-type': 'application/json' } })
    try {
      const contentType = request.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) return Response.json({ error: 'Use application/json.' }, { status: 415 })
      const body = await request.json()
      const messages = Array.isArray(body?.messages) ? body.messages : []
      if (!messages.length) return Response.json({ error: 'messages é obrigatório' }, { status: 400 })
      if (messages.length > 60 || messages.some((m) => typeof m?.content === 'string' && m.content.length > 12_000)) return Response.json({ error: 'conversa excede os limites permitidos' }, { status: 413 })
      const result = await generateWithFallback(messages, { signal: request.signal })
      return Response.json(result)
    } catch (err) {
      if (err?.name === 'AbortError') return new Response(JSON.stringify({ error: 'cancelado' }), { status: 499, headers: { 'content-type': 'application/json' } })
      return Response.json({ error: err?.message || 'falha de provedor', code: err?.code || 'PROVIDER_UNAVAILABLE', details: err?.details || null }, { status: 502 })
    }
  },
}
