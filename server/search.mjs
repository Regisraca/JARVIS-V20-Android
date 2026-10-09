// J.A.R.V.I.S. — pesquisa web gratuita e multi-fonte.
//
// Princípio: o modelo de linguagem NÃO é fonte de fatos. Esta camada busca evidências
// reais na web (sem chave obrigatória), monta um dossiê com fonte/data e o cérebro
// responde somente a partir dele. Se nada confirmar, o resultado é "failed" e o JARVIS
// diz que não conseguiu confirmar — nunca preenche a lacuna com memória do modelo.
//
// Fontes (rodam em paralelo):
//   1. APIs diretas e exatas: cotações, clima, Selic/IPCA, CEP.   (sem chave)
//   2. Wikipedia pt/en com trechos reais e data da última edição.  (sem chave)
//   3. DuckDuckGo (HTML) + leitura das páginas encontradas.        (sem chave)
//   4. Google News + Bing News (RSS) para assuntos atuais.         (sem chave)
//   5. Gemini + Google Search grounding.                            (chave gratuita, opcional)
//   6. Tavily e Brave Search.                                       (chave gratuita, opcional)

import { envString, listEnv } from './env.mjs'
import { GEMINI_MODELS } from './providers.mjs'

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
const BOT_UA = 'JARVIS/20 (+assistente pessoal; pesquisa web)'

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

const clean = (text, max = 6000) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)

function withTimeout(signal, ms) {
  const own = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([own, signal]) : own
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch { return ' ' } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return ' ' } })
}

function stripHtml(text, max = 2000) {
  return clean(decodeEntities(
    String(text || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ), max)
}

function safeExternalUrl(value) {
  try {
    const u = new URL(value)
    if (!/^https?:$/i.test(u.protocol) || u.username || u.password) return null
    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) return null
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return null
    if (h === 'metadata.google.internal' || h === 'metadata.google' || h === 'metadata') return null
    return u.toString()
  } catch { return null }
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }

async function getText(url, { signal, ms = 10_000, headers = {}, method = 'GET', body } = {}) {
  const res = await fetch(url, { method, body, headers, signal: withTimeout(signal, ms), redirect: 'follow' })
  const text = await res.text()
  return { res, text }
}

