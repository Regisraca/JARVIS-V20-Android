// Jarvis phone bridge. Runs inside Termux, no dependencies.
// It only does the fixed actions listed in ACTIONS: it never runs a command it
// was handed, and it only answers to requests that carry the secret code.
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Identity of this bridge. The page compares VERSION/PROTOCOL for compatibility and
// SHA256 (of this very file) against the copy the site serves, so a stale or edited
// bridge is reported instead of being trusted silently.
const VERSION = '20.0.0'
const PROTOCOL = 2
const PORT = Number(process.env.JARVIS_BRIDGE_PORT) || 8787
const HOME = process.env.JARVIS_BRIDGE_HOME || homedir()
let SHA256 = ''
try {
  SHA256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
} catch {
  /* hash is best-effort: the page reports "unknown" instead of guessing */
}

let token = ''
try {
  token = readFileSync(join(HOME, '.jarvis-token'), 'utf8').trim()
} catch {
  /* first run */
}
if (!token) {
  token = randomBytes(6).toString('hex')
  writeFileSync(join(HOME, '.jarvis-token'), token)
}

const pkgFor = (cmd) => (cmd === 'adb' ? 'android-tools' : cmd.startsWith('termux-') ? 'termux-api' : '')

// Errors are read out loud by the app, so "spawn termux-torch ENOENT" becomes something a person can act on.
const sh = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 4_000_000 }, (err, out, errOut) => {
      if (!err) return resolve(out)
      if (err.code === 'ENOENT') {
        const pkg = pkgFor(cmd)
        return reject(new Error(`faltou o comando ${cmd}${pkg ? ` (no Termux: pkg install ${pkg})` : ''}`))
      }
      if (err.killed) {
        const hint = cmd.startsWith('termux-') ? ': confira se o app Termux:API está instalado e com permissão' : ''
        return reject(new Error(`${cmd} não respondeu em 20s${hint}`))
      }
      reject(new Error((errOut || err.message || 'falhou').trim().slice(0, 200)))
    })
  })

const norm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

const APPS = {
  whatsapp: 'com.whatsapp',
  spotify: 'com.spotify.music',
  youtube: 'com.google.android.youtube',
  ytmusic: 'com.google.android.apps.youtube.music',
  chrome: 'com.android.chrome',
  maps: 'com.google.android.apps.maps',
}
  
const MESSAGE_APPS = {
  whatsapp: 'com.whatsapp',
  telegram: 'org.telegram.messenger',
  messenger: 'com.facebook.orca',
  instagram: 'com.instagram.android',
  signal: 'org.thoughtcrime.securesms',
}

const openUrl = (url) => {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('só abro links http ou https')
  return sh('termux-open-url', [String(url)])
}

