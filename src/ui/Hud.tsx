import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useStore, accentFor, type Phase, type Turn } from '../store'
import { Blades } from './Blades'
import { Effects } from './Effects'
import { Pointer } from './Pointer'
import { Suggestions } from './Suggestions'
import { GestureGuide } from './GestureGuide'
import { createConversation } from '../lib/conversations'

const statusText: Record<Phase, string> = {
  offline: 'OFFLINE',
  boot: 'INICIALIZANDO',
  dormant: 'ONLINE',
  waking: 'ONLINE',
  listening: 'OUVINDO',
  thinking: 'PROCESSANDO',
  tooling: 'EXECUTANDO',
  speaking: 'RESPONDENDO',
}

function Icon({ name }: { name: 'bubble' | 'mic' | 'phone' | 'file' | 'sequence' | 'memory' | 'web' | 'link' | 'camera' | 'bolt' | 'chat' | 'grid' | 'user' | 'settings' | 'send' | 'close' | 'plus' | 'down' }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const paths: Record<string, ReactNode> = {
    bubble: <><path d="M5 6.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"/><path d="M7 10h10M7 13h7"/></>,
    mic: <><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></>,
    phone: <><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 5h4M11 18.5h2"/></>,
    file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 15h6M9 18h4"/></>,
    sequence: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="18" r="2"/><path d="M8 6h4a4 4 0 0 1 4 4v0M16 14a4 4 0 0 1-4 4H8"/></>,
    memory: <><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></>,
    web: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    link: <><path d="M10 13.5a4 4 0 0 0 5.8.2l2.2-2.2a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10.5a4 4 0 0 0-5.8-.2L6 12.5a4 4 0 0 0 5.7 5.7l1.3-1.3"/></>,
    camera: <><path d="M4 7h3l1.5-2h7L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></>,
    bolt: <path d="m13 2-8 11h6l-1 9 8-12h-6z"/>,
    chat: <><path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12h5"/></>,
    grid: <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    user: <><circle cx="12" cy="8" r="3"/><path d="M5 21a7 7 0 0 1 14 0"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .35 2l.05.05-1.4 1.4-.05-.05a1.8 1.8 0 0 0-2-.35 1.8 1.8 0 0 0-1.1 1.65V20h-2v-.3a1.8 1.8 0 0 0-1.1-1.65 1.8 1.8 0 0 0-2 .35l-.05.05-1.4-1.4.05-.05a1.8 1.8 0 0 0 .35-2A1.8 1.8 0 0 0 7.45 14H7v-2h.45a1.8 1.8 0 0 0 1.65-1.1 1.8 1.8 0 0 0-.35-2l-.05-.05 1.4-1.4.05.05a1.8 1.8 0 0 0 2 .35A1.8 1.8 0 0 0 13.25 6V5h2v1a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 2-.35l.05-.05 1.4 1.4-.05.05a1.8 1.8 0 0 0-.35 2 1.8 1.8 0 0 0 1.65 1.1h.45v2h-.45A1.8 1.8 0 0 0 19.4 15Z"/></>,
    send: <><path d="m3 11 18-8-8 18-2-8z"/><path d="m11 13 4-4"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    down: <><path d="m6 9 6 6 6-6"/></>,
  }
  return <svg {...common}>{paths[name]}</svg>
}

/** Technical diagnostics stay out of the normal phone UI; they open only in dev builds, with ?dev, or with localStorage jarvis:dev=1. */
function isDevMode(): boolean {
  try {
    return import.meta.env.DEV || new URLSearchParams(window.location.search).has('dev') || window.localStorage.getItem('jarvis:dev') === '1'
  } catch { return false }
}

