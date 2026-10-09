import { envString, listEnv } from './env.mjs'
import { JARVIS_PROMPT } from './prompt.mjs'

const DEFAULT_GROQ_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']
const DEFAULT_GEMINI_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash']

const PROVIDER_ORDER = listEnv('JARVIS_PROVIDER_ORDER', ['gemini', 'groq'])
const GROQ_MODELS = listEnv('GROQ_MODELS', DEFAULT_GROQ_MODELS)
const GEMINI_MODELS_RAW = listEnv('GEMINI_MODELS', DEFAULT_GEMINI_MODELS)
// Gemini 2.5 endpoints are no longer a safe default for new API projects.
// If an old Vercel variable still contains only 2.5 models, fall back to the
// current free-tier-capable 3.x models instead of surfacing a 404 to the user.
export const GEMINI_MODELS = GEMINI_MODELS_RAW.some((m) => /^gemini-3\./.test(m))
  ? GEMINI_MODELS_RAW
  : DEFAULT_GEMINI_MODELS

const keyPool = (plural, singular) => {
  const many = listEnv(plural)
  if (many.length) return many
  const one = envString(singular)
  return one ? [one] : []
}

const GROQ_KEYS = keyPool('GROQ_API_KEYS', 'GROQ_API_KEY')
const GEMINI_KEYS = keyPool('GEMINI_API_KEYS', 'GEMINI_API_KEY')
const keyCursor = { groq: 0, gemini: 0 }
const temporarilyBlocked = new Map()

function availableKeys(provider) {
  const keys = provider === 'groq' ? GROQ_KEYS : GEMINI_KEYS
  const now = Date.now()
  return keys.map((key, index) => ({ key, index })).filter(({ index }) => (temporarilyBlocked.get(`${provider}:${index}`) || 0) <= now)
}

function orderedKeys(provider) {
  const keys = availableKeys(provider)
  if (!keys.length) return []
  const start = keyCursor[provider] % keys.length
  const rotated = keys.slice(start).concat(keys.slice(0, start))
  keyCursor[provider] = (keyCursor[provider] + 1) % keys.length
  return rotated
}

function markKey(provider, index, status) {
  if (status === 429 || status === 408 || status === 409 || status >= 500) {
    const delay = status === 429 ? 60_000 : 15_000
    temporarilyBlocked.set(`${provider}:${index}`, Date.now() + delay)
  }
}

const asMessages = (messages) => {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 12000) }))
}

const timeoutSignal = (ms, external) => {
  const own = AbortSignal.timeout(ms)
  if (!external) return own
  return AbortSignal.any([own, external])
}

function errorInfo(provider, model, status, message, keyIndex = null) {
  let detail = String(message || `HTTP ${status || 'unknown'}`).replace(/\s+/g, ' ').slice(0, 220)
  for (const secret of [...GROQ_KEYS, ...GEMINI_KEYS]) {
    if (secret) detail = detail.split(secret).join('[SECRET_REDACTED]')
  }
  return { provider, model, status: Number(status || 0), message: detail, keyIndex }
}

async function readProviderError(res) {
  const raw = await res.text().catch(() => '')
  let detail = raw
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error?.message || parsed?.message || raw
  } catch {
    // plain text is already useful
  }
  return String(detail || `HTTP ${res.status}`).slice(0, 220)
}

async function callGroq(messages, model, key, keyIndex, signal) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: JARVIS_PROMPT }, ...messages],
        temperature: 0.5,
        max_tokens: 2048,
      }),
      signal: timeoutSignal(30_000, signal),
    })
    if (!res.ok) {
      markKey('groq', keyIndex, res.status)
      return { ok: false, error: errorInfo('groq', model, res.status, await readProviderError(res), keyIndex) }
    }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: errorInfo('groq', model, res.status, 'resposta vazia ou inválida', keyIndex) }
    return { ok: true, provider: 'groq', model, keyIndex, text: text.trim() }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    markKey('groq', keyIndex, 0)
    return { ok: false, error: errorInfo('groq', model, 0, err?.message || 'falha de rede', keyIndex) }
  }
}