async function getJson(url, { signal, ms = 10_000, headers = {}, method = 'GET', body, label = 'API' } = {}) {
  const res = await fetch(url, { method, body, headers, signal: withTimeout(signal, ms) })
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`)
  return res.json()
}

// ---------------------------------------------------------------------------
// análise da pergunta
// ---------------------------------------------------------------------------

const STOPWORDS = new Set((
  'a o os as um uma uns umas de do da dos das em no na nos nas por pelo pela para pra com sem sobre entre ate ' +
  'e ou mas que qual quais quem quando onde como quanto quantos quantas porque por que ' +
  'eu voce vc tu ele ela eles elas me te se lhe meu minha seu sua isso isto aquilo esse essa este esta ' +
  'foi era sao ser estar estao tem ter ha houve vai vao pode podem diga fale conte explique ' +
  'atual atualmente agora hoje ontem ultimo ultima ultimos ultimas recente recentes ' +
  'jarvis pesquise pesquisa pesquisar procure busque buscar internet web informacao informacoes'
).split(' '))

const norm = (text) => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

function keywords(query) {
  const seen = new Set()
  const out = []
  for (const raw of norm(query).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw); out.push(raw)
  }
  return out
}

function keywordQuery(query) {
  const raw = String(query || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const kept = raw.filter((w) => w.length >= 3 && !STOPWORDS.has(norm(w)))
  return kept.length >= 1 ? kept.join(' ') : query
}

function isCurrentQuery(query) {
  return /\b(atual|atualmente|agora|hoje|ontem|amanha|recente|recentes|ultim[oa]s?|novo|nova|este ano|esta semana|neste momento|202\d|quem e o|quem e a|campeao|placar|resultado|ganhou|venceu|presidente|prefeito|governador|ministro|tecnico|treinador|cotacao|preco|noticia|noticias|lancamento|estreia|eleicao|eleito)\b/.test(norm(query))
}

export function normalizeWebQuery(query) {
  return String(query || '')
    .replace(/^[\s]*(?:hey|hi|ok|okay|ol[aá]|e a[ií]|ei)?[\s,.:;!?-]*(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv)[\s,.:;!?-]*/i, '')
    .replace(/^(?:por favor[\s,]*)?(?:pesquise|pesquisa|pesquisar|procure|procurar|busque|buscar|busca)[\s]+(?:na|no)[\s]+(?:web|internet)[\s,:-]*/i, '')
    .replace(/^(?:por favor[\s,]*)?(?:na|no)[\s]+(?:web|internet)[\s,:-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?!.]+$/g, '')
    .slice(0, 420)
}

// ---------------------------------------------------------------------------
// relevância
// ---------------------------------------------------------------------------

const OFFICIAL_HOST = /(\.gov(\.[a-z]{2})?$|\.jus\.br$|\.leg\.br$|\.mil(\.[a-z]{2})?$|\.edu(\.[a-z]{2})?$|^who\.int$|^un\.org$)/
const TRUSTED_HOST = /(wikipedia\.org$|britannica\.com$|reuters\.com$|apnews\.com$|bbc\.(com|co\.uk)$|globo\.com$|folha\.uol\.com\.br$|uol\.com\.br$|estadao\.com\.br$|cnnbrasil\.com\.br$|ebc\.com\.br$|espn\.com\.br$|cbf\.com\.br$)/

function scoreItem(item, terms, current) {
  let ratio = 1
  let titleRatio = 1
  if (terms.length) {
    const title = norm(item.title)
    const body = norm(`${item.text || ''} ${item.publisher || ''}`)
    let hit = 0
    let titleHit = 0
    for (const t of terms) {
      if (title.includes(t)) { hit++; titleHit++ } else if (body.includes(t)) hit++
    }
    ratio = hit / terms.length
    titleRatio = titleHit / terms.length
  }
  item._ratio = ratio
  let score = ratio * 50 + titleRatio * 20
  const host = hostOf(item.url)
  if (OFFICIAL_HOST.test(host)) score += 12
  else if (TRUSTED_HOST.test(host)) score += 6
  if (item.provider === 'wikipedia') score += 4
  if (item.text && item.text.length > 200) score += 4
  const time = item.date ? new Date(item.date).getTime() : NaN
  if (Number.isFinite(time)) {
    const age = Date.now() - time
    if (current) {
      if (age <= 2 * 86400000) score += 16
      else if (age <= 14 * 86400000) score += 10
      else if (age <= 90 * 86400000) score += 4
      else if (age > 365 * 86400000) score -= 10
    } else if (age <= 30 * 86400000) score += 2
  }
  return score
}

// ---------------------------------------------------------------------------
// 1. APIs diretas (exatas, sem IA)
// ---------------------------------------------------------------------------

const CRYPTO = [
  [/\b(bitcoin|btc)\b/i, 'bitcoin', 'Bitcoin'],
  [/\b(ethereum|ether|eth)\b/i, 'ethereum', 'Ethereum'],
  [/\b(solana|sol)\b/i, 'solana', 'Solana'],
  [/\b(bnb|binance coin)\b/i, 'binancecoin', 'BNB'],
  [/\b(xrp|ripple)\b/i, 'ripple', 'XRP'],
  [/\b(dogecoin|doge)\b/i, 'dogecoin', 'Dogecoin'],
  [/\b(cardano|ada)\b/i, 'cardano', 'Cardano'],
]
const PRICE_WORDS = /(cota[cç][aã]o|pre[cç]o|valor|quanto|agora|atual|hoje|vale|est[aá])/i

async function cryptoDirect(query, signal) {
  const hit = CRYPTO.find(([re]) => re.test(query))
  if (!hit || !PRICE_WORDS.test(query)) return null
  const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${hit[1]}&vs_currencies=usd,brl&include_last_updated_at=true`, { signal, label: 'CoinGecko' })
  const coin = data?.[hit[1]]
  if (!coin || typeof coin.brl !== 'number') throw new Error('CoinGecko sem cotação')
  const at = typeof coin.last_updated_at === 'number' ? new Date(coin.last_updated_at * 1000).toISOString() : new Date().toISOString()
  const brl = coin.brl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const usd = Number(coin.usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return { provider: 'coingecko', text: `${hit[2]}: R$ ${brl} e US$ ${usd}. Atualizado em ${at} (fonte: CoinGecko).`, sources: [{ title: `CoinGecko — ${hit[2]}`, url: `https://www.coingecko.com/en/coins/${hit[1]}` }] }
}

