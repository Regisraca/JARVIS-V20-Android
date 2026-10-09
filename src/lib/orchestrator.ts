/**
 * Minimal orchestration nucleus for JARVIS.
 *
 * Categories (only tools that actually exist in code):
 *   PHONE  → Termux bridge via phone.ts (POST /act)
 *   WEB    → internet via web.ts (Gemini google_search + Wikipedia fallback)
 *   SYSTEM → local runtime via system.ts (datetime, bridge_status, memory_list)
 *
 * PHONE autonomy: safe | sensitive | destructive — confirmation before execution
 * for sensitive/destructive (WhatsApp keeps its own send confirmation inside phone.ts).
 */

import {
  runPending,
  formatPhoneResultForContext,
  peekPending,
  discardNext,
  pendingCount,
  type PhoneResult,
  type PhoneAction,
} from './phone'
import { createTask, newPlanId, setTask } from './tasks'
import {
  runPendingWeb,
  hasPendingWeb,
  formatWebResultForContext,
  type WebResult,
} from './web'
import { routeQuery as routeQueryImpl, type QueryRoute as QueryRouteImpl } from './route'
import {
  runPendingSystem,
  hasPendingSystem,
  formatSystemResultForContext,
  type SystemResult,
} from './system'

/** Allowlist mirroring public/phone-bridge.mjs ACTIONS keys. */
export const PHONE_TOOLS = [
  'url',
  'musica',
  'app',
  'arquivo',
  'whatsapp',
  'home',
  'voltar',
  'recentes',
  'wifi',
  'bluetooth',
  'notificacoes',
  'ler_notificacoes',
  'ler_mensagens',
  'ler_sms',
  'ler_arquivo',
  'abrir_ultima_foto',
  'piscar_lanterna',
  'sequencia',
  'whatsapp_print_ultimas',
  'fechar',
  'lanterna',
  'vibrar',
  'bateria',
  'volume',
  'falar',
  'copiar',
  'colar',
  'aviso',
  'foto',
  'configuracoes',
  'print',
  'ytmusic_tocar',
  'spotify_tocar',
  'app_pesquisar',
  'ui_ler_tela',
  'whatsapp_ler_conversa',
  'whatsapp_pendencias',
] as const

export type PhoneToolId = (typeof PHONE_TOOLS)[number]

/** WEB tools implemented in web.ts. */
export const WEB_TOOLS = ['web_search'] as const

export type WebToolId = (typeof WEB_TOOLS)[number]

/** SYSTEM tools implemented in system.ts — local only, no shell. */
export const SYSTEM_TOOLS = [
  'datetime',
  'bridge_status',
  'memory_list',
  'tasks',
  'diagnostico',
  'capabilities',
] as const

export type SystemToolId = (typeof SYSTEM_TOOLS)[number]

export type ToolCategory = 'phone' | 'web' | 'system'

export const TOOL_CATEGORIES: Record<ToolCategory, readonly string[]> = {
  phone: PHONE_TOOLS,
  web: WEB_TOOLS,
  system: SYSTEM_TOOLS,
}

export type QueryRoute = QueryRouteImpl

/** Central intent router shared by text and voice (see ./route.ts). */
export function routeQuery(text: string): QueryRoute {
  return routeQueryImpl(text)
}


/**
 * Fast path for short, deterministic Android commands.
 * These commands do not need Gemini/Groq to infer an already-known action.
 * The normal Phone Bridge validation/confirmation still runs afterwards.
 */