function HologramFace({ phase, level, error }: { phase: Phase; level: number; error: boolean }) {
  const active = phase === 'listening' || phase === 'speaking'
  return (
    <div
      className={`jarvis-face phase-${phase}${error ? ' is-error' : ''}`}
      style={{ '--lvl': level.toFixed(2) } as CSSProperties}
      aria-label={`J.A.R.V.I.S. ${statusText[phase]}`}
    >
      <div className="face-motes" aria-hidden="true">{Array.from({ length: 7 }).map((_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>
      <div className="face-scan" /><div className="face-grid" />
      <div className="face-ear left" aria-hidden="true" /><div className="face-ear right" aria-hidden="true" />
      <div className="face-head">
        <div className="face-antenna" /><div className="face-brow left" /><div className="face-brow right" />
        <div className="face-eye left" style={{ opacity: 0.7 + level * 0.3 }} /><div className="face-eye right" style={{ opacity: 0.7 + level * 0.3 }} />
        <div className="face-nose" /><div className="face-cheek left" /><div className="face-cheek right" /><div className="face-jaw" />
        <div className={`face-mouth ${active ? 'active' : ''}`} />
      </div>
      <div className="face-core"><Icon name="bolt" /></div>
      <span className="face-live-label">J.A.R.V.I.S.</span>
    </div>
  )
}

function DecodeText({ text }: { text: string }) {
  const reduced = useReducedMotion()
  const settled = useRef(0)
  const raf = useRef(0)
  const latest = useRef(text)
  const [tick, bump] = useState(0)
  const glyphs = '/\\|<>[]{}=+*#%&$0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  useEffect(() => {
    latest.current = text
    if (reduced) { settled.current = text.length; bump((n) => n + 1); return }
    if (raf.current || settled.current >= text.length) return
    let last = performance.now()
    const step = (now: number) => {
      const target = latest.current
      if (settled.current >= target.length) { raf.current = 0; bump((n) => n + 1); return }
      if (now - last >= 36) {
        const lag = target.length - settled.current
        settled.current = Math.min(target.length, settled.current + Math.max(1, Math.ceil(lag / 7)))
        last = now; bump((n) => n + 1)
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf.current); raf.current = 0 }
  }, [text, reduced])
  const shown = text.slice(0, settled.current)
  const pending = text.slice(settled.current)
  const scramble = pending.split('').map((c, i) => c === ' ' ? ' ' : glyphs[(i * 17 + tick * 7 + c.charCodeAt(0)) % glyphs.length]).join('')
  return <>{shown}{scramble}</>
}

function safeMediaUrl(value: string): string | null {
  if (value.startsWith('blob:') || value.startsWith('data:')) return value
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch { return null }
}

function mediaKind(url: string): 'image' | 'video' | 'audio' | null {
  const clean = url.split('?')[0].toLowerCase()
  if (url.startsWith('blob:') || /\.(png|jpe?g|gif|webp|avif|svg|heic|heif)$/.test(clean)) return 'image'
  if (/\.(mp4|webm|mov|m4v)$/.test(clean)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|aac)$/.test(clean)) return 'audio'
  return null
}

type ZoomTarget = { url: string; title: string }

function MediaPreview({ turn, onZoom, onLoaded }: { turn: Turn; onZoom: (z: ZoomTarget) => void; onLoaded: () => void }) {
  const items: Array<{ url: string; kind: 'image' | 'video' | 'audio'; title: string }> = []
  const seen = new Set<string>()
  for (const media of turn.media ?? []) {
    if (!seen.has(media.url)) { seen.add(media.url); items.push({ url: media.url, kind: media.kind, title: media.title || 'Foto' }) }
  }
  for (const source of turn.sources ?? []) {
    const u = safeMediaUrl(source.url); const kind = u ? mediaKind(u) : null
    if (u && kind && !seen.has(u)) { seen.add(u); items.push({ url: u, kind, title: source.title || 'Imagem' }) }
  }
  if (!items.length) return null
  const shown = items.slice(0, 4)
  return <div className={`chat-media ${shown.length === 1 ? 'single' : ''}`}>{shown.map(({ url, kind, title }) => kind === 'image'
    ? <button key={url} type="button" className="media-thumb" onClick={() => onZoom({ url, title })} aria-label={`Ampliar: ${title}`}>
        <img src={url} alt={title} decoding="async" loading={url.startsWith('blob:') || url.startsWith('data:') ? 'eager' : 'lazy'} onLoad={onLoaded} />
      </button>
    : kind === 'video'
      ? <video key={url} src={url} controls playsInline preload="metadata" onLoadedMetadata={onLoaded} />
      : <audio key={url} src={url} controls preload="metadata" />)}</div>
}

function SourceLinks({ turn }: { turn: Turn }) {
  const sources = (turn.sources ?? []).slice(0, 4)
  if (!sources.length) return null
  return <div className="chat-sources">{sources.map((s) => <a key={`${s.url}-${s.title}`} href={s.url} target="_blank" rel="noreferrer">↗ {s.title || s.url}</a>)}</div>
}

