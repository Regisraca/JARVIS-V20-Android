/**
 * Phone actions. The model ends an answer with one [[ACAO {...}]] block; gemini.ts
 * strips it from the spoken text and stashes it here, and App runs it once he has
 * finished talking. The doing happens in the Termux bridge on the same phone.
 *
 * Contract of POST /act (unchanged, owned by phone-bridge.mjs):
 *   200 { ok: true,  info: string }   — action ran; info is the real outcome text
 *   200 { ok: false, error: string }  — action rejected or threw inside the bridge
 *   401 { ok: false, error: string }  — bad token
 *   400 / 404 / 413 { ok: false, error: string }
 * Network failure → bridge offline (no HTTP response).
 */
const BRIDGE = 'http://127.0.0.1:8787'
const TOKEN_KEY = 'jarvis.phoneToken'

/** Wire protocol this build of the page speaks; the bridge must report the same one. */
export const EXPECTED_PROTOCOL = 2
/** Oldest bridge release that has the version/SHA handshake and verified actions. */
export const MIN_BRIDGE_VERSION = '17.0.0'
/** Every /act call is bounded; `print` waits a few seconds on purpose, hence not shorter. */
const ACT_TIMEOUT_MS = 45_000
const PING_TIMEOUT_MS = 4_000
const MAX_QUEUE = 8

export type PhoneAction = { a: string } & Record<string, unknown>

/**
 * Structured outcome of a phone action attempt.
 * Callers must not claim success unless status === 'ok' and info is present.
 */
export type PhoneMedia = { type: 'image'; path: string; name?: string }

export type PhoneResult =
  | { status: 'idle' }
  | { status: 'ok'; info: string; action: string; media?: PhoneMedia }
  | { status: 'failed'; message: string; action: string }
  | { status: 'rejected'; message: string; action: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'offline'; message: string }
  | { status: 'invalid'; message: string; action?: string }

/**
 * Turn a real PhoneResult into a short fact for the conversation history.
 * Returns null for idle (no action). Never invents success text — only uses
 * fields already present on the result from /act or the local failure path.
 */
export function formatPhoneResultForContext(result: PhoneResult): string | null {
  switch (result.status) {
    case 'idle':
      return null
    case 'ok':
      return `Resultado real da ação no celular (${result.action}): sucesso — ${result.info}`
    case 'failed':
      return `Resultado real da ação no celular (${result.action}): falhou — ${result.message}`
    case 'rejected':
      return `Resultado real da ação no celular (${result.action}): recusada — ${result.message}`
    case 'unauthorized':
      return `Resultado real da ação no celular: não autorizada — ${result.message}`
    case 'offline':
      return `Resultado real da ação no celular: Phone Bridge offline — ${result.message}`
    case 'invalid':
      return `Resultado real da ação no celular${result.action ? ` (${result.action})` : ''}: não confirmado — ${result.message}`
    default:
      return null
  }
}

/**
 * Actions the model asked for in the current turn, in order. `stash(null)` clears the
 * queue; `stash(action)` appends (identical duplicates and anything past MAX_QUEUE are dropped).
 */
let queue: PhoneAction[] = []

export function stash(action: PhoneAction | null): void {
  if (action === null) {
    queue = []
    return
  }
  if (queue.length >= MAX_QUEUE) return
  const key = JSON.stringify(action)
  if (queue.some((q) => JSON.stringify(q) === key)) return
  queue.push(action)
}

/** Read the next stashed action without clearing it (orchestrator autonomy checks). */
export function peekPending(): PhoneAction | null {
  return queue[0] ?? null
}

/** Drop the next action without running it (rejected by validation or by the user). */
export function discardNext(): PhoneAction | null {
  return queue.shift() ?? null
}

export function pendingCount(): number {
  return queue.length
}

function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

