import type { WebQueryResult } from '../types/jarvis'
import { sanitizeExternalContent } from './securityGuard'

const TIMEOUT_MS = 4000

export async function queryWikidata(searchTerm: string): Promise<WebQueryResult | null> {
  const q = searchTerm?.trim()
  if (!q) return null
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=pt&uselang=pt&format=json&origin=*`
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const match = (await response.json())?.search?.[0]
    if (!match?.id) return null
    const label = sanitizeExternalContent(String(match.label || q))
    const description = sanitizeExternalContent(String(match.description || 'Entidade do Wikidata'))
    return {
      title: `${label} (${match.id})`,
      summary: `${label}: ${description}`,
      url: `https://www.wikidata.org/wiki/${match.id}`,
      source: 'Wikidata', confirmedWeb: true,
      rawContent: `Entidade: ${label} | ID: ${match.id} | Descrição: ${description}`,
    }
  } catch (error) {
    console.warn('[Wikidata] network/timeout:', error)
    return null
  } finally { clearTimeout(id) }
}
