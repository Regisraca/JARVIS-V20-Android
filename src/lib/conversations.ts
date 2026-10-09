import type { Turn } from '../store'

export type ConversationMessage = Turn & {
  at: number
  conversationId: string
  sources?: Array<{ title: string; url: string }>
  diagnostic?: Record<string, unknown>
}

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ConversationMessage[]
}

const STORE_KEY = 'jarvis.conversations.v15'
const CURRENT_KEY = 'jarvis.currentConversation.v15'
const MAX_CONVERSATIONS = 30
const MAX_MESSAGES = 160

function safeLoad(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages)).slice(0, MAX_CONVERSATIONS)
  } catch {
    return []
  }
}

function saveAll(items: Conversation[]): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, MAX_CONVERSATIONS))) } catch { /* storage may be unavailable */ }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function titleFor(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 44) : 'Nova conversa'
}

export function createConversation(firstText = ''): Conversation {
  const now = Date.now()
  const c: Conversation = { id: newId(), title: titleFor(firstText), createdAt: now, updatedAt: now, messages: [] }
  const all = safeLoad()
  all.unshift(c)
  saveAll(all)
  try { localStorage.setItem(CURRENT_KEY, c.id) } catch {}
  return c
}

export function getCurrentConversation(): Conversation {
  const all = safeLoad()
  let id = ''
  try { id = localStorage.getItem(CURRENT_KEY) || '' } catch {}
  const found = all.find((c) => c.id === id)
  return found || createConversation()
}

export function listConversations(): Conversation[] {
  return safeLoad().map((c) => ({ ...c, messages: [...c.messages] }))
}

export function getConversation(id: string): Conversation | null {
  return safeLoad().find((c) => c.id === id) || null
}

export function setCurrentConversation(id: string): void {
  try { localStorage.setItem(CURRENT_KEY, id) } catch {}
}

export function appendConversationMessage(id: string, turn: Turn, extra: Omit<ConversationMessage, keyof Turn | 'conversationId' | 'at'> = {}): void {
  const all = safeLoad()
  const c = all.find((x) => x.id === id)
  if (!c) return
  const message: ConversationMessage = { ...turn, at: Date.now(), conversationId: id, ...extra }
  c.messages = [...c.messages, message].slice(-MAX_MESSAGES)
  c.updatedAt = Date.now()
  if (c.messages.length === 1 && turn.role === 'user') c.title = titleFor(turn.text)
  saveAll(all)
}

export function replaceConversation(id: string, messages: Turn[]): void {
  const all = safeLoad()
  const c = all.find((x) => x.id === id)
  if (!c) return
  const now = Date.now()
  c.messages = messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, at: now, conversationId: id }))
  c.updatedAt = now
  saveAll(all)
}

export function clearConversation(id: string): void {
  const all = safeLoad()
  const c = all.find((x) => x.id === id)
  if (!c) return
  c.messages = []
  c.title = 'Nova conversa'
  c.updatedAt = Date.now()
  saveAll(all)
}