async function currencyDirect(query, signal) {
  const q = norm(query)
  if (!/\b(dolar|euro|libra)\b/.test(q) || !PRICE_WORDS.test(query)) return null
  const pairs = []
  if (/\bdolar\b/.test(q)) pairs.push('USD-BRL')
  if (/\beuro\b/.test(q)) pairs.push('EUR-BRL')
  if (/\blibra\b/.test(q)) pairs.push('GBP-BRL')
  const data = await getJson(`https://economia.awesomeapi.com.br/json/last/${pairs.join(',')}`, { signal, label: 'AwesomeAPI' })
  const lines = []
  for (const key of Object.keys(data || {})) {
    const c = data[key]
    if (!c?.bid) continue
    lines.push(`${c.name}: compra R$ ${Number(c.bid).toFixed(4).replace('.', ',')}, venda R$ ${Number(c.ask).toFixed(4).replace('.', ',')} (atualizado em ${c.create_date}).`)
  }
  if (!lines.length) throw new Error('AwesomeAPI sem cotação')
  return { provider: 'awesomeapi', text: `${lines.join(' ')} Fonte: AwesomeAPI (cotação de mercado).`, sources: [{ title: 'AwesomeAPI — cotações', url: 'https://docs.awesomeapi.com.br/api-de-moedas' }] }
}

async function weatherDirect(query, signal) {
  if (!/(\bclima\b|\btemperatura\b|\bchuva\b|\bchover\b|previs[aã]o do tempo|como est[aá] o tempo|vai fazer (?:calor|frio))/i.test(query)) return null
  let location = clean(query.replace(/[?!.]+$/g, ''), 180)
  const em = location.match(/\b(?:em|de|para|no|na)\s+([A-ZÀ-Ú][^?!.,]+)$/) || location.match(/\bem\s+(.+)$/i)
  if (em) location = em[1].trim()
  location = location
    .replace(/\b(hoje|agora|amanh[aã]|depois de amanh[aã])\b/gi, ' ')
    .replace(/^(qual|como|vai|est[aá]|me diga|me fala|pesquise|pesquisa|procure|busque|o|a)\s+/i, '')
    .replace(/^(chover|chover[aá]|tempo|clima|temperatura|previs[aã]o do tempo|fazer calor|fazer frio)\s+/i, '')
    .replace(/\s+/g, ' ').trim()
  if (!location || /^(tempo|clima|temperatura|chuva)$/i.test(location)) return null
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=pt&format=json`, { signal, label: 'Open-Meteo Geocoding' })
  const place = geo?.results?.[0]
  if (!place) throw new Error('Open-Meteo não achou a localidade')
  const fc = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto`, { signal, label: 'Open-Meteo' })
  const c = fc?.current
  if (!c) throw new Error('Open-Meteo sem condições atuais')
  const d = fc?.daily
  const days = d?.time?.map((t, i) => `${t}: mín ${d.temperature_2m_min?.[i]}°C, máx ${d.temperature_2m_max?.[i]}°C, chance de chuva ${d.precipitation_probability_max?.[i] ?? '?'}%`).join('; ')
  return {
    provider: 'open-meteo',
    text: `Condições atuais em ${place.name}${place.admin1 ? `, ${place.admin1}` : ''}: ${c.temperature_2m}°C, sensação de ${c.apparent_temperature}°C, umidade ${c.relative_humidity_2m}%, chuva ${c.rain ?? c.precipitation ?? 0} mm, vento ${c.wind_speed_10m} km/h (leitura local: ${c.time}).${days ? ` Próximos dias — ${days}.` : ''}`,
    sources: [{ title: 'Open-Meteo', url: 'https://open-meteo.com/' }],
  }
}

