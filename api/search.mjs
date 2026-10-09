import { searchWeb } from '../server/search.mjs'

export default {
  async fetch(request) {
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers: { 'content-type': 'application/json' } })
    try {
      const contentType = request.headers.get('content-type') || ''
      if (!contentType.toLowerCase().includes('application/json')) return Response.json({ error: 'Use application/json.' }, { status: 415 })
      const body = await request.json()
      if (typeof body?.query !== 'string' || !body.query.trim()) return Response.json({ error: 'query é obrigatório' }, { status: 400 })
      if (body.query.length > 500) return Response.json({ error: 'query excede 500 caracteres' }, { status: 413 })
      const result = await searchWeb(body.query, { signal: request.signal })
      return Response.json(result, { status: result.status === 'ok' ? 200 : 502 })
    } catch (err) {
      if (err?.name === 'AbortError') return new Response(JSON.stringify({ error: 'cancelado' }), { status: 499, headers: { 'content-type': 'application/json' } })
      return Response.json({ error: err?.message || 'falha de pesquisa' }, { status: 502 })
    }
  },
}