export function fastPhoneCommand(text: string): PhoneAction | null {
  const q = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[\s]*(?:hey|oi|ola|ok|okay|jarvis|jarvys|jervis|travis)[\s,.:!?-]*/i, '')
    .trim()

  if (!q) return null

  const appAliases: Record<string, string> = {
    whatsapp: 'whatsapp',
    'whats app': 'whatsapp',
    youtube: 'youtube',
    spotify: 'spotify',
    'youtube music': 'ytmusic',
    ytmusic: 'ytmusic',
    'youtube music app': 'ytmusic',
    chrome: 'chrome',
    navegador: 'chrome',
    mapas: 'maps',
    maps: 'maps',
    camera: 'camera',
  }

  const appAction = (name: string): PhoneAction | null => {
    const key = norm(name)
      .replace(/^(?:o|a|os|as)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
    const alias = appAliases[key]
    return alias ? { a: 'app', nome: alias } : null
  }

  // App skills: deterministic first-party app workflows, no LLM needed.
  const music = q.match(/^(?:toque|toca|coloque|coloca)\s+(.+?)\s+(?:no|na)\s+(youtube\s*music|ytmusic|spotify)[.!?]*$/)
  if (music) {
    const action = norm(music[2]).replace(/\s+/g, ' ')
    return action.includes('spotify') ? { a: 'spotify_tocar', q: music[1].trim() } : { a: 'ytmusic_tocar', q: music[1].trim() }
  }
  const searchApp = q.match(/^(?:pesquise|pesquisar|procure|buscar|busque)\s+(.+?)\s+(?:no|na)\s+(youtube|chrome|navegador|maps|mapas)[.!?]*$/)
  if (searchApp) {
    const key = norm(searchApp[2]).replace('navegador', 'chrome').replace('mapas', 'maps')
    return { a: 'app_pesquisar', app: key, q: searchApp[1].trim() }
  }
  const readWa = q.match(/^(?:abra\s+)?(?:o\s+)?whatsapp\s+e\s+(?:leia|mostre)\s+(?:as\s+)?(?:ultimas\s+)?mensagens(?:\s+nao\s+lidas)?\s+(?:de|da|do)\s+(.+?)[.!?]*$/)
  if (readWa) return { a: 'whatsapp_ler_conversa', pessoa: readWa[1].trim() }
  if (/^(?:abra\s+)?(?:o\s+)?whatsapp\s+e\s+(?:veja|diga|conte)\s+quantas\s+conversas\s+(?:estao\s+)?sem\s+resposta[.!?]*$/.test(q)) return { a: 'whatsapp_pendencias' }

  // Composite fast commands. Keep this deliberately deterministic: only known,
  // allowlisted phone actions are converted to a sequence; everything else goes to the LLM.
  const buildSequence = (steps: PhoneAction[]): PhoneAction => ({ a: 'sequencia', passos: steps.slice(0, 12) })

  // Natural spoken variants: "YouTube Music, abra" / "WhatsApp, abre".
  const appThenAction = q.match(/^\s*(whatsapp|whats\s*app|youtube(?:\s+music)?|spotify|chrome|navegador|mapas|maps)\s*[,;:]?\s*(?:abra|abrir|abre|entra|entrar)\s*$/)
  if (appThenAction) return appAction(appThenAction[1])

  // Reading commands that explicitly refer to what is visible on screen must use
  // UI automation, not the notification listener. This avoids the Termux:API
  // notification permission path for an already-open WhatsApp conversation.
  if (/^(?:leia|ler|leia\s+)?(?:a\s+)?conversa(?:\s+que\s+esta\s+na\s+tela|\s+na\s+tela)?[.!?]*$/.test(q)) {
    return { a: 'ui_ler_tela', app: 'whatsapp' }
  }
  if (/^(?:leia|ler)\s+(?:a\s+)?conversa\s+(?:do\s+)?whatsapp[.!?]*$/.test(q)) {
    return { a: 'ui_ler_tela', app: 'whatsapp' }
  }
  if (/^(?:quantas|quantidade\s+de)\s+(?:mensagens?|notifica(?:coes|ções))\s+(?:pendentes|nao\s+lidas|não\s+lidas)(?:\s+eu\s+tenho)?[.!?]*$/.test(q)) {
    return { a: 'ler_notificacoes', app: 'whatsapp', limite: 20 }
  }

  const targetApp = q.match(/\b(?:abra|abrir|abre|entr(?:e|ar)\s+no|vai\s+para|va\s+para)\s+(?:o\s+|a\s+)?(whatsapp|whats\s*app|youtube(?:\s+music)?|spotify|chrome|navegador|mapas|maps)\b/)
  const app = targetApp ? appAction(targetApp[1]) : null

  if (app) {
    // "open X and ..." / "open X, then ..."
    const rest = q.slice((targetApp?.index ?? 0) + targetApp[0].length)
    const steps: PhoneAction[] = [app]
    if (/\b(?:tira|tirar|faca|fazer|faz|pegue|pega|capture|captura|salva|salvar)\b[\s\S]{0,80}\b(?:print|screenshot|captura(?:\s+da)?\s+tela)\b/.test(rest)) {
      steps.push({ a: 'print' })
      return buildSequence(steps)
    }
    if (/\b(?:volta|voltar|retorna|retornar)\b/.test(rest)) {
      steps.push({ a: 'voltar' })
      return buildSequence(steps)
    }
    if (/\b(?:home|tela\s+inicial|inicio)\b/.test(rest)) {
      steps.push({ a: 'home' })
      return buildSequence(steps)
    }
    if (/\b(?:tira|tirar|faca|faz|pegue|pega)\b[\s\S]{0,40}\b(?:foto|fotografia)\b/.test(rest)) {
      steps.push({ a: 'foto', camera: /\bfrontal\b/.test(rest) ? 1 : 0 })
      return buildSequence(steps)
    }
    if (/\b(?:mostra|mostrar|abra|abrir|abre)\b[\s\S]{0,50}\b(?:ultima\s+foto|foto\s+mais\s+recente)\b/.test(rest)) {
      steps.push({ a: 'abrir_ultima_foto' })
      return buildSequence(steps)
    }
    // A bare app command is also fast.
    if (/^(?:e|entao|agora)?\s*[.!?]*$/.test(rest)) return app
  }

  // Direct app commands not caught above.
  const directApp = q.match(/^(?:abra|abrir|abre|entr(?:e|ar)\s+no|vai\s+para|va\s+para)\s+(whatsapp|whats\s*app|youtube(?:\s+music)?|spotify|chrome|navegador|mapas|maps)[.!?]*$/)
  if (directApp) return appAction(directApp[1])

  // Screenshot / screen capture.
  if (/\b(?:tira|tirar|faca|fazer|faz|pegue|pega|capture|captura|salva|salvar)\b[\s\S]{0,80}\b(?:print|screenshot|captura(?:\s+da)?\s+tela)\b/.test(q) ||
      /^\s*(?:print|screenshot|captura(?:\s+da)?\s+tela)\s*(?:da\s+tela)?\s*$/.test(q)) {
    return { a: 'print' }
  }

  // Battery read: ask for only the percentage.
  if (/\b(?:bateria|nivel\s+da\s+bateria|porcentagem\s+da\s+bateria|quanto(?:\s+de)?\s+bateria|quanta\s+bateria)\b/.test(q) &&
      !/\b(?:detalhad|informacoes|informacoes\s+da|estado\s+completo)\b/.test(q)) return { a: 'bateria' }

  // Charging-state query stays on the same local battery tool.
  if (/\b(?:esta|est[aá])\s+(?:carregando|a\s+carregar)\b|\b(?:ta|t[aá])\s+carregando\b/.test(q)) return { a: 'bateria', modo: 'carregando' }

  const vol = q.match(/\b(?:volume|som)\b[\s\S]{0,60}?\b(?:para|em|no\s+nivel|nivel)\s*(?:o\s+)?(\d{1,2})\b/)
  if (vol) return { a: 'volume', nivel: Math.max(0, Math.min(15, Number(vol[1]))) }
  if (/\b(?:qual|quanto\s+esta|como\s+esta)\b[\s\S]{0,30}\bvolume\b/.test(q) || /^\s*volume\s*\??$/.test(q)) return { a: 'volume' }

  if (/\b(?:liga|ligue|acende|acenda)\b[\s\S]{0,25}\blanterna\b/.test(q)) return { a: 'lanterna', ligada: true }
  if (/\b(?:desliga|desligue|apaga|apague)\b[\s\S]{0,25}\blanterna\b/.test(q)) return { a: 'lanterna', ligada: false }
  const flashes = q.match(/\b(?:pisca|pisque|piscar|pisquei)\b[\s\S]{0,25}\blanterna\b[\s\S]{0,25}?\b(\d{1,2})\s*(?:vez|vezes)\b/)
  if (flashes) return { a: 'piscar_lanterna', vezes: Math.max(1, Math.min(20, Number(flashes[1]))) }

  if (/\b(?:tira|tirar|faca|faz|pegue|pega)\b[\s\S]{0,80}\b(?:foto|fotografia)\b[\s\S]{0,50}\b(?:mostra|mostrar|me\s+mostra|me\s+mostrar)\b/.test(q) || /\b(?:tira|tirar|faca|faz|pegue|pega)\b[\s\S]{0,50}\b(?:foto|fotografia)\b[\s\S]{0,50}\b(?:e|depois)\b[\s\S]{0,20}\b(?:mostra|mostrar|abra|abrir)\b/.test(q)) return { a: 'sequencia', passos: [{ a: 'foto', camera: /\bfrontal\b/.test(q) ? 1 : 0 }, { a: 'abrir_ultima_foto' }] }
  if (/\b(?:tira|tirar|faca|faz|pegue|pega)\b[\s\S]{0,40}\b(?:foto|fotografia)\b/.test(q)) return { a: 'foto', camera: /\bfrontal\b/.test(q) ? 1 : 0 }
  if (/\b(?:mostra|mostrar|abra|abrir|abre)\b[\s\S]{0,50}\b(?:ultima|ultima foto|foto mais recente)\b/.test(q)) return { a: 'abrir_ultima_foto' }

  if (/^(?:voltar|volta|retornar|retorna|volte)(?:\s+uma\s+tela)?[.!?]*$/.test(q)) return { a: 'voltar' }
  if (/^(?:home|inicio|tela inicial|ir para a tela inicial|vai para a tela inicial)[.!?]*$/.test(q)) return { a: 'home' }
  if (/^(?:recentes|abrir recentes|aplicativos recentes)[.!?]*$/.test(q)) return { a: 'recentes' }

  if (/\b(?:ligar|liga|ligue|ativar|ative|desligar|desliga|desligue|desativar|desative)\b[\s\S]{0,30}\b(?:wifi|wi-fi)\b/.test(q)) {
    return { a: 'wifi', ligado: !/\b(?:desligar|desliga|desligue|desativar|desative)\b/.test(q) }
  }
  if (/\b(?:abrir|abre|abra|ir para|vai para|va para)\b[\s\S]{0,30}\b(?:wifi|wi-fi)\b/.test(q)) return { a: 'wifi', modo: 'configuracoes' }
  if (/\b(?:ligar|liga|ligue|ativar|ative|desligar|desliga|desligue|desativar|desative)\b[\s\S]{0,30}\bbluetooth\b/.test(q)) {
    return { a: 'bluetooth', ligado: !/\b(?:desligar|desliga|desligue|desativar|desative)\b/.test(q) }
  }
  if (/\b(?:abrir|abre|abra|ir para|vai para|va para)\b[\s\S]{0,30}\bbluetooth\b/.test(q)) return { a: 'bluetooth', modo: 'configuracoes' }
  if (/\b(?:abrir|abre|abra|ir para|vai para|va para)\b[\s\S]{0,35}\bconfiguracoes\b/.test(q)) return { a: 'configuracoes' }

  return null
}
/** Convert verbose raw phone results into the smallest useful spoken answer. */
export function fastPhoneReply(action: PhoneAction, result: PhoneResult): string {
  if (result.status === 'ok') {
    if (action.a === 'whatsapp_ler_conversa' || action.a === 'whatsapp_pendencias' || action.a === 'ui_ler_tela' || action.a === 'sequencia') {
      try {
        const parsed = JSON.parse(result.info) as Record<string, unknown>
        if (parsed.tipo === 'sequencia') {
          const steps = Array.isArray(parsed.passos) ? parsed.passos as Array<Record<string, unknown>> : []
          const last = steps[steps.length - 1]
          return last?.info ? `Sequência concluída: ${String(last.info)}` : 'Sequência concluída.'
        }
        if (parsed.tipo === 'whatsapp_conversa') {
          const msgs = Array.isArray(parsed.mensagens) ? parsed.mensagens.map(String).slice(-8) : []
          return msgs.length ? `Encontrei estas mensagens visíveis da conversa com ${String(parsed.pessoa || action.pessoa || '')}: ${msgs.join(' | ')}` : `Abri a conversa com ${String(parsed.pessoa || action.pessoa || '')}, mas não encontrei mensagens legíveis na tela.`
        }
        if (parsed.tipo === 'whatsapp_pendencias') {
          const n = Number(parsed.quantidade_identificadas || 0)
          const itens = Array.isArray(parsed.itens) ? parsed.itens.map(String).slice(0, 5) : []
          return n > 3 ? `Identifiquei ${n} possíveis indicadores de conversas pendentes no WhatsApp.` : n ? `Identifiquei ${n} possíveis pendências no WhatsApp: ${itens.join(', ')}.` : 'Não identifiquei pendências na tela atual do WhatsApp.'
        }
        if (parsed.tipo === 'tela') {
          const texts = Array.isArray(parsed.textos) ? parsed.textos.map(String).slice(0, 20) : []
          return texts.length ? `Li a tela: ${texts.join(' | ')}` : 'Não encontrei texto legível na tela.'
        }
      } catch { /* keep real raw info below */ }
    }
    if (action.a === 'bateria') {
      try {
        const parsed = JSON.parse(result.info) as { percentage?: unknown; status?: unknown; plugged?: unknown }
        const pct = Number(parsed.percentage)
        const charging = /\bcharging\b|\bcarregando\b/i.test(String(parsed.status ?? '')) || /\b(?:AC|USB|wireless)\b/i.test(String(parsed.plugged ?? ''))
        if (action.modo === 'carregando') return charging ? 'Sim, o celular está carregando.' : 'Não, o celular não está carregando.'
        if (Number.isFinite(pct)) return `Sua bateria está em ${Math.round(pct)}%.`
      } catch {
        const m = result.info.match(/"percentage"\s*:\s*(\d+(?:\.\d+)?)/i)
        if (m) return `Sua bateria está em ${Math.round(Number(m[1]))}%.`
      }
      return 'Não consegui identificar o estado da bateria.'
    }
    if (action.a === 'print') return 'Pronto. O print foi salvo na pasta Imagens.'
    if (action.a === 'volume' && /"stream"|"volume"/i.test(result.info)) {
      try {
        const data = JSON.parse(result.info) as unknown
        if (Array.isArray(data)) {
          const music = data.find((x) => x && typeof x === 'object' && String((x as any).stream) === 'music') as any
          if (music && Number.isFinite(Number(music.volume))) return `O volume de música está em ${music.volume}.`
        }
      } catch { /* fall through to real bridge text */ }
    }
    return result.info
  }
  if (result.status === 'rejected' && /cancelada por você/i.test(result.message)) {
    return 'Tudo bem. Não executei a ação.'
  }
  if ('message' in result) return result.message
  return 'Não consegui executar a ação no celular.'
}