async function bcbDirect(query, signal) {
  const q = norm(query)
  const series = /\bselic\b/.test(q) ? { id: 432, label: 'Meta Selic (% a.a.)' }
    : /\b(ipca|inflacao)\b/.test(q) ? { id: 433, label: 'IPCA (variação mensal, %)' }
      : null
  if (!series) return null
  const data = await getJson(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series.id}/dados/ultimos/1?formato=json`, { signal, label: 'Banco Central' })
  const item = data?.[0]
  if (!item) throw new Error('Banco Central sem dado')
  return { provider: 'bcb-sgs', text: `${series.label}: ${item.valor} (data da série: ${item.data}). Fonte oficial: Banco Central do Brasil.`, sources: [{ title: `Banco Central — SGS ${series.id}`, url: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series.id}/dados/ultimos/1?formato=json` }] }
}

async function cepDirect(query, signal) {
  const cep = query.match(/\b\d{5}-?\d{3}\b/)?.[0]
  if (!cep || !/(cep|endere[cç]o|rua|bairro)/i.test(query)) return null
  const digits = cep.replace(/\D/g, '')
  const r = await getJson(`https://brasilapi.com.br/api/cep/v1/${digits}`, { signal, label: 'BrasilAPI' })
  return { provider: 'brasilapi', text: `CEP ${r.cep}: ${r.street || ''}, ${r.neighborhood || ''}, ${r.city || ''}/${r.state || ''}.`, sources: [{ title: 'BrasilAPI — CEP', url: `https://brasilapi.com.br/api/cep/v1/${digits}` }] }
}

async function directApis(query, signal, errors) {
  for (const fn of [cryptoDirect, currencyDirect, bcbDirect, cepDirect, weatherDirect]) {
    try {
      const r = await fn(query, signal)
      if (r) return r
    } catch (err) {
      if (err?.name === 'AbortError' && signal?.aborted) throw err
      errors.push(err?.message || 'API direta falhou')
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 2. Wikipedia
// ---------------------------------------------------------------------------

async function wikipediaPages(query, lang, signal) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&utf8=1&generator=search&gsrnamespace=0&gsrlimit=5&gsrsearch=${encodeURIComponent(query)}&prop=extracts%7Cinfo&exintro=1&explaintext=1&exchars=1200&exlimit=max&inprop=url`
  const data = await getJson(url, { signal, label: `Wikipedia ${lang}`, headers: { 'User-Agent': BOT_UA } })
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 99) - (b.index || 99))
  const items = []
  for (const p of pages) {
    const text = clean(p.extract, 1200)
    if (!text || (/(pode referir-se a|may refer to|desambigua)/i.test(text.slice(0, 200)) && text.length < 300)) continue
    items.push({
      title: clean(p.title, 200),
      url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(p.title).replace(/ /g, '_'))}`,
      text,
      date: p.touched || '',
      publisher: `Wikipedia (${lang})`,
      provider: 'wikipedia',
      dateLabel: p.touched ? `última edição da página: ${String(p.touched).slice(0, 10)}` : '',
    })
  }
  return items
}

async function wikipediaSearch(query, signal) {
  const kw = keywordQuery(query)
  let items = await wikipediaPages(kw, 'pt', signal)
  if (!items.length && kw !== query) items = await wikipediaPages(query, 'pt', signal)
  if (!items.length) items = await wikipediaPages(kw, 'en', signal)
  return items
}

// ---------------------------------------------------------------------------
// 3. DuckDuckGo (HTML) + leitura das páginas
// ---------------------------------------------------------------------------

function parseDuckDuckGo(html) {
  const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
  const out = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    const href = decodeEntities(a[0].match(/href="([^"]+)"/i)?.[1] || '')
    let target = href
    try {
      const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com')
      target = u.searchParams.get('uddg') || u.toString()
    } catch { continue }
    const url = safeExternalUrl(target)
    if (!url || /(^|\.)duckduckgo\.com$/.test(hostOf(url))) continue
    const end = anchors[i + 1]?.index ?? html.length
    const chunk = html.slice(a.index + a[0].length, end)
    const snippet = stripHtml(chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i)?.[1] || '', 500)
    out.push({ title: stripHtml(a[1], 220), url, snippet })
    if (out.length >= 8) break
  }
  return out
}

function metaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key}["']`, 'i'),
  ]
  for (const re of patterns) { const m = html.match(re); if (m?.[1]) return stripHtml(m[1], 600) }
  return ''
}

