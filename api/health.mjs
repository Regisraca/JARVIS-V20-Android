import { configuredProviders } from '../server/providers.mjs'
import { envString } from '../server/env.mjs'

export default {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Use GET.' }), { status: 405, headers: { 'content-type': 'application/json' } })
    const providers = configuredProviders()
    const body = {
      ok: providers.length > 0,
      providers,
      // A pesquisa web básica (Wikipedia, DuckDuckGo, notícias, APIs públicas) não exige chave.
      search: ['wikipedia', 'duckduckgo', 'news-rss', 'public-apis']
        .concat(envString('GEMINI_API_KEY') || envString('GEMINI_API_KEYS') ? ['gemini-grounding'] : [])
        .concat(envString('TAVILY_API_KEY') ? ['tavily'] : [])
        .concat(envString('BRAVE_API_KEY') ? ['brave'] : []),
      bridge: 'client-local',
    }
    return Response.json(body, { status: body.ok ? 200 : 503 })
  },
}