function toGeminiContents(messages) {
  const raw = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  const contents = []
  for (const item of raw) {
    const previous = contents[contents.length - 1]
    if (previous && previous.role === item.role) previous.parts[0].text += `\n${item.parts[0].text}`
    else contents.push(item)
  }
  while (contents.length && contents[0].role !== 'user') contents.shift()
  return contents
}

async function callGemini(messages, model, key, keyIndex, signal) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: JARVIS_PROMPT }] },
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: 2048, temperature: 0.5 },
        // Reduz recusas indevidas em perguntas comuns; conteúdo realmente perigoso continua bloqueado pelo Google.
        safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
      }),
      signal: timeoutSignal(30_000, signal),
    })
    if (!res.ok) {
      markKey('gemini', keyIndex, res.status)
      return { ok: false, error: errorInfo('gemini', model, res.status, await readProviderError(res), keyIndex) }
    }
    const data = await res.json()
    const parts = data?.candidates?.[0]?.content?.parts
    const text = Array.isArray(parts) ? parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('') : ''
    if (!text.trim()) return { ok: false, error: errorInfo('gemini', model, res.status, 'resposta vazia ou inválida', keyIndex) }
    return { ok: true, provider: 'gemini', model, keyIndex, text: text.trim() }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    markKey('gemini', keyIndex, 0)
    return { ok: false, error: errorInfo('gemini', model, 0, err?.message || 'falha de rede', keyIndex) }
  }
}

export function configuredProviders() {
  return PROVIDER_ORDER.filter((p) => (p === 'groq' ? GROQ_KEYS.length > 0 : p === 'gemini' ? GEMINI_KEYS.length > 0 : false))
}

export function providerKeyStatus() {
  return {
    groq: GROQ_KEYS.map((_, index) => ({ index: index + 1, temporarilyBlocked: (temporarilyBlocked.get(`groq:${index}`) || 0) > Date.now() })),
    gemini: GEMINI_KEYS.map((_, index) => ({ index: index + 1, temporarilyBlocked: (temporarilyBlocked.get(`gemini:${index}`) || 0) > Date.now() })),
  }
}

export async function generateWithFallback(messages, { signal, memoryContext = '' } = {}) {
  const safeMessages = asMessages(messages)
  if (!safeMessages.length) throw new Error('A conversa está vazia.')

  const errors = []
  const attempts = []
  const providers = PROVIDER_ORDER.length ? PROVIDER_ORDER : ['gemini', 'groq']

  for (const provider of providers) {
    const models = provider === 'groq' ? GROQ_MODELS : provider === 'gemini' ? GEMINI_MODELS : []
    const keys = orderedKeys(provider)
    if (!models.length || !keys.length) continue

    const augmented = memoryContext
      ? safeMessages.concat([{ role: 'user', content: `\n[MEMÓRIA LOCAL CONFIRMADA]\n${String(memoryContext).slice(0, 7000)}\n[/MEMÓRIA LOCAL CONFIRMADA]` }])
      : safeMessages

    // Try each configured model with each available key. A model 404/400 must not
    // prevent the next compatible model or provider from answering.
    for (const { key, index: keyIndex } of keys) {
      for (const model of models) {
        if (signal?.aborted) throw new DOMException('cancelado', 'AbortError')
        attempts.push({ provider, model, key: keyIndex + 1 })
        const result = provider === 'groq'
          ? await callGroq(augmented, model, key, keyIndex, signal)
          : await callGemini(augmented, model, key, keyIndex, signal)
        if (result.ok) {
          return {
            ...result,
            requestId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            fallback: attempts.length > 1,
            attempts,
            errors,
          }
        }
        errors.push(result.error)
        // Rate limits/network/server failures apply to the key, so move to another key.
        if ([408, 409, 429, 500, 502, 503, 504].includes(result.error.status)) break
      }
    }
  }

  const summary = errors.length
    ? errors.map((e) => `${e.provider}/chave-${e.keyIndex ?? '?'}: ${e.status ? `HTTP ${e.status} ` : ''}${e.message}`).join(' | ')
    : 'Nenhum provedor gratuito configurado.'
  const err = new Error(summary)
  err.code = errors.some((e) => e.status === 401 || e.status === 403) ? 'AUTH' : errors.some((e) => e.status === 429) ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE'
  err.details = { attempts, errors, configured: providerKeyStatus() }
  throw err
}