function pageEvidence(html, terms) {
  const title = metaContent(html, 'og:title') || stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '', 220)
  const description = metaContent(html, 'og:description') || metaContent(html, 'description')
  let date = metaContent(html, 'article:published_time') || metaContent(html, 'article:modified_time') || metaContent(html, 'og:updated_time') || metaContent(html, 'datePublished') || metaContent(html, 'dateModified')
  let articleBody = ''
  for (const jm of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(jm[1].trim())
      const nodes = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((n) => (Array.isArray(n?.['@graph']) ? n['@graph'] : [n]))
      for (const n of nodes) {
        if (!date) date = n?.dateModified || n?.datePublished || ''
        if (!articleBody && typeof n?.articleBody === 'string') articleBody = stripHtml(n.articleBody, 2500)
      }
    } catch { /* JSON-LD malformado é comum */ }
  }
  const main = html.replace(/<(nav|header|footer|aside|form|svg|figure)\b[\s\S]*?<\/\1>/gi, ' ')
  const paragraphs = []
  const seen = new Set()
  for (const m of main.matchAll(/<(?:p|li|h2|h3)\b[^>]*>([\s\S]*?)<\/(?:p|li|h2|h3)>/gi)) {
    const t = stripHtml(m[1], 700)
    if (t.length < 60 || seen.has(t)) continue
    seen.add(t); paragraphs.push(t)
    if (paragraphs.length >= 60) break
  }
  const scored = paragraphs.map((t, index) => {
    const n = norm(t)
    let hit = 0
    for (const term of terms) if (n.includes(term)) hit++
    return { t, index, hit }
  })
  let chosen = scored.filter((p) => p.hit > 0).sort((a, b) => b.hit - a.hit || a.index - b.index).slice(0, 4).sort((a, b) => a.index - b.index)
  if (!chosen.length) chosen = scored.slice(0, 3)
  let body = chosen.map((p) => p.t).join(' ')
  if (articleBody && body.length < 600) body = `${articleBody} ${body}`
  return { title, description, date: clean(date, 40), body: clean(body || description, 1600) }
}