/** Autonomy levels for PHONE tools only. */
export type AutonomyLevel = 'safe' | 'sensitive' | 'destructive'

/**
 * Classification of every PHONE tool. Unknown names are treated as sensitive
 * (require confirm) rather than silent execute.
 */
export const PHONE_AUTONOMY: Record<PhoneToolId, AutonomyLevel> = {
  // Safe — reversible UI navigation / read-only / mild device feedback
  url: 'safe',
  musica: 'safe',
  app: 'safe',
  arquivo: 'safe',
  home: 'safe',
  voltar: 'safe',
  recentes: 'safe',
  wifi: 'safe',
  bluetooth: 'safe',
  notificacoes: 'safe',
  ler_notificacoes: 'sensitive',
  ler_mensagens: 'sensitive',
  ler_sms: 'sensitive',
  ler_arquivo: 'sensitive',
  abrir_ultima_foto: 'safe',
  piscar_lanterna: 'safe',
  sequencia: 'sensitive',
  whatsapp_print_ultimas: 'sensitive',
  configuracoes: 'safe',
  vibrar: 'safe',
  bateria: 'safe',
  falar: 'safe',
  aviso: 'safe',
  colar: 'safe',
  lanterna: 'safe',
  // Sensitive — privacy or device state the user should acknowledge
  whatsapp: 'sensitive',
  print: 'sensitive',
  foto: 'sensitive',
  copiar: 'sensitive',
  volume: 'sensitive',
  // Destructive — force-stop / hard to undo from the assistant side
  fechar: 'destructive',
}

