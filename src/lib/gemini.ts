import { stash as stashAction } from './phone'
import { stashWebSearch } from './web'
import { stashSystem } from './system'
import { contextBlock, remember, forget, clearMemories, isMemoryKind } from './memory'
import { cancelActiveTasks } from './tasks'

export type Msg = { role: 'user' | 'assistant'; content: string }
export type AskHandlers = { onText: (delta: string) => void; onTool: (name: string) => void }
export type BrainDiagnostic = {
  provider: string
  model: string
  fallback: boolean
  requestId: string
  attempts: Array<{ provider: string; model: string }>
  errors: Array<{ provider: string; model: string; status: number; message: string }>
}

let active: AbortController | null = null
let generation = 0
let memQuery = ''
let lastDiagnostic: BrainDiagnostic | null = null

export function getLastBrainDiagnostic(): BrainDiagnostic | null { return lastDiagnostic }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && 'type' in b && b.type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('')
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown> } catch { return {} }
}

export async function warm(): Promise<void> {
  const res = await fetch('/api/health', { signal: AbortSignal.timeout(10_000), cache: 'no-store' })
  const body = await readJson(res)
  if (!body.ok) {
    const providers = Array.isArray(body.providers) ? body.providers.join(', ') : ''
    throw new Error(providers ? `Provedores configurados: ${providers}.` : 'Nenhum provedor de IA configurado. Configure GROQ_API_KEY e/ou GEMINI_API_KEY no ambiente do servidor.')
  }
  lastDiagnostic = null
}

export function connectedLabels(): string[] {
  return lastDiagnostic?.provider ? [lastDiagnostic.provider.toUpperCase()] : ['JARVIS API']
}

export function cancel(): void {
  generation++
  active?.abort()
  stashAction(null)
  stashWebSearch(null)
  stashSystem(null)
  cancelActiveTasks('interrompida pelo usuário')
}

/**
 * Keeps machine-readable blocks out of the spoken transcript, then validates and
 * stashes their requested tools. External data can never directly execute tools.
 */
export async function ask(
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[]; diagnostic: BrainDiagnostic | null }> {
  let held = ''
  let block: string | null = null
  let clean = ''
  const out = (t: string) => {
    if (!t) return
    clean += t
    handlers.onText(t)
  }
  const filtered: AskHandlers = {
    ...handlers,
    onText: (delta) => {
      if (block !== null) { block += delta; return }
      held += delta
      const i = held.indexOf('[[')
      if (i >= 0) {
        out(held.slice(0, i))
        block = held.slice(i)
        held = ''
        return
      }
      const keep = held.endsWith('[') ? 1 : 0
      out(held.slice(0, held.length - keep))
      held = held.slice(Math.max(0, held.length - keep))
    },
  }

  stashAction(null)
  stashWebSearch(null)
  stashSystem(null)
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  memQuery = lastUser ? textOf(lastUser.content).slice(0, 300) : ''
  const res = await askRaw(history, filtered)
  if (block === null) out(held)

  const blockText = block
  if (blockText) {
    for (const match of blockText.matchAll(/\[\[(ACAO|MEMORIA|ESQUECER|WEB|SYSTEM)\s*([\s\S]*?)\]\]/g)) {
      const kind = match[1]
      try {
        const payload = JSON.parse(match[2]) as Record<string, unknown>
        if (kind === 'ACAO' && typeof payload.a === 'string') stashAction(payload as { a: string } & Record<string, unknown>)
        else if (kind === 'WEB' && ['web_search', 'wikipedia_search', 'wikidata_search'].includes(String(payload.a)) && typeof payload.q === 'string') {
          stashWebSearch(payload.q, payload.a as 'web_search' | 'wikipedia_search' | 'wikidata_search')
          handlers.onTool('web_search')
        } else if (kind === 'SYSTEM' && typeof payload.a === 'string') {
          stashSystem(payload as { a: string } & Record<string, unknown>)
          handlers.onTool(`system_${payload.a}`)
        } else if (kind === 'MEMORIA' && typeof payload.texto === 'string') {
          remember(payload.texto, { kind: isMemoryKind(payload.tipo) ? payload.tipo : undefined, days: typeof payload.dias === 'number' ? payload.dias : undefined })
        } else if (kind === 'ESQUECER') {
          if (payload.tudo === true) clearMemories()
          else if (typeof payload.texto === 'string') forget(payload.texto)
        }
      } catch {
        // Invalid machine blocks are ignored rather than executed.
      }
    }
  }
  return { text: clean.trim(), tools: res.tools, diagnostic: lastDiagnostic }
}

async function askRaw(history: Msg[], handlers: AskHandlers): Promise<{ text: string; tools: string[] }> {
  active?.abort()
  const myGen = ++generation
  const cancelled = () => myGen !== generation
  const controller = new AbortController()
  active = controller
  const release = () => { if (active === controller) active = null }

  const messages = history
    .map((m) => ({ role: m.role, content: textOf(m.content) }))
    .filter((m) => m.content)
    .slice(-24)
  const memoryContext = contextBlock(memQuery)

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, memoryContext }),
      signal: controller.signal,
    })
    const body = await readJson(res)
    if (cancelled()) return { text: '', tools: [] }
    if (!res.ok) {
      const detail = typeof body.error === 'string' ? body.error : `API HTTP ${res.status}`
      throw new Error(detail)
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new Error('O orquestrador não recebeu texto de nenhum provedor.')
    lastDiagnostic = {
      provider: String(body.provider || 'unknown'),
      model: String(body.model || 'unknown'),
      fallback: Boolean(body.fallback),
      requestId: String(body.requestId || ''),
      attempts: Array.isArray(body.attempts) ? body.attempts as BrainDiagnostic['attempts'] : [],
      errors: Array.isArray(body.errors) ? body.errors as BrainDiagnostic['errors'] : [],
    }
    handlers.onText(text)
    return { text, tools: [] }
  } catch (err) {
    if (cancelled() || (err instanceof DOMException && err.name === 'AbortError')) return { text: '', tools: [] }
    release()
    throw err
  } finally {
    release()
  }
}