async function readPage(url, terms, signal) {
  const safe = safeExternalUrl(url)
  if (!safe) return null
  try {
    const { res, text } = await getText(safe, { signal, ms: 7_000, headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.6' } })
    if (!res.ok || !safeExternalUrl(res.url || safe)) return null
    if (!/text\/html|application\/xhtml/i.test(String(res.headers.get('content-type') || ''))) return null
    return { finalUrl: res.url || safe, ...pageEvidence(text.slice(0, 1_500_000), terms) }
  } catch (err) {
    if (err?.name === 'AbortError' && signal?.aborted) throw err
    return null
  }
}

async function duckDuckGoSearch(query, terms, signal) {
  const { res, text } = await getText('https://html.duckduckgo.com/html/', {
    signal, ms: 9_000, method: 'POST',
    headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Language': 'pt-BR,pt;q=0.9', Referer: 'https://html.duckduckgo.com/' },
    body: new URLSearchParams({ q: query, kl: 'br-pt' }).toString(),
  })
  if (res.status === 202 || /anomaly|captcha|unusual traffic/i.test(text.slice(0, 4000))) throw new Error('DuckDuckGo bloqueou a consulta (captcha)')
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`)
  const results = parseDuckDuckGo(text)
  if (!results.length) throw new Error('DuckDuckGo sem resultados')
  const pages = await Promise.all(results.slice(0, 4).map((r) => readPage(r.url, terms, signal)))
  return results.map((r, i) => {
    const page = pages[i]
    const body = page?.body || ''
    const merged = body && r.snippet && !body.includes(r.snippet.slice(0, 40)) ? `${r.snippet} ${body}` : (body || r.snippet)
    return {
      title: clean(page?.title || r.title, 220),
      url: page?.finalUrl || r.url,
      text: clean(merged, 1700),
      date: page?.date || '',
      publisher: hostOf(page?.finalUrl || r.url),
      provider: 'duckduckgo',
    }
  })
}

// ---------------------------------------------------------------------------
// 4. Notícias (RSS)
// ---------------------------------------------------------------------------

function rssItems(xml) {
  const items = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const get = (tag) => decodeEntities(block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '').trim()
    const title = stripHtml(get('title'), 300)
    let link = get('link')
    const publisher = stripHtml(get('source') || get('News:Source'), 120)
    const date = get('pubDate')
    const description = stripHtml(get('description'), 600)
    try {
      const u = new URL(link)
      if (/bing\.com$/.test(u.hostname) && u.searchParams.get('url')) link = u.searchParams.get('url')
    } catch { /* mantém o link original */ }
    if (title && /^https?:\/\//i.test(link)) items.push({ title, url: link, publisher, date, description })
    if (items.length >= 12) break
  }
  return items
}

async function newsFeed(url, provider, signal) {
  const { res, text } = await getText(url, { signal, ms: 9_000, headers: { 'User-Agent': BOT_UA } })
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}`)
  const items = rssItems(text)
  if (!items.length) throw new Error(`${provider} sem resultados`)
  return items.map((it) => {
    const title = it.publisher && it.title.endsWith(` - ${it.publisher}`) ? it.title.slice(0, -(it.publisher.length + 3)) : it.title
    const sameAsTitle = !it.description || norm(it.description).startsWith(norm(title).slice(0, 30))
    return { title, url: it.url, text: sameAsTitle ? '' : it.description, date: it.date, publisher: it.publisher || hostOf(it.url), provider }
  })
}

async function newsSearch(query, signal) {
  const q = encodeURIComponent(keywordQuery(query))
  const feeds = await Promise.allSettled([
    newsFeed(`https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`, 'google_news', signal),
    newsFeed(`https://www.bing.com/news/search?q=${q}&format=rss&setlang=pt-BR&cc=BR`, 'bing_news', signal),
  ])
  const items = feeds.flatMap((f) => (f.status === 'fulfilled' ? f.value : []))
  if (!items.length) throw new Error(feeds.map((f) => f.reason?.message).filter(Boolean).join(' | ') || 'notícias sem resultados')
  return items
}

// ---------------------------------------------------------------------------
// 5. Gemini + Google Search grounding (opcional, chave gratuita)
// ---------------------------------------------------------------------------

const GEMINI_KEYS = (() => {
  const a = listEnv('GEMINI_SEARCH_API_KEYS'); if (a.length) return a
  const b = listEnv('GEMINI_API_KEYS'); if (b.length) return b
  const c = envString('GEMINI_API_KEY'); return c ? [c] : []
})()
const SEARCH_MODELS = [...new Set([...listEnv('GEMINI_SEARCH_MODELS'), ...GEMINI_MODELS, 'gemini-2.5-flash'])]
const deadModels = new Map() // modelo sem suporte a grounding nesta conta → não insistir por 30 min
const blockedKeys = new Map()
let keyCursor = 0

function groundingSources(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks
  if (!Array.isArray(chunks)) return []
  const seen = new Set(); const out = []
  for (const c of chunks) {
    const url = clean(c?.web?.uri, 1000)
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url); out.push({ title: clean(c?.web?.title, 300) || url, url })
    if (out.length >= 8) break
  }
  return out
}

async function geminiGrounding(query, signal) {
  if (!GEMINI_KEYS.length) throw new Error('sem chave Gemini (pesquisa do Google desativada)')
  const now = Date.now()
  const keys = GEMINI_KEYS.map((key, index) => ({ key, index })).filter(({ index }) => (blockedKeys.get(index) || 0) <= now)
  const models = SEARCH_MODELS.filter((m) => (deadModels.get(m) || 0) <= now)
  if (!keys.length) throw new Error('chaves Gemini em pausa (limite)')
  if (!models.length) throw new Error('nenhum modelo Gemini com Google Search nesta conta')
  const start = keyCursor++ % keys.length
  const ordered = keys.slice(start).concat(keys.slice(0, start))
  let last = 'sem resposta'
  let attempts = 0
  for (const { key, index } of ordered) {
    for (const model of models) {
      if (attempts++ >= 3) throw new Error(last)
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `Use a pesquisa do Google agora. Responda em português do Brasil, só com fatos confirmados nas fontes encontradas, com datas e números exatos. Não use memória interna como evidência. Se as fontes divergirem ou não confirmarem, diga isso.\nPergunta: ${query}` }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1400 },
          }),
          signal: withTimeout(signal, 14_000),
        })
        if (!res.ok) {
          const body = clean(await res.text().catch(() => ''), 160)
          last = `Gemini ${model} HTTP ${res.status}: ${body}`
          if (res.status === 429) { blockedKeys.set(index, Date.now() + 60_000); break }
          if (res.status === 404 || res.status === 403 || res.status === 400) deadModels.set(model, Date.now() + 30 * 60_000)
          continue
        }
        const data = await res.json()
        const cand = data?.candidates?.[0]
        const parts = cand?.content?.parts
        const summary = Array.isArray(parts) ? parts.filter((p) => !p?.thought).map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim() : ''
        const sources = groundingSources(cand)
        if (!summary) { last = `Gemini ${model} sem texto (${cand?.finishReason || 'vazio'})`; continue }
        if (!sources.length) { last = `Gemini ${model} respondeu sem fontes do Google`; continue }
        return { summary: clean(summary, 1800), sources, model }
      } catch (err) {
        if (err?.name === 'AbortError' && signal?.aborted) throw err
        last = err?.message || 'falha de rede'
      }
    }
  }
  throw new Error(last)
}