async function adbReady(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE}/ping`, {
      headers: { 'X-Jarvis-Token': token },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })
    return Boolean(((await res.json()) as { adb?: boolean }).adb)
  } catch {
    return false
  }
}

type ActBody = { ok?: boolean; info?: unknown; error?: unknown; media?: PhoneMedia | null }

export async function fetchPhoneImage(media: PhoneMedia): Promise<string | null> {
  const token = readToken()
  if (!token || !media?.path) return null
  try {
    const res = await fetch(`${BRIDGE}/file?path=${encodeURIComponent(media.path)}`, {
      headers: { 'X-Jarvis-Token': token },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

/**
 * Run the stashed action (if any) against the local Termux bridge.
 * Returns a structured result based on the real /act response — never invents success.
 *
 * Optional `onFail` is kept for older call sites that only displayed errors;
 * preferred path is to inspect the returned PhoneResult.
 */
export async function runPending(
  onFail?: (message: string) => void,
): Promise<PhoneResult> {
  const action = queue.shift() ?? null
  if (!action) return { status: 'idle' }

  const actionName = String(action.a || '')

  // Do not trust a bridge we already know cannot speak our protocol.
  const gate = bridgeGate(actionName)
  if (gate) {
    onFail?.(gate.message)
    return gate
  }

  let token = readToken()
  if (!token) {
    token = (
      window.prompt('Cole o código que apareceu no Termux (servidor do celular).') ?? ''
    ).trim()
    if (!token) {
      const result: PhoneResult = {
        status: 'unauthorized',
        message: 'Sem o código do servidor do celular não consigo agir no celular.',
      }
      onFail?.(result.message)
      return result
    }
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* private mode: lasts for this session only */
    }
  }

  // Only the person can turn on auto-send, never the model.
  delete action.send
  if (action.a === 'whatsapp' && (await adbReady(token))) {
    const ok = window.confirm(
      `Enviar agora para ${String(action.to || 'o contato')}?\n\n"${String(action.text ?? '')}"`,
    )
    if (ok) action.send = true
  }

  try {
    const res = await fetch(`${BRIDGE}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jarvis-Token': token },
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(ACT_TIMEOUT_MS),
    })

    let data: ActBody = {}
    try {
      data = (await res.json()) as ActBody
    } catch {
      const result: PhoneResult = {
        status: 'invalid',
        message: 'Comando enviado, mas a resposta do celular não pôde ser lida.',
        action: actionName,
      }
      onFail?.(result.message)
      return result
    }

    if (res.status === 401) {
      try {
        localStorage.removeItem(TOKEN_KEY)
      } catch {
        /* storage unavailable */
      }
      const result: PhoneResult = {
        status: 'unauthorized',
        message:
          'O código do servidor do celular está errado. Veja o código no Termux e tente de novo.',
      }
      onFail?.(result.message)
      return result
    }

    // Bridge always answers 200 for known actions; ok discriminates success vs failure.
    if (data.ok === true) {
      const info =
        typeof data.info === 'string' && data.info.trim()
          ? data.info.trim()
          : ''
      if (!info) {
        // HTTP succeeded but no confirmation text from the action — do not claim execution.
        const result: PhoneResult = {
          status: 'invalid',
          message: 'Comando enviado, mas não consegui confirmar a execução.',
          action: actionName,
        }
        onFail?.(result.message)
        return result
      }
      const warn = bridgeWarning()
      return { status: 'ok', info: warn ? `${info}. Atenção: ${warn}` : info, action: actionName, ...(data.media ? { media: data.media } : {}) }
    }

    if (data.ok === false) {
      const errText =
        typeof data.error === 'string' && data.error.trim()
          ? data.error.trim()
          : `erro ${res.status}`
      // 400 from bridge = unknown action / bad payload → rejected
      const status: 'rejected' | 'failed' = res.status === 400 || res.status === 404 ? 'rejected' : 'failed'
      const message = `Celular: ${errText}`
      const result: PhoneResult = { status, message, action: actionName }
      onFail?.(message)
      return result
    }

    // Unexpected shape (no ok field, non-JSON-ish object, etc.)
    if (!res.ok) {
      const result: PhoneResult = {
        status: 'failed',
        message: `Celular: erro ${res.status}`,
        action: actionName,
      }
      onFail?.(result.message)
      return result
    }

    const result: PhoneResult = {
      status: 'invalid',
      message: 'Comando enviado, mas não consegui confirmar a execução.',
      action: actionName,
    }
    onFail?.(result.message)
    return result
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // The request left but no answer came back: the action may or may not have run.
      const result: PhoneResult = {
        status: 'failed',
        message: `O celular não respondeu em ${ACT_TIMEOUT_MS / 1000}s; não sei se a ação foi executada.`,
        action: actionName,
      }
      onFail?.(result.message)
      return result
    }
    // Copyable on a phone: the prompt's text field can be selected and pasted into Termux.
    const cmd = `pkg install -y nodejs termux-api android-tools; termux-setup-storage; curl -fsSL ${location.origin}/phone-bridge.mjs -o jarvis.mjs && termux-wake-lock && node jarvis.mjs`
    window.prompt(
      'O servidor do celular está desligado. Copie este comando, cole no Termux e rode:',
      cmd,
    )
    const result: PhoneResult = {
      status: 'offline',
      message: 'Servidor do celular desligado. Ligue no Termux e peça de novo.',
    }
    onFail?.(result.message)
    return result
  }
}