const PHONE_TOOL_SET = new Set<string>(PHONE_TOOLS)
const WEB_TOOL_SET = new Set<string>(WEB_TOOLS)
const SYSTEM_TOOL_SET = new Set<string>(SYSTEM_TOOLS)

export function isAllowedPhoneTool(name: string): boolean {
  return PHONE_TOOL_SET.has(name)
}

export function isAllowedWebTool(name: string): boolean {
  return WEB_TOOL_SET.has(name)
}

export function isAllowedSystemTool(name: string): boolean {
  return SYSTEM_TOOL_SET.has(name)
}

export function phoneAutonomy(name: string): AutonomyLevel {
  if ((PHONE_TOOLS as readonly string[]).includes(name)) {
    return PHONE_AUTONOMY[name as PhoneToolId]
  }
  return 'sensitive'
}

function confirmMessage(action: PhoneAction, level: AutonomyLevel): string {
  const a = String(action.a || '')
  if (a === 'fechar') {
    return `Encerrar o app "${String(action.nome || '')}"?\n\nIsso força o fechamento do aplicativo.`
  }
  if (a === 'foto') {
    return `Tirar uma foto agora com a câmera ${Number(action.camera) === 1 ? 'frontal' : 'traseira'}?`
  }
  if (a === 'ler_arquivo') {
    return `Ler o conteúdo do arquivo "${String(action.nome || '')}" do celular?`
  }
  if (a === 'whatsapp_ler_conversa') return `Ler as mensagens visíveis da conversa com ${String(action.pessoa || '')}?`
  if (a === 'whatsapp_pendencias') return 'Verificar as conversas pendentes do WhatsApp?'
  if (a === 'whatsapp_print_ultimas') {
    return `Capturar até ${String(action.quantidade || 5)} conversas recentes do WhatsApp em screenshots?`
  }
  if (a === 'sequencia') {
    const n = Array.isArray(action.passos) ? action.passos.length : 0
    return `Executar a sequência de ${n} ações no celular?`
  }
  if (a === 'print') {
    return 'Tirar um print da tela agora?'
  }
  if (a === 'copiar') {
    const t = String(action.texto ?? '').slice(0, 120)
    return `Copiar para a área de transferência?\n\n"${t}${String(action.texto ?? '').length > 120 ? '…' : ''}"`
  }
  if (a === 'volume') {
    if (action.nivel !== null && action.nivel !== undefined && action.nivel !== '') {
      return `Ajustar o volume (${String(action.stream || 'music')}) para ${String(action.nivel)}?`
    }
    return 'Consultar os níveis de volume do celular?'
  }
  if (a === 'whatsapp') {
    return `Abrir o WhatsApp para ${String(action.to || 'o contato')} com esta mensagem?\n\n"${String(action.text ?? '').slice(0, 160)}"`
  }
  return level === 'destructive'
    ? `Confirmar ação destrutiva no celular: ${a}?`
    : `Confirmar ação no celular: ${a}?`
}

