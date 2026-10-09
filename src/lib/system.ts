/**
 * SYSTEM tools — local, no shell, no new network APIs.
 * Results always come from the browser/runtime or existing JARVIS modules.
 */

import { describeHealth, getBridgeSnapshot, recheckBridge } from './phone'
import { listMemories, memoryKind } from './memory'
import { taskSummary } from './tasks'

export type SystemResult =
  | { status: 'idle' }
  | { status: 'ok'; action: string; info: string }
  | { status: 'failed'; action: string; message: string }
  | { status: 'rejected'; action: string; message: string }

export type SystemAction = { a: string } & Record<string, unknown>

let pending: SystemAction | null = null

export function stashSystem(action: SystemAction | null): void {
  pending = action
}

export function hasPendingSystem(): boolean {
  return pending !== null
}

function runDatetime(): string {
  const now = new Date()
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).format(now)
  } catch {
    return now.toISOString()
  }
}

function runBridgeStatus(): string {
  const s = getBridgeSnapshot()
  const adb = s.adb === null ? 'desconhecido' : s.adb ? 'conectado' : 'não conectado'
  const when = s.lastCheckAt ? new Date(s.lastCheckAt).toLocaleString('pt-BR') : 'nunca'
  // A fresh handshake is already running for the next call; this answer is the last real one.
  recheckBridge()
  return `Ponte do celular: ${describeHealth(s)}; depuração sem fio: ${adb}; última verificação: ${when}`
}

/** Real, local facts about this JARVIS — only what the runtime can actually observe. */
async function runDiagnostics(): Promise<string> {
  const parts: string[] = []
  parts.push(runBridgeStatus())
  parts.push(
    typeof navigator !== 'undefined' && 'onLine' in navigator
      ? `internet do aparelho: ${navigator.onLine ? 'conectada' : 'sem conexão'}`
      : 'internet: não sei verificar',
  )
  const w = window as unknown as Record<string, unknown>
  const stt = Boolean(w.SpeechRecognition || w.webkitSpeechRecognition)
  const mic = Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function')
  parts.push(`reconhecimento de voz do navegador: ${stt ? 'disponível' : 'indisponível'}`)
  parts.push(`microfone acessível ao navegador: ${mic ? 'sim' : 'não'}`)
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(5_000), cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    const providers = Array.isArray(data.providers) ? data.providers.join(', ') : ''
    parts.push(`provedores de IA: ${providers || 'nenhum configurado'}`)
    parts.push(`pesquisa web: ${data.search ? 'Gemini Search configurada' : 'sem chave Gemini para pesquisa principal'}`)
  } catch {
    parts.push('API do JARVIS: indisponível')
  }
  parts.push(`${listMemories().length} itens na memória`)
  parts.push(taskSummary(3))
  return parts.join('; ')
}

function runCapabilities(): string {
  return (
    'Posso: conversar, pesquisar na web, ver hora e estado do sistema, guardar e esquecer fatos, e agir no celular ' +
    'pela ponte do Termux (abrir apps, links, arquivos, WhatsApp, música, print, foto, volume, lanterna, ' +
    'área de transferência e navegação). Não consigo agir no celular se a ponte estiver desligada.'
  )
}

function runMemoryList(): string {
  const items = listMemories()
  if (!items.length) return 'Nenhum fato guardado na memória local.'
  const lines = items.slice(0, 20).map((i, n) => `${n + 1}. ${i.text} [${memoryKind(i)}]`)
  const more = items.length > 20 ? ` (e mais ${items.length - 20})` : ''
  return `Fatos na memória local (${items.length})${more}:\n${lines.join('\n')}`
}

/**
 * Execute the stashed SYSTEM action, if any. Clears the stash.
 * Only allowlisted actions; never runs shell or network.
 */
export async function runPendingSystem(): Promise<SystemResult> {
  const action = pending
  pending = null
  if (!action || typeof action.a !== 'string') return { status: 'idle' }

  const name = action.a
  try {
    if (name === 'datetime') {
      return { status: 'ok', action: name, info: runDatetime() }
    }
    if (name === 'bridge_status') {
      return { status: 'ok', action: name, info: runBridgeStatus() }
    }
    if (name === 'memory_list') {
      return { status: 'ok', action: name, info: runMemoryList() }
    }
    if (name === 'tasks') {
      return { status: 'ok', action: name, info: taskSummary(6) }
    }
    if (name === 'diagnostico') {
      return { status: 'ok', action: name, info: await runDiagnostics() }
    }
    if (name === 'capabilities') {
      return { status: 'ok', action: name, info: runCapabilities() }
    }
    return {
      status: 'rejected',
      action: name,
      message: `ação de sistema desconhecida: ${name}`,
    }
  } catch (err) {
    return {
      status: 'failed',
      action: name,
      message: err instanceof Error ? err.message : 'falha no sistema',
    }
  }
}

export function formatSystemResultForContext(result: SystemResult): string | null {
  switch (result.status) {
    case 'idle':
      return null
    case 'ok':
      return `Resultado real do sistema (${result.action}): ${result.info}`
    case 'failed':
      return `Resultado real do sistema (${result.action}): falhou — ${result.message}`
    case 'rejected':
      return `Resultado real do sistema (${result.action}): recusada — ${result.message}`
    default:
      return null
  }
}