// ---------------------------------------------------------------------------
// Bridge presence monitor — uses only GET /ping (existing contract).
//   200 { ok: true, adb: boolean }  with valid token
//   401 { ok: false, error }        bridge up, token missing/wrong
//   network error                   bridge unreachable
// Never invents endpoints. Single interval; start/stop are idempotent.
// ---------------------------------------------------------------------------

/** unknown = not checked yet; online = HTTP response from bridge; offline = fetch failed. */
export type BridgeStatus = 'unknown' | 'online' | 'offline'

/**
 * Finer diagnosis behind `status`:
 *   online         handshake fine: protocol and version accepted, SHA matches the site's copy (or cannot be compared)
 *   offline        nothing answered on 127.0.0.1:8787
 *   unauthorized   bridge answered but rejected our code
 *   incompatible   bridge speaks a different protocol; actions are refused
 *   outdated       bridge is older than MIN_BRIDGE_VERSION (or reports no version at all)
 *   hash_mismatch  bridge file differs from the copy this site serves
 *   error          bridge answered something we cannot interpret (or locked us out)
 *   unknown        not checked yet
 */
export type BridgeHealth =
  | 'unknown'
  | 'online'
  | 'offline'
  | 'unauthorized'
  | 'incompatible'
  | 'outdated'
  | 'hash_mismatch'
  | 'error'

export type BridgeSnapshot = {
  status: BridgeStatus
  /** From /ping when token is accepted; otherwise null. */
  adb: boolean | null
  lastCheckAt: number | null
  lastError: string | null
  health: BridgeHealth
  version: string | null
  protocol: number | null
  /** SHA-256 the bridge reports for its own file. */
  bridgeSha: string | null
  /** SHA-256 of the phone-bridge.mjs this site serves (null if it could not be fetched). */
  siteSha: string | null
  /** Action names the bridge says it implements (null from old bridges). */
  actions: string[] | null
}

const PING_MS = 12_000

let bridgeSnap: BridgeSnapshot = {
  status: 'unknown',
  adb: null,
  lastCheckAt: null,
  lastError: null,
  health: 'unknown',
  version: null,
  protocol: null,
  bridgeSha: null,
  siteSha: null,
  actions: null,
}
let bridgeTimer: ReturnType<typeof setInterval> | null = null
let bridgeOnChange: ((s: BridgeSnapshot) => void) | null = null
let bridgeChecking = false
let lastHealth: BridgeHealth = 'unknown'
let healthListener: ((from: BridgeHealth, to: BridgeHealth) => void) | null = null