// ---------------------------------------------------------------------------
// 6. Tavily / Brave (opcionais, planos gratuitos com chave)
// ---------------------------------------------------------------------------

async function tavilySearch(query, signal) {
  const key = envString('TAVILY_API_KEY')
  if (!key) return null
  const data = await getJson('https://api.tavily.com/search', {
    signal, ms: 12_000, method: 'POST', label: 'Tavily',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 6, topic: isCurrentQuery(query) ? 'news' : 'general' }),
  })
  return (data?.results || []).map((r) => {
    const url = safeExternalUrl(r.url)
    return url ? { title: clean(r.title, 220), url, text: clean(r.content, 1200), date: r.published_date || '', publisher: hostOf(url), provider: 'tavily' } : null
  }).filter(Boolean)
}

async function braveSearch(query, signal) {
  const key = envString('BRAVE_API_KEY')
  if (!key) return null
  const data = await getJson(`https://api.search.brave.com/res/v1/web/search?count=8&country=br&search_lang=pt&q=${encodeURIComponent(query)}`, {
    signal, ms: 10_000, label: 'Brave', headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  })
  return (data?.web?.results || []).map((r) => {
    const url = safeExternalUrl(r.url)
    return url ? { title: stripHtml(r.title, 220), url, text: stripHtml(`${r.description || ''} ${(r.extra_snippets || []).join(' ')}`, 1200), date: r.page_age || '', publisher: hostOf(url), provider: 'brave' } : null
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// montagem do dossiê
// ---------------------------------------------------------------------------

function dossier({ query, items, groundingText, confidence }) {
  const today = new Date().toISOString().slice(0, 10)
  const head = `DOSSIÊ DE PESQUISA NA WEB — data de hoje: ${today}. Consulta: "${query}". CONFIANÇA DAS EVIDÊNCIAS: ${confidence}.\n` +
    'REGRAS: responda SOMENTE com o que as evidências abaixo sustentam; informe a data/fonte quando houver; se as fontes divergirem, diga; ' +
    'se as evidências não responderem à pergunta, diga claramente que não foi possível confirmar — não complete com memória do modelo.'
  const lines = []
  if (groundingText) lines.push(`RESUMO COM GOOGLE SEARCH (escrito por IA a partir de fontes reais — confira com as evidências):\n${groundingText}`)
  items.forEach((it, i) => {
    const when = it.dateLabel || (it.date ? `data: ${clean(it.date, 40)}` : '')
    lines.push(`[${i + 1}] ${it.title}${it.publisher ? ` | fonte: ${it.publisher}` : ''}${when ? ` | ${when}` : ''}\n    ${it.text || '(sem trecho; só o título)'}\n    URL: ${it.url}`)
  })
  const out = `${head}\n${lines.join('\n')}`
  return out.length > 9000 ? `${out.slice(0, 9000)}…` : out
}

function dedupe(items) {
  const seen = new Set(); const out = []
  for (const it of items) {
    const key = `${hostOf(it.url)}|${norm(it.title).replace(/\W+/g, ' ').slice(0, 80)}`
    if (seen.has(key) || seen.has(it.url)) continue
    seen.add(key); seen.add(it.url); out.push(it)
  }
  return out
}

// ---------------------------------------------------------------------------
// entrada principal
// ---------------------------------------------------------------------------

export async function searchWeb(query, { signal } = {}) {
  const originalQuery = clean(query, 500)
  const q = normalizeWebQuery(originalQuery) || originalQuery
  if (!q) throw new Error('Consulta web vazia.')

  const errors = []
  const note = (label) => (err) => {
    if (err?.name === 'AbortError' && signal?.aborted) throw err
    errors.push(`${label}: ${err?.message || 'falhou'}`)
    return null
  }
  const overall = withTimeout(signal, 24_000)
  const terms = keywords(q)
  const current = isCurrentQuery(q)

  // 1) Dados exatos de APIs oficiais/públicas: se houver, é a melhor evidência possível.
  const direct = await directApis(q, overall, errors)
  if (direct) {
    return {
      status: 'ok', query: q, confirmedWeb: true, confidence: 'alta', provider: direct.provider,
      summary: `DADO EXATO DE API PÚBLICA (data de hoje: ${new Date().toISOString().slice(0, 10)}). Use exatamente estes valores e cite a fonte e o horário da leitura:\n${direct.text}`,
      sources: direct.sources, errors,
    }
  }

  // 2) Todas as fontes gerais em paralelo.
  const tasks = [
    wikipediaSearch(q, overall).catch(note('wikipedia')),
    duckDuckGoSearch(q, terms, overall).catch(note('duckduckgo')),
    geminiGrounding(q, overall).catch(note('gemini')),
    tavilySearch(q, overall).catch(note('tavily')),
    braveSearch(q, overall).catch(note('brave')),
    current ? newsSearch(q, overall).catch(note('notícias')) : Promise.resolve(null),
  ]
  const [wiki, ddg, grounding, tavily, brave, news] = await Promise.all(tasks)

  let pool = [...(wiki || []), ...(ddg || []), ...(tavily || []), ...(brave || []), ...(news || [])]
  const minRatio = terms.length >= 3 ? 0.34 : 0.5
  const rank = (list) => dedupe(list)
    .map((it) => ({ it, score: scoreItem(it, terms, current) }))
    .filter(({ it }) => it._ratio >= minRatio)
    .sort((a, b) => b.score - a.score)
  let ranked = rank(pool)

  // 3) Segunda chance: nada relevante e as notícias ainda não rodaram.
  if (!ranked.length && !current && !grounding) {
    const extra = await newsSearch(q, overall).catch(note('notícias'))
    if (extra) { pool = pool.concat(extra); ranked = rank(pool) }
  }

  const top = ranked.slice(0, 8).map(({ it }) => it)
  if (!top.length && !grounding) {
    return { status: 'failed', query: q, confirmedWeb: false, message: errors.filter(Boolean).join(' | ') || 'nenhuma fonte retornou evidência relevante para a pergunta', errors }
  }

  const sources = []
  const seenUrl = new Set()
  for (const s of [...(grounding?.sources || []), ...top.map((it) => ({ title: it.title, url: it.url }))]) {
    if (seenUrl.has(s.url)) continue
    seenUrl.add(s.url); sources.push(s)
    if (sources.length >= 8) break
  }

  // 4) Confiança: quantas fontes independentes sustentam o assunto.
  const strong = top.filter((it) => it._ratio >= 0.5)
  const providers = new Set(strong.map((it) => it.provider))
  const hosts = new Set(strong.map((it) => hostOf(it.url)))
  let confidence = 'baixa'
  if (grounding || (providers.size >= 2 && hosts.size >= 2)) confidence = 'alta'
  else if (strong.length && (hosts.size >= 2 || strong.some((it) => OFFICIAL_HOST.test(hostOf(it.url))))) confidence = 'média'
  if (current && !grounding && !top.some((it) => it.provider !== 'wikipedia')) confidence = 'baixa'

  const used = [...new Set([...(grounding ? ['gemini_google_search'] : []), ...top.map((it) => it.provider)])]
  return {
    status: 'ok', query: q, confirmedWeb: true, confidence, provider: used.join('+'),
    summary: dossier({ query: q, items: top, groundingText: grounding?.summary, confidence }),
    sources, errors,
  }
}