/**
 * Sensitive/destructive PHONE actions need explicit confirm before /act.
 * WhatsApp still has a second confirm for auto-send inside phone.ts when ADB is ready.
 * Safe actions run without a dialog.
 */
function userAllowsPhoneAction(action: PhoneAction): boolean {
  const level = phoneAutonomy(String(action.a || ''))
  if (level === 'safe') return true
  // volume without nivel is a read — treat as safe at confirm time
  if (action.a === 'volume' && (action.nivel === null || action.nivel === undefined || action.nivel === '')) {
    return true
  }
  try {
    return window.confirm(confirmMessage(action, level))
  } catch {
    return false
  }
}

export type SettledPhoneTurn = {
  result: PhoneResult
  contextNote: string | null
  succeeded: boolean
}

export type SettledWebTurn = {
  result: WebResult
  contextNote: string | null
  succeeded: boolean
}

export type SettledSystemTurn = {
  result: SystemResult
  contextNote: string | null
  succeeded: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Validate one PHONE action before anything leaves the page: allowlisted name,
 * required parameters present and sane. Returns a user-facing reason, or null if fine.
 * (The bridge validates again — this only avoids pointless round trips and confirm dialogs.)
 */
export function validatePhoneAction(action: PhoneAction): string | null {
  const a = str(action.a)
  if (!a || !isAllowedPhoneTool(a)) return `ação desconhecida no celular: ${a || '(vazia)'}`
  switch (a) {
    case 'url':
      return /^https?:\/\/\S+$/i.test(str(action.url)) ? null : 'o link precisa começar com http:// ou https://'
    case 'musica':
      return str(action.q) ? null : 'faltou dizer qual música ou artista'
    case 'app':
    case 'arquivo':
    case 'fechar':
      return str(action.nome) ? null : 'faltou o nome'
    case 'whatsapp':
      if (!str(action.text)) return 'faltou a mensagem do WhatsApp'
      return str(action.to) ? null : 'faltou para quem enviar'
    case 'falar':
    case 'copiar':
    case 'aviso':
      return str(action.texto) ? null : 'faltou o texto'
    case 'ler_arquivo':
    case 'arquivo':
      return str(action.nome) ? null : 'faltou o nome do arquivo'
    case 'sequencia':
      return Array.isArray(action.passos) && action.passos.length >= 1 && action.passos.length <= 12 ? null : 'a sequência deve ter de 1 a 12 passos'
    case 'whatsapp_print_ultimas':
      return null
    case 'volume': {
      if (action.nivel === null || action.nivel === undefined || action.nivel === '') return null
      const n = Number(action.nivel)
      return Number.isFinite(n) && n >= 0 && n <= 15 ? null : 'o volume vai de 0 a 15'
    }
    default:
      return null
  }
}

/**
 * Run every stashed phone [[ACAO]] of this turn as one plan:
 *   validate → classify risk → confirm (if needed) → execute → (bridge verifies) → next step.
 * The plan stops at the first step that does not succeed: later steps usually depend on
 * the earlier ones (open the app, THEN type/send), so continuing blindly would be wrong.
 * The aggregate result keeps the shape App already understands.
 */
export async function settlePhoneTurn(
  onFail?: (message: string) => void,
): Promise<SettledPhoneTurn> {
  const total = pendingCount()
  if (total === 0) {
    const result: PhoneResult = { status: 'idle' }
    return { result, contextNote: null, succeeded: false }
  }

  const planId = newPlanId()
  const results: PhoneResult[] = []
  const notes: string[] = []
  let step = 0

  while (peekPending()) {
    step++
    const action = peekPending() as PhoneAction
    const name = String(action.a || '')
    const task = createTask({
      planId,
      step,
      steps: total,
      category: 'phone',
      tool: name || 'desconhecida',
      intent: `${name}${action.nome ? ` ${String(action.nome)}` : action.q ? ` ${String(action.q)}` : ''}`,
    })
    setTask(task.id, { state: 'planning', progress: 'validando' })

    let result: PhoneResult
    const invalid = validatePhoneAction(action)
    if (invalid) {
      discardNext()
      result = { status: 'rejected', action: name, message: `Ação recusada: ${invalid}.` }
      setTask(task.id, { state: 'failed', error: result.message })
    } else {
      const level = phoneAutonomy(name)
      setTask(task.id, { state: level === 'safe' ? 'running' : 'waiting', progress: `risco: ${level}` })
      if (!userAllowsPhoneAction(action)) {
        discardNext()
        result = { status: 'rejected', message: 'Ação no celular cancelada por você.', action: name }
        setTask(task.id, { state: 'cancelled', error: 'recusada pelo usuário' })
      } else {
        setTask(task.id, { state: 'running', progress: 'executando na ponte' })
        result = await runPending(onFail)
        if (result.status === 'ok') {
          const verified = /\(confirmad[oa]\)/i.test(result.info)
          const unverified = /não consegui confirmar|mas o celular está em/i.test(result.info)
          setTask(task.id, {
            state: 'completed',
            result: result.info.slice(0, 200),
            verified: verified ? true : unverified ? false : null,
          })
        } else {
          setTask(task.id, {
            state: 'failed',
            error: 'message' in result ? result.message.slice(0, 200) : result.status,
          })
        }
      }
    }

    if (result.status === 'rejected' && /cancelada por você/i.test(result.message)) onFail?.(result.message)
    results.push(result)
    const note = formatPhoneResultForContext(result)
    if (note) notes.push(note)
    if (result.status !== 'ok') break
  }

  // Steps that never ran because an earlier one failed: record them honestly, then drop them.
  const skipped = pendingCount()
  while (peekPending()) {
    const left = discardNext()
    step++
    const t = createTask({
      planId,
      step,
      steps: total,
      category: 'phone',
      tool: String(left?.a || 'desconhecida'),
      intent: 'não executada',
    })
    setTask(t.id, { state: 'cancelled', error: 'etapa anterior não foi concluída' })
  }
  if (skipped > 0) notes.push(`${skipped} etapa(s) seguinte(s) do plano não foram executadas porque a anterior não deu certo.`)

  const okOnes = results.filter((r): r is Extract<PhoneResult, { status: 'ok' }> => r.status === 'ok')
  const last = results[results.length - 1]
  const allOk = results.length > 0 && results.every((r) => r.status === 'ok') && skipped === 0

  // One result for App: all successful infos joined, or the failure that stopped the plan.
  const aggregate: PhoneResult =
    allOk && okOnes.length > 1
      ? { status: 'ok', action: okOnes[okOnes.length - 1].action, info: okOnes.map((r) => r.info).join('. ') }
      : last

  return {
    result: aggregate,
    contextNote: notes.join('\n') || null,
    succeeded: allOk,
  }
}

/** Run stashed web_search if any; real WebResult only — never invented. */
export async function settleWebTurn(
  onFail?: (message: string) => void,
): Promise<SettledWebTurn> {
  // Nothing asked for → nothing to record (keeps the task ledger free of empty rows).
  if (!hasPendingWeb()) return { result: { status: 'idle' }, contextNote: null, succeeded: false }
  const task = createTask({ planId: newPlanId(), step: 1, steps: 1, category: 'web', tool: 'web_search', intent: 'pesquisa na web' })
  setTask(task.id, { state: 'running', progress: 'pesquisando' })
  const result = await runPendingWeb()
  if (result.status === 'idle') {
    setTask(task.id, { state: 'cancelled', error: 'nada a pesquisar' })
  } else if (result.status === 'ok') {
    // Search answers are model-written summaries, not read-backs: never mark them verified.
    setTask(task.id, { state: 'completed', result: result.summary.slice(0, 200), verified: null })
  } else {
    setTask(task.id, { state: 'failed', error: result.message.slice(0, 200) })
  }
  if (result.status === 'failed' || result.status === 'offline') {
    onFail?.(result.message)
  }
  return {
    result,
    contextNote: formatWebResultForContext(result),
    succeeded: result.status === 'ok',
  }
}

/** Run stashed SYSTEM action if any; real local result only. */
export async function settleSystemTurn(
  onFail?: (message: string) => void,
): Promise<SettledSystemTurn> {
  if (!hasPendingSystem()) return { result: { status: 'idle' }, contextNote: null, succeeded: false }
  const task = createTask({ planId: newPlanId(), step: 1, steps: 1, category: 'system', tool: 'system', intent: 'consulta local' })
  setTask(task.id, { state: 'running', progress: 'consultando' })
  const result = await runPendingSystem()
  if (result.status === 'idle') {
    setTask(task.id, { state: 'cancelled', error: 'nada a consultar' })
  } else if (result.status === 'ok') {
    setTask(task.id, { state: 'completed', tool: result.action, result: result.info.slice(0, 200), verified: true })
  } else {
    setTask(task.id, {
      state: 'failed',
      tool: result.action,
      error: result.message.slice(0, 200),
    })
  }
  if (result.status === 'failed' || result.status === 'rejected') {
    onFail?.(result.message)
  }
  return {
    result,
    contextNote: formatSystemResultForContext(result),
    succeeded: result.status === 'ok',
  }
}
