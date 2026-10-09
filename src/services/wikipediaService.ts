import type { WebQueryResult } from '../types/jarvis'
import { sanitizeExternalContent } from './securityGuard'

const TIMEOUT_MS = 4000

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try { return await fetch(url, { signal: controller.signal }) } finally { clearTimeout(id) }
}

function format(data: any): WebQueryResult | null {
  if (!data || data.type === 'disambiguation' || !data.extract) return null
  const summary = sanitizeExternalContent(String(data.extract))
  if (!summary) return null
  return {
    title: sanitizeExternalContent(String(data.title || 'Wikipedia')),
    summary,
    url: data.content_urls?.desktop?.page || 'https://pt.wikipedia.org',
    source: 'Wikipedia', confirmedWeb: true, rawContent: summary.slice(0, 1200),
  }
}

export async function queryWikipedia(searchTerm: string): Promise<WebQueryResult | null> {
  const q = searchTerm?.trim()
  if (!q) return null
  try {
    let res = await fetchWithTimeout(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`)
    if (!res.ok) {
      const search = await fetchWithTimeout(`https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&origin=*`)
      if (!search.ok) return null
      const data = await search.json()
      const title = data?.query?.search?.[0]?.title
      if (!title) return null
      res = await fetchWithTimeout(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
    }
    if (!res.ok) return null
    const result = format(await res.json())
    if (result) return result
    // English fallback for names/topics absent from PT Wikipedia.
    const en = await fetchWithTimeout(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`)
    return en.ok ? format(await en.json()) : null
  } catch (error) {
    console.warn('[Wikipedia] network/timeout:', error)
    return null
  }
}