async function launch(pkg) {
  // Android/Termux builds differ in how `am -p` resolves launcher activities.
  // Resolve the real launcher component first, then start it explicitly.
  try {
    const resolved = await sh('cmd', ['package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', pkg])
    const component = String(resolved).split(/\r?\n/).map((x) => x.trim()).filter((x) => x && x.includes('/')).pop()
    if (component) {
      await sh('am', ['start', '-n', component])
      return
    }
  } catch {
    // Fall through to the broad launcher fallback below.
  }
  try {
    await sh('monkey', ['-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
    return
  } catch {
    await sh('am', ['start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg])
  }
}

async function startAndroidAction(action, value = '') {
  try {
    await sh('cmd', ['activity', 'start-activity', '-a', action, ...(value ? ['-d', value] : [])])
  } catch {
    await sh('am', ['start', '-a', action, ...(value ? ['-d', value] : [])])
  }
}

async function findContact(name) {
  let list = []
  try {
    list = JSON.parse(await sh('termux-contact-list', []))
  } catch {
    return null
  }
  const q = norm(name)
  const toks = q.split(/\s+/).filter(Boolean)
  const ok = list.filter((c) => c.number && toks.every((t) => norm(c.name || '').includes(t)))
  return ok.find((c) => norm(c.name) === q) || ok[0] || null
}

const ROOTS = ['Download', 'Documents', 'Music', 'DCIM', 'Pictures', 'Movies'].map((d) =>
  join(HOME, 'storage', 'shared', d),
)

function findFile(query) {
  const toks = norm(query).split(/\s+/).filter(Boolean)
  let best = null
  let seen = 0
  const walk = (dir, depth) => {
    if (depth > 4 || seen > 20000) return
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith('.')) continue
      const p = join(dir, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      seen++
      if (st.isDirectory()) walk(p, depth + 1)
      else if (toks.length && toks.every((t) => norm(n).includes(t))) {
        if (!best || st.mtimeMs > best.t) best = { p, t: st.mtimeMs }
      }
    }
  }
  ROOTS.forEach((r) => walk(r, 0))
  return best && best.p
}

function safeTextFilePath(path) {
  const resolved = String(path || '')
  if (!resolved) return ''
  const roots = ROOTS.map((r) => r + '/')
  return roots.some((r) => resolved.startsWith(r)) ? resolved : ''
}

function findLatestPhoto() {
  const roots = [
    join(HOME, 'storage', 'shared', 'DCIM'),
    join(HOME, 'storage', 'shared', 'Pictures'),
  ]
  let best = null
  const visit = (dir, depth = 0) => {
    if (depth > 2) return
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const path = join(dir, n)
      try {
        const st = statSync(path)
        if (st.isDirectory()) { visit(path, depth + 1); continue }
        if (!/\.(jpe?g|png|webp|heic|heif)$/i.test(n)) continue
        if (!best || st.mtimeMs > best.t) best = { path, name: n, t: st.mtimeMs }
      } catch {}
    }
  }
  for (const root of roots) visit(root)
  return best
}

// -- wireless debugging to this same phone (optional): print and auto-send ----
async function adbTarget() {
  let out = ''
  try {
    out = await sh('adb', ['devices'])
  } catch {
    return ''
  }
  const line = out.split('\n').find((l) => /\tdevice\s*$/.test(l))
  return line ? line.split('\t')[0] : ''
}

async function adb(args) {
  const target = await adbTarget()
  if (!target) throw new Error('depuração sem fio não conectada (no Termux: pkg install android-tools e depois adb connect localhost:PORTA)')
  return sh('adb', ['-s', target, ...args])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function uiDump() {
  if (!(await adbTarget())) throw new Error('depuração sem fio não conectada')
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/jarvis-ui.xml'])
  return adb(['shell', 'cat', '/sdcard/jarvis-ui.xml'])
}

function uiNodes(xml, pkg = '') {
  const out = []
  for (const node of String(xml).match(/<node [^>]*>/g) || []) {
    if (pkg && !new RegExp(`package="${pkg.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}"`).test(node)) continue
    const text = /text="([^"]*)"/.exec(node)?.[1] || ''
    const desc = /content-desc="([^"]*)"/.exec(node)?.[1] || ''
    const id = /resource-id="([^"]*)"/.exec(node)?.[1] || ''
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)
    if (!b || (!text && !desc && !id)) continue
    out.push({
      text: text || desc || id,
      desc, id,
      x: Math.round((+b[1] + +b[3]) / 2),
      y: Math.round((+b[2] + +b[4]) / 2),
      clickable: /clickable="true"/.test(node),
      raw: node,
    })
  }
  return out
}

async function tapUiText(query, pkg = '', waitMs = 800) {
  const q = norm(query)
  if (!q) throw new Error('texto de interface vazio')
  const xml = await uiDump()
  const nodes = uiNodes(xml, pkg)
  const hit = nodes.find((n) => norm(n.text) === q && n.clickable) ||
    nodes.find((n) => norm(n.text).includes(q) && n.clickable) ||
    nodes.find((n) => norm(n.text) === q)
  if (!hit) return false
  await adb(['shell', 'input', 'tap', String(hit.x), String(hit.y)])
  await sleep(Math.max(200, Math.min(Number(waitMs) || 800, 3000)))
  return true
}

async function openInApp(pkg, url) {
  await sh('am', ['start', '-a', 'android.intent.action.VIEW', '-d', String(url), '-p', pkg])
}

function mediaForPath(path, name = '') {
  return { type: 'image', path: String(path), name: String(name || path).split('/').pop() || 'imagem' }
}

// Finds WhatsApp's send button on screen and taps it.
async function tapSend() {
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 3000 : 1200)
    let xml = ''
    try {
      await adb(['shell', 'uiautomator', 'dump', '/sdcard/jarvis-ui.xml'])
      xml = await adb(['shell', 'cat', '/sdcard/jarvis-ui.xml'])
    } catch {
      continue
    }
    for (const node of xml.match(/<node [^>]*>/g) || []) {
      if (!/package="com\.whatsapp/.test(node)) continue
      if (!/resource-id="[^"]*:id\/send"/.test(node) && !/content-desc="(Enviar|Send)"/.test(node)) continue
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)
      if (!b) continue
      await adb(['shell', 'input', 'tap', String(Math.round((+b[1] + +b[3]) / 2)), String(Math.round((+b[2] + +b[4]) / 2))])
      return true
    }
  }
  return false
}