export function Hud({ onMic, onSubmitText }: { onMic: () => void; onSubmitText: (text: string) => void }) {
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  const caption = useStore((s) => s.caption)
  const turns = useStore((s) => s.turns)
  const activeTool = useStore((s) => s.activeTool)
  const error = useStore((s) => s.error)
  const bridgeStatus = useStore((s) => s.bridgeStatus)
  const bridgeHealth = useStore((s) => s.bridgeHealth)
  const lastTool = useStore((s) => s.lastTool)
  const gestures = useStore((s) => s.gestures)
  const looking = useStore((s) => s.looking)
  const bootNote = useStore((s) => s.bootNote)
  const ui = useStore((s) => s.ui)
  const colour = accentFor(phase, ui)
  const androidOnline = bridgeStatus === 'online' && bridgeHealth === 'online'
  const systemStatus = phase === 'offline' ? 'Desconectado' : phase === 'boot' ? (bootNote || 'Inicializando…') : statusText[phase]
  const chatRef = useRef<HTMLElement | null>(null)
  const wasNearBottom = useRef(true)
  const [draft, setDraft] = useState('')
  const [quickOpen, setQuickOpen] = useState(false)
  const [sysOpen, setSysOpen] = useState(false)
  const [zoom, setZoom] = useState<ZoomTarget | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastText = turns.length ? turns[turns.length - 1].text : ''
  const devMode = isDevMode()

  // Follow the conversation only while the reader is already near the end.
  useEffect(() => {
    const el = chatRef.current
    if (el && wasNearBottom.current) el.scrollTop = el.scrollHeight
  }, [turns.length, caption, lastText])

  const onChatScroll = () => {
    const el = chatRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 72
    wasNearBottom.current = near
    setAtBottom((prev) => (prev === near ? prev : near))
  }

  const jumpToLatest = () => {
    const el = chatRef.current
    if (!el) return
    wasNearBottom.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // A photo finishes decoding after its turn was added; keep the reader at the end if they were there.
  const onMediaLoaded = () => {
    const el = chatRef.current
    if (el && wasNearBottom.current) el.scrollTop = el.scrollHeight
  }

  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setZoom(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoom])

  const submit = () => {
    const value = draft.trim()
    if (!value) return
    setDraft('')
    wasNearBottom.current = true // the person just spoke: show the reply
    onSubmitText(value)
  }

  const micActive = phase === 'listening'
  const micDisabled = phase === 'boot'
  const waveOn = phase === 'listening' || phase === 'speaking'
  const stateClass = error ? 'error' : phase
  const toolLabel = activeTool?.replace(/[_-]/g, ' ')

  return (
    <div className="hud jarvis-hud mobile-first" style={{ ['--accent' as string]: colour }}>
      <div className="ambient-glow" />

      <header className="mobile-topbar">
        <div className="brand-block"><strong>J.A.R.V.I.S.</strong><span>{androidOnline ? 'Android conectado' : 'Assistente pessoal'}</span></div>
        <button className={`top-status state-${stateClass}`} type="button" onClick={() => window.dispatchEvent(new Event('jarvis:open-history'))} aria-label="Abrir conversas">
          <span className={`status-dot ${androidOnline ? 'online' : ''}`} />
          <span>{systemStatus}</span>
        </button>
      </header>

      <main className={`mobile-stage ${turns.length ? 'has-chat' : ''}`}>
        <div className="face-zone"><HologramFace phase={phase} level={level} error={Boolean(error)} /></div>
        <div className={`voice-wave ${waveOn ? 'on' : ''}`} style={{ '--wave-level': `${Math.max(0.12, level)}` } as CSSProperties} aria-hidden="true">
          {Array.from({ length: 20 }).map((_, i) => <i key={i} style={{ animationDelay: `${i * -0.07}s` }} />)}
        </div>

        <div className="chat-wrap">
        <section ref={chatRef} className="mobile-chat" aria-live="polite" onScroll={onChatScroll}>
          {turns.length ? turns.map((turn) => (
            <article className={`chat-message ${turn.role}`} key={turn.id}>
              <span className={`avatar-mini ${turn.role === 'jarvis' ? 'jarvis-mini' : ''}`}><Icon name={turn.role === 'jarvis' ? 'bolt' : 'user'} /></span>
              <div className="chat-body"><b>{turn.role === 'jarvis' ? 'J.A.R.V.I.S.' : 'VOCÊ'}</b><p><DecodeText text={turn.text} /></p><MediaPreview turn={turn} onZoom={setZoom} onLoaded={onMediaLoaded} /><SourceLinks turn={turn} /></div>
            </article>
          )) : <div className="chat-empty"><span>◉</span><b>Conversa vazia</b><small>Toque no microfone quando quiser falar.</small></div>}
          {caption && <div className="live-caption"><span className="caption-dot" />{caption}</div>}
        </section>
        {!atBottom && turns.length > 0 && <button type="button" className="chat-jump" onClick={jumpToLatest} aria-label="Ir para a última mensagem"><Icon name="down" /></button>}
        </div>

        {toolLabel && <div className="mobile-tool"><span className="tool-spinner" />{toolLabel}</div>}
        {lastTool && !activeTool && <div className="mobile-last-action" key={lastTool.at}>✓ {lastTool.summary}</div>}
        {error && <div className="mobile-error" role="alert">{error}</div>}
      </main>

      <section className="mobile-composer" aria-label="Mensagem para o JARVIS">
        <button type="button" className={`composer-mic ${micActive ? 'active' : ''}`} onClick={onMic} disabled={micDisabled} aria-label={micActive ? 'Parar microfone' : 'Falar com JARVIS'}><Icon name="mic" /></button>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} placeholder="Digite uma mensagem…" rows={1} />
        <button type="button" className="composer-send" onClick={submit} disabled={!draft.trim()} aria-label="Enviar mensagem"><Icon name="send" /></button>
      </section>

      <nav className="mobile-nav" aria-label="Navegação do JARVIS">
        <button type="button" onClick={() => window.dispatchEvent(new Event('jarvis:open-history'))} aria-label="Conversas"><Icon name="chat" /><span>Chats</span></button>
        <button type="button" className={sysOpen ? 'selected' : ''} onClick={() => { setQuickOpen(false); setSysOpen((v) => !v) }} aria-label="Sistema"><Icon name="settings" /><span>Sistema</span></button>
        <button type="button" className={`nav-mic ${micActive ? 'active' : ''}`} style={{ '--wave-level': `${Math.max(0.2, level)}` } as CSSProperties} onClick={onMic} disabled={micDisabled} aria-label={micActive ? 'Parar de ouvir' : 'Ativar microfone'} aria-pressed={micActive}>
          {micActive ? <span className="mic-bars" aria-hidden="true">{Array.from({ length: 5 }).map((_, i) => <i key={i} style={{ animationDelay: `${i * -0.13}s` }} />)}</span> : <Icon name="mic" />}
        </button>
        <button type="button" className={quickOpen ? 'selected' : ''} onClick={() => { setSysOpen(false); setQuickOpen((v) => !v) }} aria-label="Ações rápidas"><Icon name="grid" /><span>Ações</span></button>
        <button type="button" onClick={() => { const next = createConversation(); window.dispatchEvent(new CustomEvent('jarvis:new-conversation', { detail: next.id })) }} aria-label="Nova conversa"><Icon name="plus" /><span>Novo</span></button>
      </nav>

      {(quickOpen || sysOpen) && <button type="button" className="sheet-dismiss" aria-label="Fechar" onClick={() => { setQuickOpen(false); setSysOpen(false) }} />}

      {sysOpen && <div className="sys-sheet" role="dialog" aria-label="Sistema">
        <div className="sys-row"><span>J.A.R.V.I.S.</span><b className={phase === 'offline' ? 'bad' : 'ok'}>{systemStatus}</b></div>
        <div className="sys-row"><span>Android</span><b className={androidOnline ? 'ok' : 'bad'}>{androidOnline ? 'Conectado' : 'Desconectado'}</b></div>
        <div className="sys-row"><span>Microfone</span><b>Manual · toque para falar</b></div>
        {devMode && <button type="button" className="sys-dev" onClick={() => { setSysOpen(false); window.dispatchEvent(new Event('jarvis:toggle-diagnostics')) }}>Diagnóstico técnico</button>}
      </div>}

      {quickOpen && <div className="quick-sheet">
        <button type="button" onClick={() => { setQuickOpen(false); onSubmitText('Qual a bateria do celular?') }}><Icon name="bolt" />Bateria</button>
        <button type="button" onClick={() => { setQuickOpen(false); onSubmitText('Tire uma foto e me mostre') }}><Icon name="camera" />Foto</button>
        <button type="button" onClick={() => { setQuickOpen(false); onSubmitText('Mostre minhas notificações') }}><Icon name="bubble" />Notificações</button>
      </div>}

      {/* The existing rich surfaces remain available when the brain requests them,
          but they no longer crowd the mobile home screen. */}
      <Blades /><Effects /><Pointer />
      {ui.chrome.suggestions && <Suggestions />}
      {(gestures || looking) && <div className="hands-live">{looking ? `LOOKING — ${looking.toUpperCase()}` : 'CAMERA ON · G TO STOP'}</div>}
      <GestureGuide live={gestures} />

      {zoom && <div className="lightbox" role="dialog" aria-label={zoom.title} onClick={() => setZoom(null)}>
        <img src={zoom.url} alt={zoom.title} />
        <button type="button" className="lightbox-close" onClick={() => setZoom(null)} aria-label="Fechar imagem"><Icon name="close" /></button>
      </div>}
    </div>
  )
}
