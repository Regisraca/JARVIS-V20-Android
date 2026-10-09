import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

const originalFetch = globalThis.fetch
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

process.env.GROQ_API_KEYS = 'gsk_test_1,gsk_test_2'
process.env.GEMINI_API_KEYS = 'AIza_test_1'
process.env.JARVIS_PROVIDER_ORDER = 'groq,gemini'

// ---------------------------------------------------------------------------
// 1) cérebro: rotação de chaves + fallback Groq 429 → Gemini
// ---------------------------------------------------------------------------
const { generateWithFallback, configuredProviders } = await import('../server/providers.mjs')
assert.deepEqual(configuredProviders(), ['groq', 'gemini'])
const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  if (String(url).includes('api.groq.com')) return json({ error: { message: 'rate limited in test' } }, 429)
  if (String(url).includes('generativelanguage.googleapis.com')) return json({ candidates: [{ content: { parts: [{ text: 'Olá, senhor. Estou operacional.' }] } }] })
  throw new Error(`unexpected URL: ${url}`)
}
const fallback = await generateWithFallback([{ role: 'user', content: 'Olá JARVIS' }])
assert.equal(fallback.provider, 'gemini')
assert.equal(fallback.fallback, true)
assert.equal(fallback.errors[0].status, 429)
assert.equal(calls.filter((u) => u.includes('api.groq.com')).length, 2)

// ---------------------------------------------------------------------------
// 2) pesquisa web
// ---------------------------------------------------------------------------
const { searchWeb } = await import('../server/search.mjs')

const wikiPage = (title, extract, url) => json({ query: { pages: { 1: { pageid: 1, index: 1, title, extract, fullurl: url, touched: '2026-09-01T10:00:00Z' } } } })
const ddgHtml = (target, title, snippet) => html(`<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&amp;rut=abc">${title}</a></h2><a class="result__snippet" href="x">${snippet}</a></div>`)
const article = (text) => html(`<html><head><title>Artigo</title><meta property="article:published_time" content="2026-10-06T12:00:00Z"></head><body><nav>menu</nav><p>${text}</p></body></html>`)

// 2a) API exata: cotação não passa por IA nem por busca geral
let seen = []
globalThis.fetch = async (url) => {
  seen.push(String(url))
  if (String(url).includes('coingecko')) return json({ bitcoin: { usd: 70000, brl: 350000, last_updated_at: 1790000000 } })
  throw new Error(`unexpected URL: ${url}`)
}
const btc = await searchWeb('Jarvis, quanto está o bitcoin agora?')
assert.equal(btc.status, 'ok')
assert.equal(btc.provider, 'coingecko')
assert.equal(btc.confidence, 'alta')
assert.match(btc.summary, /350\.000,00/)
assert.equal(seen.length, 1)

// 2b) pergunta atual: Gemini grounding + Wikipedia + DuckDuckGo + notícias
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('generativelanguage.googleapis.com')) return json({ candidates: [{ content: { parts: [{ text: 'O técnico atual do São Paulo é Fulano de Tal, segundo as fontes.' }] }, groundingMetadata: { groundingChunks: [{ web: { title: 'ge.globo.com', uri: 'https://ge.globo.com/sp/futebol/noticia.html' } }] } }] })
  if (u.includes('wikipedia.org/w/api.php')) return wikiPage('São Paulo Futebol Clube', 'O São Paulo Futebol Clube é um clube brasileiro. O técnico do time principal é Fulano de Tal.', 'https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo_Futebol_Clube')
  if (u.includes('html.duckduckgo.com')) return ddgHtml('https://example.com/spfc-tecnico', 'Técnico do São Paulo', 'O técnico do São Paulo é Fulano de Tal.')
  if (u === 'https://example.com/spfc-tecnico') return article('O técnico do São Paulo, Fulano de Tal, comandou o time no último treino desta semana.')
  if (u.includes('news.google.com')) return new Response('<rss><channel><item><title>Fulano de Tal é o técnico do São Paulo - Fonte Teste</title><link>https://news.example.org/a</link><pubDate>Mon, 05 Oct 2026 12:00:00 GMT</pubDate><source url="https://news.example.org">Fonte Teste</source><description>Fulano de Tal segue como técnico do São Paulo.</description></item></channel></rss>', { status: 200 })
  if (u.includes('bing.com/news')) return new Response('<rss><channel></channel></rss>', { status: 200 })
  throw new Error(`unexpected URL: ${u}`)
}
const current = await searchWeb('Jarvis, quem é o técnico atual do São Paulo?')
assert.equal(current.status, 'ok')
assert.equal(current.confidence, 'alta')
assert.match(current.provider, /gemini_google_search/)
assert.match(current.summary, /DOSSIÊ DE PESQUISA/)
assert.match(current.summary, /RESUMO COM GOOGLE SEARCH/)
assert.match(current.summary, /Fulano de Tal/)
assert.ok(current.sources.some((s) => s.url === 'https://ge.globo.com/sp/futebol/noticia.html'))
assert.ok(current.sources.some((s) => s.url === 'https://example.com/spfc-tecnico'))