const ACTIONS = {
  async url({ url }) {
    await openUrl(url)
    return 'abri o link'
  },

  async musica({ q = '', app = 'spotify' }) {
    const e = encodeURIComponent(String(q))
    const urls = {
      spotify: `https://open.spotify.com/search/${e}`,
      youtube: `https://www.youtube.com/results?search_query=${e}`,
      ytmusic: `https://music.youtube.com/search?q=${e}`,
    }
    await openUrl(urls[app] || urls.spotify)
    return 'abri a busca da música'
  },

  async app({ nome = '' }) {
    const raw = norm(nome).replace(/\s+/g, ' ').trim()
    const aliases = {
      'youtube music': 'ytmusic',
      'youtube music app': 'ytmusic',
      ytmusic: 'ytmusic',
      'whats app': 'whatsapp',
      'google maps': 'maps',
      navegador: 'chrome',
    }
    const n = aliases[raw] || raw
    if (n === 'camera') await sh('am', ['start', '-a', 'android.media.action.STILL_IMAGE_CAMERA'])
    else if (n.startsWith('config')) await startAndroidAction('android.settings.SETTINGS')
    else if (n === 'chrome') await sh('termux-open-url', ['https://www.google.com'])
    else if (APPS[n]) await launch(APPS[n])
    else throw new Error(`não conheço o app "${nome}"`)
    return `abri ${n === 'ytmusic' ? 'o YouTube Music' : 'o app'}`
  },

  async arquivo({ nome = '' }) {
    const path = findFile(nome)
    if (!path) {
      throw new Error(`não achei "${nome}" (se for a primeira vez, rode: termux-setup-storage)`)
    }
    await sh('termux-open', [path])
    return 'abri o arquivo'
  },

  async ler_arquivo({ nome = '', maxBytes = 200000 }) {
    const path = findFile(nome)
    if (!path) throw new Error(`não achei "${nome}" nos diretórios compartilhados`)
    if (!/\.(txt|md|csv|json|log|ini|cfg|xml|yaml|yml)$/i.test(path)) {
      throw new Error('por segurança, a leitura interna desta ação aceita apenas arquivos de texto estruturado')
    }
    const st = statSync(path)
    const limit = Math.max(1000, Math.min(Number(maxBytes) || 200000, 500000))
    const text = readFileSync(path, 'utf8')
    const clipped = text.length > limit ? text.slice(0, limit) + '\n[conteúdo cortado por limite de leitura]' : text
    return JSON.stringify({ tipo: 'arquivo', nome: path.split('/').pop(), caminho: path, tamanho: st.size, conteudo: clipped })
  },

  async abrir_ultima_foto() {
    const last = findLatestPhoto()
    if (!last) throw new Error('não encontrei uma foto recente na pasta DCIM')
    await sh('termux-open', [last.path])
    return { info: 'abri a última foto (confirmado)', media: mediaForPath(last.path, last.name) }
  },

  async whatsapp({ to = '', text = '', send = false }) {
    let digits = String(to).replace(/\D/g, '')
    let info = 'abri o WhatsApp com a mensagem; toque em enviar'
    if (digits.length < 8 && String(to).trim()) {
      const hit = await findContact(to)
      if (hit) digits = String(hit.number).replace(/\D/g, '')
      else {
        digits = ''
        info = `não achei "${to}" nos contatos; abri o WhatsApp para você escolher`
      }
    }
    if (digits.length >= 8 && digits.length <= 11) digits = '55' + digits
    await openUrl(`https://wa.me/${digits}?text=${encodeURIComponent(String(text))}`)
    // Only the person can turn `send` on (the page asks first); the model never can.
    if (send === true && digits) {
      if (!(await adbTarget())) return info + ' (para enviar sozinho falta a depuração sem fio)'
      return (await tapSend()) ? 'mensagem enviada' : 'abri o WhatsApp, mas não achei o botão de enviar; toque você'
    }
    return info
  },

  // --- CONTROLE DO CELULAR ---

  // `input` and `am force-stop` are refused for Termux's own user (no INJECT_EVENTS /
  // FORCE_STOP_PACKAGES); they only work as the adb shell user, so they go through wireless debugging.
  async home() {
    await adb(['shell', 'input', 'keyevent', '3'])
    return 'voltei para a tela inicial'
  },

  async voltar() {
    await adb(['shell', 'input', 'keyevent', '4'])
    return 'voltei'
  },

  async recentes() {
    await adb(['shell', 'input', 'keyevent', '187'])
    return 'abri os aplicativos recentes'
  },

  async wifi({ ligado = null, modo = '' } = {}) {
    if (modo === 'configuracoes') {
      await sh('am', ['start', '-a', 'android.settings.WIFI_SETTINGS'])
      return 'abri as configurações de Wi-Fi'
    }
    const stateRaw = await sh('settings', ['get', 'global', 'wifi_on'])
    const state = String(stateRaw).trim() === '1'
    if (ligado === null || ligado === undefined || ligado === '') {
      return state ? 'o seu Wi-Fi já está ligado' : 'o seu Wi-Fi está desligado'
    }
    const want = ligado === true || String(ligado).toLowerCase() === 'true' || String(ligado).toLowerCase() === 'on'
    if (state === want) return want ? 'o seu Wi-Fi já está ligado' : 'o seu Wi-Fi já está desligado'
    await sh('svc', ['wifi', want ? 'enable' : 'disable'])
    await sleep(500)
    const after = String(await sh('settings', ['get', 'global', 'wifi_on'])).trim() === '1'
    if (after !== want) throw new Error(`pedi para ${want ? 'ligar' : 'desligar'} o Wi-Fi, mas o Android não confirmou a mudança`)
    return want ? 'liguei o Wi-Fi (confirmado)' : 'desliguei o Wi-Fi (confirmado)'
  },

  async bluetooth({ ligado = null, modo = '' } = {}) {
    if (modo === 'configuracoes') {
      await sh('am', ['start', '-a', 'android.settings.BLUETOOTH_SETTINGS'])
      return 'abri as configurações de Bluetooth'
    }
    const stateRaw = await sh('settings', ['get', 'global', 'bluetooth_on'])
    const state = String(stateRaw).trim() === '1'
    if (ligado === null || ligado === undefined || ligado === '') {
      return state ? 'o seu Bluetooth já está ligado' : 'o seu Bluetooth está desligado'
    }
    const want = ligado === true || String(ligado).toLowerCase() === 'true' || String(ligado).toLowerCase() === 'on'
    if (state === want) return want ? 'o seu Bluetooth já está ligado' : 'o seu Bluetooth já está desligado'
    await sh('svc', ['bluetooth', want ? 'enable' : 'disable'])
    await sleep(700)
    const after = String(await sh('settings', ['get', 'global', 'bluetooth_on'])).trim() === '1'
    if (after !== want) throw new Error(`pedi para ${want ? 'ligar' : 'desligar'} o Bluetooth, mas o Android não confirmou a mudança`)
    return want ? 'liguei o Bluetooth (confirmado)' : 'desliguei o Bluetooth (confirmado)'
  },

  async notificacoes() {
    await sh('am', ['start', '-a', 'android.settings.NOTIFICATION_SETTINGS'])
    return 'abri as configurações de notificações'
  },

  // Read notifications on demand. Termux:API uses Android's NotificationListenerService;
  // notification access must be granted by the user. Nothing is polled or uploaded in the bridge.
  async ler_notificacoes({ app = '', limite = 8, busca = '' }) {
    let list
    try {
      list = JSON.parse(await sh('termux-notification-list', []))
    } catch (err) {
      throw new Error(`não consegui ler as notificações. Verifique o acesso às notificações do Termux:API nas configurações do Android e tente novamente (${err.message})`)
    }
    if (!Array.isArray(list)) list = []
    const n = Math.max(1, Math.min(Number(limite) || 8, 20))
    const appQ = norm(app)
    const appPkg = MESSAGE_APPS[appQ] || ''
    const searchQ = norm(busca)
    const filtered = list.filter((x) => {
      const pkg = norm(x.packageName || '')
      const hay = norm(`${x.packageName || ''} ${x.title || ''} ${x.content || ''} ${(x.lines || []).join(' ')}`)
      return (!appQ || (appPkg ? pkg === appPkg : pkg.includes(appQ) || hay.includes(appQ))) && (!searchQ || hay.includes(searchQ))
    })
    const rows = filtered.slice(0, n).map((x) => ({
      app: x.packageName || '',
      titulo: x.title || '',
      mensagem: x.content || (Array.isArray(x.lines) ? x.lines.join(' ') : ''),
      quando: x.when || '',
    }))
    if (!rows.length) return 'não encontrei notificações correspondentes'
    return JSON.stringify({ tipo: 'notificacoes', quantidade: rows.length, itens: rows })
  },

  // Unified messaging view: WhatsApp/Telegram/etc. are read from Android notifications.
  // This does NOT claim access to the full in-app chat history.
  async ler_mensagens({ app = '', limite = 8, busca = '' }) {
    const allowed = app ? norm(app) : ''
    const known = new Set(Object.keys(MESSAGE_APPS))
    const apps = allowed && known.has(allowed) ? [allowed] : allowed ? [allowed] : Object.keys(MESSAGE_APPS)
    const chunks = []
    for (const name of apps) {
      const result = await ACTIONS.ler_notificacoes({ app: name, limite, busca })
      if (result && !/^não encontrei/i.test(result)) chunks.push({ app: name, dados: JSON.parse(result) })
    }
    if (!chunks.length) return 'não encontrei mensagens recentes nas notificações dos aplicativos de mensagens'
    return JSON.stringify({ tipo: 'mensagens', fontes: chunks })
  },

  // SMS inbox is a separate Android permission and is intentionally read-only here.
  async ler_sms({ limite = 8, busca = '' }) {
    let list
    try {
      list = JSON.parse(await sh('termux-sms-list', ['-l', String(Math.max(1, Math.min(Number(limite) || 8, 20)))]))
    } catch (err) {
      throw new Error(`${err.message}; dê permissão de SMS ao Termux:API e tente novamente`)
    }
    if (!Array.isArray(list)) list = []
    const q = norm(busca)
    const rows = list.filter((x) => !q || norm(`${x.number || ''} ${x.sender || ''} ${x.body || ''}`).includes(q)).slice(0, 20)
    if (!rows.length) return 'não encontrei SMS correspondentes'
    return JSON.stringify({ tipo: 'sms', quantidade: rows.length, itens: rows.map((x) => ({
      remetente: x.number || x.sender || '',
      mensagem: x.body || '',
      data: x.received || x.date || '',
      lida: x.read,
    })) })
  },

  async whatsapp_print_ultimas({ quantidade = 5 }) {
    const n = Math.max(1, Math.min(Number(quantidade) || 5, 10))
    if (!(await adbTarget())) throw new Error('para capturar as conversas do WhatsApp preciso da depuração sem fio conectada')
    await launch('com.whatsapp')
    const saved = []
    const seen = new Set()
    for (let i = 0; i < n; i++) {
      await sleep(1800)
      let xml = ''
      try {
        await adb(['shell', 'uiautomator', 'dump', '/sdcard/jarvis-ui.xml'])
        xml = await adb(['shell', 'cat', '/sdcard/jarvis-ui.xml'])
      } catch { break }
      const nodes = []
      for (const node of xml.match(/<node [^>]*>/g) || []) {
        if (!/package="com\.whatsapp"/.test(node) || !/clickable="true"/.test(node)) continue
        const text = /text="([^"]*)"/.exec(node)?.[1] || ''
        const desc = /content-desc="([^"]*)"/.exec(node)?.[1] || ''
        const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node)
        if (!b || (!text && !desc)) continue
        const key = `${text}|${desc}|${b[1]}|${b[2]}|${b[3]}|${b[4]}`
        if (!seen.has(key)) nodes.push({ key, text: text || desc, x: Math.round((+b[1] + +b[3]) / 2), y: Math.round((+b[2] + +b[4]) / 2) })
      }
      const candidate = nodes.find((x) => x.y > 120 && x.y < 2200 && !/Chats|Conversas|Status|Chamadas|Comunidades|Pesquisar/i.test(x.text))
      if (!candidate) break
      seen.add(candidate.key)
      await adb(['shell', 'input', 'tap', String(candidate.x), String(candidate.y)])
      await sleep(1200)
      const file = `/sdcard/Pictures/jarvis-whatsapp-${Date.now()}-${i + 1}.png`
      await adb(['shell', 'screencap', '-p', file])
      const listed = (await adb(['shell', 'ls', '-l', file]).catch(() => '')).trim()
      if (!listed || /No such file/i.test(listed)) throw new Error(`não consegui confirmar o print ${i + 1}`)
      saved.push(file)
      await adb(['shell', 'input', 'keyevent', '4'])
    }
    if (!saved.length) throw new Error('não consegui identificar as conversas na tela do WhatsApp')
    return `salvei ${saved.length} print${saved.length === 1 ? '' : 's'} das conversas do WhatsApp (confirmado)`
  },

  async fechar({ nome = '' }) {
    const n = norm(nome)
    if (!APPS[n]) throw new Error(`não sei fechar o app "${nome}"`)
    await adb(['shell', 'am', 'force-stop', APPS[n]])
    return 'fechei o app'
  },

  async lanterna({ ligada = true }) {
    const v = ligada === true || String(ligada).toLowerCase() === 'true' || String(ligada).toLowerCase() === 'on'
    await sh('termux-torch', [v ? 'on' : 'off'])
    return v ? 'liguei a lanterna' : 'desliguei a lanterna'
  },

  async piscar_lanterna({ vezes = 3, intervalo = 300 }) {
    let n = Math.max(1, Math.min(Number(vezes) || 3, 20))
    let ms = Math.max(80, Math.min(Number(intervalo) || 300, 2000))
    for (let i = 0; i < n; i++) {
      await sh('termux-torch', ['on'])
      await sleep(ms)
      await sh('termux-torch', ['off'])
      if (i + 1 < n) await sleep(ms)
    }
    return `pisquei a lanterna ${n} vez${n === 1 ? '' : 'es'} (confirmado)`
  },

  async vibrar({ duracao = 300 }) {
    let ms = Number(duracao)
    if (!Number.isFinite(ms)) ms = 300
    ms = Math.max(1, Math.min(ms, 10000))
    await sh('termux-vibrate', ['-d', String(Math.round(ms))])
    return 'celular vibrado'
  },

  async bateria() {
    const out = await sh('termux-battery-status', [])
    return out.trim()
  },

  async volume({ stream = 'music', nivel = null }) {
    const streams = ['call', 'system', 'ring', 'music', 'alarm', 'notification', 'accessibility']
    const st = norm(stream)
    if (!streams.includes(st)) throw new Error(`canal de volume inválido: ${stream}`)

    if (nivel === null || nivel === undefined || nivel === '') {
      return (await sh('termux-volume', [])).trim()
    }

    let v = Number(nivel)
    if (!Number.isFinite(v)) throw new Error('volume inválido')
    v = Math.max(0, Math.min(15, Math.round(v)))

    await sh('termux-volume', [st, String(v)])
    // EXECUTE -> VERIFY: read the real level back (termux-volume prints JSON for every stream).
    try {
      const now = JSON.parse(await sh('termux-volume', [])).find((x) => x && x.stream === st)
      if (now && Number.isFinite(Number(now.volume))) {
        return Number(now.volume) === v
          ? `volume de ${st} ajustado para ${v} (confirmado)`
          : `pedi volume ${v} em ${st}, mas o celular está em ${now.volume} (o Android pode limitar esse canal)`
      }
    } catch {
      /* fall through: say plainly that it could not be verified */
    }
    return `volume de ${st} ajustado para ${v} (não consegui confirmar o nível)`
  },

  async falar({ texto = '' }) {
    const t = String(texto).trim()
    if (!t) throw new Error('não recebi o texto para falar')
    await sh('termux-tts-speak', [t])
    return 'falei o texto'
  },

  async copiar({ texto = '' }) {
    const t = String(texto)
    await sh('termux-clipboard-set', [t])
    // EXECUTE -> VERIFY: read the clipboard back instead of trusting the exit code.
    const back = (await sh('termux-clipboard-get', [])).trim()
    if (back !== t.trim()) throw new Error('copiei, mas não consegui confirmar o conteúdo na área de transferência')
    return 'texto copiado para a área de transferência (confirmado)'
  },

  async colar() {
    return (await sh('termux-clipboard-get', [])).trim()
  },

  async aviso({ texto = '' }) {
    const t = String(texto).trim()
    if (!t) throw new Error('não recebi o texto do aviso')
    await sh('termux-toast', [t])
    return 'aviso exibido'
  },

  async foto({ nome = '', camera = 0 }) {
    const base = String(nome).trim() || `jarvis-${Date.now()}.jpg`
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_')
    const path = join(HOME, 'storage', 'shared', 'DCIM', safe)
    const cam = Number(camera) === 1 ? 1 : 0
    await sh('termux-camera-photo', ['-c', String(cam), path])
    let size = 0
    try { size = statSync(path).size } catch {}
    if (!size) throw new Error('a câmera respondeu, mas a foto não apareceu na pasta DCIM (permissão de câmera/armazenamento?)')
    return { info: `foto ${cam === 1 ? 'frontal' : 'traseira'} salva em ${safe} (confirmado)`, media: mediaForPath(path, safe) }
  },

  async ytmusic_tocar({ q = '' }) {
    const query = String(q).trim()
    if (!query) throw new Error('não recebi o que tocar no YouTube Music')
    await launch(APPS.ytmusic)
    await sleep(900)
    await openInApp(APPS.ytmusic, `https://music.youtube.com/search?q=${encodeURIComponent(query)}`)
    await sleep(2200)
    const xml = await uiDump()
    const nodes = uiNodes(xml, APPS.ytmusic)
    const stop = new Set(['home','explorar','biblioteca','pesquisar','search','início','inicio'])
    const candidate = nodes.find((n) => n.clickable && n.y > 180 && n.y < 2100 && norm(n.text).length > 2 && !stop.has(norm(n.text)))
    if (!candidate) throw new Error('abri o YouTube Music, mas não consegui identificar um resultado para tocar')
    await adb(['shell', 'input', 'tap', String(candidate.x), String(candidate.y)])
    await sleep(1200)
    return `pesquisei "${query}" e toquei o primeiro resultado identificado (confirmado)`
  },

  async spotify_tocar({ q = '' }) {
    const query = String(q).trim()
    if (!query) throw new Error('não recebi o que tocar no Spotify')
    await launch(APPS.spotify)
    await sleep(900)
    await openInApp(APPS.spotify, `https://open.spotify.com/search/${encodeURIComponent(query)}`)
    await sleep(2200)
    const xml = await uiDump()
    const nodes = uiNodes(xml, APPS.spotify)
    const candidate = nodes.find((n) => n.clickable && n.y > 180 && n.y < 2100 && norm(n.text).length > 2 && !/pesquisar|search|inicio|home|biblioteca/.test(norm(n.text)))
    if (!candidate) throw new Error('abri o Spotify, mas não consegui identificar um resultado para tocar')
    await adb(['shell', 'input', 'tap', String(candidate.x), String(candidate.y)])
    await sleep(1200)
    return `pesquisei "${query}" e toquei o primeiro resultado identificado (confirmado)`
  },

  async app_pesquisar({ app = 'youtube', q = '' }) {
    const key = norm(app)
    const query = String(q).trim()
    if (!query) throw new Error('não recebi o que pesquisar')
    const pkg = APPS[key]
    if (!pkg) throw new Error(`app não suportado: ${app}`)
    await launch(pkg)
    await sleep(900)
    if (key === 'youtube') await openInApp(pkg, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`)
    else if (key === 'chrome') await openInApp(pkg, `https://www.google.com/search?q=${encodeURIComponent(query)}`)
    else if (key === 'maps') await openInApp(pkg, `https://www.google.com/maps/search/${encodeURIComponent(query)}`)
    else throw new Error(`pesquisa interna ainda não implementada para ${app}`)
    return `abri ${key} com a pesquisa "${query}" (confirmado)`
  },

  async ui_ler_tela({ app = '' }) {
    const pkg = APPS[norm(app)] || ''
    const xml = await uiDump()
    const nodes = uiNodes(xml, pkg)
    const texts = [...new Set(nodes.map((n) => n.text).filter(Boolean))].slice(0, 80)
    if (!texts.length) throw new Error('não encontrei texto legível na tela atual')
    return JSON.stringify({ tipo: 'tela', app: norm(app) || 'atual', textos: texts })
  },

  async whatsapp_ler_conversa({ pessoa = '' }) {
    const name = String(pessoa).trim()
    if (!name) throw new Error('diga o nome da pessoa da conversa')
    await launch(APPS.whatsapp)
    await sleep(1800)
    const opened = await tapUiText(name, APPS.whatsapp, 1500)
    if (!opened) throw new Error(`não encontrei "${name}" na tela do WhatsApp`)
    const xml = await uiDump()
    const nodes = uiNodes(xml, APPS.whatsapp)
    const texts = [...new Set(nodes.map((n) => n.text).filter((t) => t && norm(t) !== norm(name) && !/mensagem|digite uma mensagem|pesquisar|search|emoji|anexar/.test(norm(t))))].slice(-30)
    if (!texts.length) throw new Error('abri a conversa, mas não consegui identificar mensagens legíveis')
    return JSON.stringify({ tipo: 'whatsapp_conversa', pessoa: name, mensagens: texts })
  },

  async whatsapp_pendencias() {
    await launch(APPS.whatsapp)
    await sleep(1800)
    const xml = await uiDump()
    const nodes = uiNodes(xml, APPS.whatsapp)
    const rows = []
    for (const n of nodes) {
      const t = n.text.trim()
      if (!t || n.y < 140 || n.y > 2200) continue
      if (/conversas|chats|status|chamadas|comunidades|pesquisar|search/i.test(t)) continue
      if (/\b\d{1,3}\b/.test(t) || /não lida|unread/i.test(t)) rows.push(t)
    }
    const unique = [...new Set(rows)].slice(0, 20)
    return JSON.stringify({ tipo: 'whatsapp_pendencias', quantidade_identificadas: unique.length, itens: unique })
  },

  async sequencia({ passos = [] }) {
    if (!Array.isArray(passos) || passos.length < 1 || passos.length > 12) throw new Error('sequência deve ter de 1 a 12 passos')
    // A sequence is already confirmed once by the web client. Allow reversible/read
    // actions plus camera/screenshot inside it; never allow messaging or force-stop.
    const safe = new Set(['lanterna','piscar_lanterna','vibrar','aviso','volume','bateria','foto','abrir_ultima_foto','arquivo','ler_arquivo','app','url','musica','home','voltar','recentes','wifi','bluetooth','notificacoes','configuracoes','copiar','colar','print','ytmusic_tocar','spotify_tocar','app_pesquisar','ui_ler_tela','whatsapp_ler_conversa','whatsapp_pendencias'])
    const results = []
    let media = null
    for (const raw of passos) {
      if (!raw || typeof raw !== 'object') throw new Error('passo de sequência inválido')
      const step = raw
      const name = String(step.a || '')
      if (!safe.has(name)) throw new Error(`ação ${name} não pode ser executada dentro de uma sequência`)
      const outcome = await ACTIONS[name](step)
      if (outcome && typeof outcome === 'object' && outcome.media) media = outcome.media
      results.push({ a: name, info: typeof outcome === 'object' && outcome?.info ? outcome.info : outcome })
      if (name === 'app' || name === 'configuracoes' || name === 'wifi' || name === 'bluetooth') {
        await sleep(Math.max(300, Math.min(Number(step.esperarMs) || 900, 3000)))
      }
    }
    return { info: JSON.stringify({ tipo: 'sequencia', passos: results }), ...(media ? { media } : {}) }
  },

  async configuracoes() {
    await startAndroidAction('android.settings.SETTINGS')
    return 'abri as configurações'
  },

  // Needs wireless debugging connected to this same phone.
  async print({ app = '' }) {
    const n = norm(app)
    if (APPS[n]) {
      await launch(APPS[n])
      await sleep(3000)
    } else {
      await sleep(800)
    }
    const file = `/sdcard/Pictures/jarvis-print-${Date.now()}.png`
    await adb(['shell', 'screencap', '-p', file])
    // EXECUTE -> VERIFY: the screenshot file must exist on the device.
    const listed = (await adb(['shell', 'ls', '-l', file]).catch(() => '')).trim()
    if (!listed || /No such file/i.test(listed)) throw new Error('o comando de print rodou, mas o arquivo não foi encontrado')
    await adb(['shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${file}`]).catch(() => {})
    return 'print salvo na pasta Imagens (confirmado)'
  },
}

// Constant-time token check, plus a short lockout so the 48-bit code cannot be brute-forced.
const sameToken = (given) => {
  const a = Buffer.from(String(given || ''))
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}
let misses = []
const lockedOut = () => {
  const now = Date.now()
  misses = misses.filter((t) => now - t < 60_000)
  return misses.length >= 10
}

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Headers': 'content-type, x-jarvis-token',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  }
  const send = (code, body) => {
    res.writeHead(code, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }
  if (lockedOut()) return send(429, { ok: false, error: 'muitas tentativas erradas; aguarde 1 minuto' })
  if (!sameToken(req.headers['x-jarvis-token'])) {
    misses.push(Date.now())
    return send(401, { ok: false, error: 'código errado' })
  }
  if (req.url === '/ping') {
    return send(200, {
      ok: true,
      adb: Boolean(await adbTarget()),
      version: VERSION,
      protocol: PROTOCOL,
      sha256: SHA256,
      actions: Object.keys(ACTIONS),
    })
  }
  if (req.method === 'GET' && req.url.startsWith('/file?')) {
    const u = new URL(req.url, 'http://127.0.0.1')
    const path = u.searchParams.get('path') || ''
    const safeRoots = [join(HOME, 'storage', 'shared', 'DCIM') + '/', join(HOME, 'storage', 'shared', 'Pictures') + '/']
    const allowed = safeRoots.some((r) => path.startsWith(r))
    if (!allowed) return send(403, { ok: false, error: 'arquivo fora da área permitida' })
    let st
    try { st = statSync(path) } catch { return send(404, { ok: false, error: 'arquivo não encontrado' }) }
    if (!st.isFile() || st.size > 12_000_000) return send(413, { ok: false, error: 'imagem inválida ou grande demais' })
    const ext = path.toLowerCase().split('.').pop()
    const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
    res.writeHead(200, { ...cors, 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'private, max-age=60' })
    return createReadStream(path).pipe(res)
  }

  if (req.method !== 'POST' || req.url !== '/act') return send(404, { ok: false, error: 'rota desconhecida' })

  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 20000) return send(413, { ok: false, error: 'pedido grande demais' })
  }
  let a
  try {
    a = JSON.parse(raw)
  } catch {
    return send(400, { ok: false, error: 'pedido inválido' })
  }
  const run = Object.hasOwn(ACTIONS, a && a.a) ? ACTIONS[a.a] : null
  if (!run) return send(400, { ok: false, error: `ação desconhecida: ${a && a.a}` })
  try {
    console.log('->', a.a, JSON.stringify(a).slice(0, 120))
    const outcome = await run(a)
    if (outcome && typeof outcome === 'object' && 'info' in outcome) {
      return send(200, { ok: true, info: outcome.info, media: outcome.media || null })
    }
    send(200, { ok: true, info: outcome })
  } catch (err) {
    console.log('   erro:', err.message)
    send(200, { ok: false, error: err.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nJarvis do celular ligado.')
  console.log(`Código (cole no Jarvis na primeira vez): ${token}\n`)
})