export function getBridgeSnapshot(): BridgeSnapshot {
  return bridgeSnap
}

/** Called when the diagnosed health changes (e.g. offline → online) — used to report reconnections. */
export function onBridgeHealthChange(fn: ((from: BridgeHealth, to: BridgeHealth) => void) | null): void {
  healthListener = fn
}

/** "13.0.0" → [13,0,0]; anything unparsable → null. */
export function parseVersion(v: unknown): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionAtLeast(v: unknown, min: string): boolean {
  const a = parseVersion(v)
  const b = parseVersion(min)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/** Human explanation per health, used by HUD, SYSTEM tools and spoken diagnostics. */
export function describeHealth(s: BridgeSnapshot): string {
  switch (s.health) {
    case 'online':
      return `online (versão ${s.version ?? '?'}${s.siteSha && s.bridgeSha ? ', SHA-256 confere' : ''})`
    case 'offline':
      return 'offline: nada respondeu no celular (ligue o servidor no Termux)'
    case 'unauthorized':
      return 'não autorizada: o código do servidor está ausente ou errado'
    case 'incompatible':
      return `incompatível: a ponte usa o protocolo ${s.protocol ?? '?'} e o site espera ${EXPECTED_PROTOCOL}; atualize a ponte`
    case 'outdated':
      return `desatualizada: ${s.version ? `versão ${s.version}` : 'sem versão'}, o mínimo é ${MIN_BRIDGE_VERSION}; atualize a ponte`
    case 'hash_mismatch':
      return 'o arquivo da ponte no Termux é diferente do que este site publica; baixe de novo'
    case 'error':
      return `erro: ${s.lastError ?? 'resposta inesperada'}`
    default:
      return 'ainda não verificada'
  }
}

/** Refuse to act through a bridge that is known to be wrong. Null = go ahead. */
type GateResult =
  | { status: 'invalid'; message: string; action: string }
  | { status: 'rejected'; message: string; action: string }

function bridgeGate(action: string): GateResult | null {
  const s = bridgeSnap
  if (s.health === 'incompatible') {
    return { status: 'invalid', action, message: `Não executei: a ponte do celular está ${describeHealth(s)}.` }
  }
  if (s.actions && action && !s.actions.includes(action)) {
    return {
      status: 'rejected',
      action,
      message: `A ponte do celular (versão ${s.version ?? '?'}) não implementa a ação "${action}".`,
    }
  }
  return null
}

/** Non-blocking caveat appended to a successful result so it is never accepted silently. */
function bridgeWarning(): string {
  const s = bridgeSnap
  if (s.health === 'outdated' || s.health === 'hash_mismatch') return `a ponte está ${describeHealth(s)}`
  return ''
}

function publish(next: BridgeSnapshot): void {
  const prev = lastHealth
  bridgeSnap = next
  lastHealth = next.health
  try {
    ;(window as unknown as { __bridge?: BridgeSnapshot }).__bridge = next
  } catch {
    /* non-browser */
  }
  bridgeOnChange?.(next)
  if (prev !== next.health && prev !== 'unknown') healthListener?.(prev, next.health)
}

// -- SHA-256 of the bridge file this site serves ---------------------------------
let siteShaCache: string | null = null
let siteShaTriedAt = 0

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function siteBridgeSha(): Promise<string | null> {
  if (siteShaCache) return siteShaCache
  if (Date.now() - siteShaTriedAt < 60_000) return null
  siteShaTriedAt = Date.now()
  try {
    const res = await fetch(`${location.origin}/phone-bridge.mjs`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    // Guard against an SPA fallback that answers with index.html for unknown files.
    const head = new TextDecoder().decode(buf.slice(0, 40))
    if (!head.startsWith('// Jarvis phone bridge')) return null
    siteShaCache = await sha256Hex(buf)
    return siteShaCache
  } catch {
    return null
  }
}

type PingBody = {
  ok?: boolean
  adb?: boolean
  version?: unknown
  protocol?: unknown
  sha256?: unknown
  actions?: unknown
}

async function checkBridgeOnce(): Promise<void> {
  if (bridgeChecking) return
  bridgeChecking = true
  const base = bridgeSnap
  const at = Date.now()
  const fail = (health: BridgeHealth, status: BridgeStatus, error: string | null): BridgeSnapshot => ({
    ...base,
    status,
    adb: null,
    lastCheckAt: at,
    lastError: error,
    health,
    ...(health === 'offline' || health === 'unauthorized'
      ? { version: null, protocol: null, bridgeSha: null, actions: null }
      : {}),
  })
  try {
    const token = readToken()
    const headers: Record<string, string> = {}
    if (token) headers['X-Jarvis-Token'] = token

    const res = await fetch(`${BRIDGE}/ping`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })

    // Any HTTP response means the process on 127.0.0.1:8787 answered.
    if (res.status === 401) {
      publish(fail('unauthorized', 'online', 'token ausente ou inválido no ping'))
      return
    }
    if (res.status === 429) {
      publish(fail('error', 'online', 'ponte bloqueou novas tentativas por 1 minuto (código errado várias vezes)'))
      return
    }
    if (res.status !== 200) {
      publish(fail('error', 'online', `ping HTTP ${res.status}`))
      return
    }

    let body: PingBody = {}
    try {
      body = (await res.json()) as PingBody
    } catch {
      /* old bridges always sent JSON; treat an unreadable body as no handshake */
    }
    const adb = typeof body.adb === 'boolean' ? body.adb : null
    const version = typeof body.version === 'string' ? body.version : null
    const protocol = typeof body.protocol === 'number' ? body.protocol : null
    const bridgeSha = typeof body.sha256 === 'string' && body.sha256 ? body.sha256.toLowerCase() : null
    const actions = Array.isArray(body.actions) ? body.actions.filter((x): x is string => typeof x === 'string') : null
    const siteSha = await siteBridgeSha()

    let health: BridgeHealth = 'online'
    let error: string | null = null
    if (protocol !== null && protocol !== EXPECTED_PROTOCOL) {
      health = 'incompatible'
    } else if (!version || !versionAtLeast(version, MIN_BRIDGE_VERSION)) {
      health = 'outdated'
    } else if (bridgeSha && siteSha && bridgeSha !== siteSha) {
      health = 'hash_mismatch'
    }
    const snap: BridgeSnapshot = {
      status: 'online',
      adb,
      lastCheckAt: at,
      lastError: null,
      health,
      version,
      protocol,
      bridgeSha,
      siteSha,
      actions,
    }
    if (health !== 'online') {
      error = describeHealth(snap)
      snap.lastError = error
    }
    publish(snap)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'falha de rede'
    publish(fail('offline', 'offline', msg))
  } finally {
    bridgeChecking = false
  }
}

/** Force a fresh handshake now (e.g. when the tab becomes visible again). */
export function recheckBridge(): void {
  void checkBridgeOnce()
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void checkBridgeOnce()
}
function onNetBack(): void {
  void checkBridgeOnce()
}

/**
 * Start periodic /ping. Safe to call more than once — only one interval runs.
 * `onChange` is replaced on each start (single subscriber: the store).
 */
export function startBridgeMonitor(onChange?: (s: BridgeSnapshot) => void): void {
  if (onChange) bridgeOnChange = onChange
  if (bridgeTimer) return
  // First check promptly; stay "unknown" until it completes.
  void checkBridgeOnce()
  // A phone browser freezes timers while the tab is hidden: re-handshake the moment it is back.
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', onNetBack)
  bridgeTimer = setInterval(() => {
    void checkBridgeOnce()
  }, PING_MS)
}

/** Stop the interval. Idempotent. Does not reset last snapshot. */
export function stopBridgeMonitor(): void {
  if (bridgeTimer) {
    clearInterval(bridgeTimer)
    bridgeTimer = null
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', onNetBack)
  }
  bridgeOnChange = null
}
