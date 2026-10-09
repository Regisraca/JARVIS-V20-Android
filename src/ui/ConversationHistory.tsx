import { useEffect, useState } from 'react'
import { createConversation, getCurrentConversation, listConversations } from '../lib/conversations'

function HistoryIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 6.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
    <path d="M7 10h10M7 13h7" />
  </svg>
}

function PlusIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diff <= 0) return 'Hoje'
  if (diff === 1) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function ConversationHistory() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState(() => listConversations())
  const [currentId, setCurrentId] = useState(() => getCurrentConversation().id)

  const refresh = () => {
    setItems(listConversations())
    setCurrentId(getCurrentConversation().id)
  }

  const newConversation = () => {
    const next = createConversation()
    window.dispatchEvent(new CustomEvent('jarvis:new-conversation', { detail: next.id }))
    refresh()
    setOpen(false)
  }

  const openConversation = (id: string) => {
    window.dispatchEvent(new CustomEvent('jarvis:switch-conversation', { detail: id }))
    setCurrentId(id)
    setOpen(false)
  }

  useEffect(() => {
    const onSaved = () => refresh()
    const onOpen = () => { refresh(); setOpen(true) }
    const onNew = () => refresh()
    window.addEventListener('jarvis:conversation-saved', onSaved)
    window.addEventListener('jarvis:open-history', onOpen)
    window.addEventListener('jarvis:new-conversation', onNew)
    window.addEventListener('jarvis:switch-conversation', onSaved)
    return () => {
      window.removeEventListener('jarvis:conversation-saved', onSaved)
      window.removeEventListener('jarvis:open-history', onOpen)
      window.removeEventListener('jarvis:new-conversation', onNew)
      window.removeEventListener('jarvis:switch-conversation', onSaved)
    }
  }, [])

  return (
    <>
      <button
        type="button"
        className={`history-trigger ${open ? 'open' : ''}`}
        onClick={() => { refresh(); setOpen((v) => !v) }}
        aria-label={open ? 'Fechar conversas' : 'Abrir conversas'}
        aria-expanded={open}
      >
        <HistoryIcon />
        <span>CHATS</span>
      </button>

      <aside className={`conversation-drawer ${open ? 'open' : ''}`} aria-label="Conversas">
        <div className="drawer-glow" />
        <div className="drawer-head">
          <div>
            <strong>CHATS</strong>
          </div>
          <div className="drawer-actions">
            <button type="button" onClick={newConversation} aria-label="Nova conversa"><PlusIcon /></button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fechar conversas">×</button>
          </div>
        </div>

        <div className="drawer-list">
          {items.length === 0 && <div className="drawer-empty">Nenhuma conversa salva ainda.</div>}
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`conversation-item ${item.id === currentId ? 'current' : ''}`}
              onClick={() => openConversation(item.id)}
              style={{ ['--delay' as string]: `${Math.min(index, 8) * 35}ms` }}
            >
              <span className="conversation-orb"><HistoryIcon /></span>
              <span className="conversation-copy">
                <b>{item.title || 'Nova conversa'}</b>
                <small>{dayLabel(item.updatedAt)}</small>
              </span>
              {item.id === currentId && <span className="conversation-live" />}
            </button>
          ))}
        </div>

        <button type="button" className="drawer-new" onClick={newConversation}><PlusIcon /> Nova conversa</button>
      </aside>

      {open && <button type="button" className="drawer-backdrop" aria-label="Fechar conversas" onClick={() => setOpen(false)} />}
    </>
  )
}