// 2c) pergunta geral sem Gemini (403): Wikipedia + DuckDuckGo + leitura da página
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('generativelanguage.googleapis.com')) return json({ error: { message: 'model not available' } }, 403)
  if (u.includes('wikipedia.org/w/api.php')) return wikiPage('Alberto Santos Dumont', 'Alberto Santos Dumont foi um inventor e aeronauta brasileiro, pioneiro da aviação.', 'https://pt.wikipedia.org/wiki/Alberto_Santos_Dumont')
  if (u.includes('html.duckduckgo.com')) return ddgHtml('https://example.com/santos-dumont', 'Santos Dumont — biografia', 'Santos Dumont voou o 14-Bis em Paris, em 1906.')
  if (u === 'https://example.com/santos-dumont') return article('Santos Dumont realizou o voo do 14-Bis em Paris, em 23 de outubro de 1906, diante de testemunhas.')
  throw new Error(`unexpected URL: ${u}`)
}
const general = await searchWeb('quem foi Santos Dumont')
assert.equal(general.status, 'ok')
assert.equal(general.confidence, 'alta')
assert.match(general.summary, /14-Bis em Paris, em 23 de outubro de 1906/)
assert.ok(general.errors.some((e) => /gemini/.test(e)))

// 2d) só a Wikipedia respondeu a uma pergunta atual → confiança baixa, nunca "alta"
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('wikipedia.org/w/api.php')) return wikiPage('Presidente do Brasil', 'O presidente do Brasil é o chefe de Estado e de governo do país.', 'https://pt.wikipedia.org/wiki/Presidente_do_Brasil')
  if (u.includes('html.duckduckgo.com')) return html('<html>anomaly captcha</html>', 202)
  if (u.includes('news.google.com') || u.includes('bing.com/news')) return new Response('', { status: 503 })
  throw new Error(`unexpected URL: ${u}`)
}
const weak = await searchWeb('quem é o presidente do Brasil hoje')
assert.equal(weak.status, 'ok')
assert.equal(weak.confidence, 'baixa')
assert.match(weak.summary, /CONFIANÇA DAS EVIDÊNCIAS: baixa/)

// 2e) nenhuma fonte responde → falha explícita (o JARVIS deve dizer que não confirmou)
globalThis.fetch = async () => { throw new Error('sem rede') }
const none = await searchWeb('assunto totalmente inexistente xyzzy')
assert.equal(none.status, 'failed')
assert.equal(none.confirmedWeb, false)
assert.match(none.message, /sem rede/)

// ---------------------------------------------------------------------------
// 3) roteador: perguntas factuais pesquisam; conversa e comandos não
// ---------------------------------------------------------------------------
if (Number(process.versions.node.split('.')[0]) >= 22) {
  const code = `
    import { routeQuery } from './src/lib/route.ts'
    const cases = [
      ['Jarvis, quem é o técnico do São Paulo?', 'WEB'], ['quem é o dono do Twitter', 'WEB'], ['qual a capital da Austrália', 'WEB'],
      ['quando foi a última copa do mundo', 'WEB'], ['o que é fotossíntese', 'WEB'], ['pesquise sobre buracos negros', 'WEB'],
      ['quanto está o dólar', 'WEB'], ['explique como funciona um buraco negro', 'WEB'], ['vai chover amanhã em Campinas', 'WEB'],
      ['oi jarvis', 'LLM'], ['tudo bem?', 'LLM'], ['quem é você', 'LLM'], ['quanto é 15 x 4', 'LLM'], ['me conte uma piada', 'LLM'],
      ['escreva um poema sobre o mar', 'LLM'], ['obrigado', 'LLM'], ['que horas são', 'SYSTEM'],
      ['abre o whatsapp', 'PHONE'], ['aumenta o volume', 'PHONE'], ['liga a lanterna', 'PHONE'], ['leia minhas mensagens do whatsapp', 'PHONE'],
    ]
    const bad = cases.filter(([t, e]) => routeQuery(t) !== e).map(([t, e]) => t + ' -> ' + routeQuery(t) + ' (esperado ' + e + ')')
    if (bad.length) { console.error(bad.join('\\n')); process.exit(1) }
  `
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' })
  } catch (err) {
    throw new Error(`roteador: ${String(err.stderr || err.message)}`)
  }
} else {
  console.log('(roteador: teste ignorado — requer Node 22+)')
}

// ---------------------------------------------------------------------------
// 4) invariantes estáticas
// ---------------------------------------------------------------------------
globalThis.fetch = originalFetch
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8')
const bridgeSource = await read('../public/phone-bridge.mjs')
assert.match(bridgeSource, /Object\.hasOwn\(ACTIONS, a && a\.a\)/)
assert.match(bridgeSource, /timingSafeEqual/)
assert.match(bridgeSource, /server\.listen\(PORT, '127\.0\.0\.1'/)
assert.match(bridgeSource, /const VERSION = '20\.0\.0'/)
assert.match(bridgeSource, /const PROTOCOL = 2/)
const packageJson = JSON.parse(await read('../package.json'))
const androidGradle = await read('../android/app/build.gradle.kts')
assert.match(androidGradle, new RegExp(`versionName = \"${packageJson.version}\"`))

const appSource = await read('../src/App.tsx')
assert.doesNotMatch(appSource, /Toque para falar/)
assert.doesNotMatch(appSource, /const tapTalk =/)

const example = await read('../.env.example')
assert.match(example, /^GROQ_API_KEYS=/m)
assert.match(example, /^GEMINI_API_KEYS=/m)
assert.doesNotMatch(example, /^VITE_(GROQ|GEMINI|TAVILY|BRAVE)/m)

console.log('JARVIS selftest: PASS')
console.log('1) rotação de chaves + fallback Groq 429 → Gemini')
console.log('2) pesquisa: API exata, grounding, Wikipedia + DuckDuckGo + notícias, confiança baixa, falha explícita')
console.log('3) roteador: perguntas factuais pesquisam, conversa e comandos não')
console.log('4) Phone Bridge, microfone manual e segredos fora do navegador')
