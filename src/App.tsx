import { startBridgeMonitor, stopBridgeMonitor, stash as stashPhone, fetchPhoneImage } from './lib/phone'
import { stashWebSearch } from './lib/web'
import { stashSystem } from './lib/system'
import {
  routeQuery,
  settlePhoneTurn,
  settleWebTurn,
  settleSystemTurn,
  phoneAutonomy,
  fastPhoneCommand,
  fastPhoneReply,
} from './lib/orchestrator'
import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { probeCapabilities } from './lib/capabilities'
import { env } from './config'
import { ConversationHistory } from './ui/ConversationHistory'
import { appendConversationMessage, getCurrentConversation, getConversation } from './lib/conversations'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/** Explicit web/current-information requests are researched before Gemini answers. */
function shouldForceWebSearch(text: string): boolean {
  return routeQuery(text) === 'WEB'
}

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const conversation = useRef(getCurrentConversation())
  const history = useRef<Msg[]>(conversation.current.messages.map((m) => ({ role: m.role === 'jarvis' ? 'assistant' : 'user', content: m.text })))

  /** Observability: record last tool settlement for HUD / Diagnostics. */
  const recordTool = (
    category: 'phone' | 'web' | 'system',
    action: string,
    status: string,
    summary: string,
    autonomy: 'safe' | 'sensitive' | 'destructive' | null,
    confirmation: 'not_required' | 'accepted' | 'denied' | 'n/a',
  ) => {
    store.getState().setLastTool({
      category,
      action,
      status,
      autonomy,
      confirmation,
      summary: summary.slice(0, 240),
      at: Date.now(),
    })
  }

  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const restore = conversation.current.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources }))
    store.getState().replaceTurns(restore)

    const onSwitch = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const found = getConversation(id)
      if (!found) return
      conversation.current = found
      history.current = found.messages.map((m) => ({ role: m.role === 'jarvis' ? 'assistant' : 'user', content: m.text }))
      interrupt()
      clearIdle()
      speaker.current?.cancel()
      speaker.current = null
      store.getState().replaceTurns(found.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, sources: m.sources })))
      store.getState().setCaption('')
      store.getState().setError(null)
      store.getState().setActiveTool(null)
      store.getState().setPhase('dormant')
    }
    const onNew = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      const found = id ? getConversation(id) : getCurrentConversation()
      if (!found) return
      conversation.current = found
      history.current = []
      interrupt()
      clearIdle()
      speaker.current?.cancel()
      speaker.current = null
      store.getState().replaceTurns([])
      store.getState().setCaption('')
      store.getState().setError(null)
      store.getState().setActiveTool(null)
      if (store.getState().phase !== 'offline') store.getState().setPhase('dormant')
    }
    window.addEventListener('jarvis:switch-conversation', onSwitch)
    window.addEventListener('jarvis:new-conversation', onNew)
    return () => {
      window.removeEventListener('jarvis:switch-conversation', onSwitch)
      window.removeEventListener('jarvis:new-conversation', onNew)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const notifyConversationSaved = () => window.dispatchEvent(new Event('jarvis:conversation-saved'))

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  // Microphone sessions are explicitly armed by the UI. There is no passive
  // wake-word listener in the web-mobile build.

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    appendConversationMessage(conversation.current.id, { id: newId(), role: 'user', text: said })
    notifyConversationSaved()
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false
    let forcedWebContext: string | null = null

    try {
      // Fast Path: deterministic phone commands bypass Gemini/Groq entirely.
      // The normal settlePhoneTurn path is still used, so validation, bridge
      // authentication and sensitive-action confirmation are unchanged.
      const fastAction = fastPhoneCommand(said)
      if (fastAction) {
        stashPhone(fastAction)
        store.getState().setPhase('tooling')
        store.getState().setActiveTool(String(fastAction.a))
        sfx.play('tool')
        music.working(true)

        const settledFast = await settlePhoneTurn((m) => store.getState().setError(m))
        if (stale()) return

        const fastReply = fastPhoneReply(fastAction, settledFast.result)
        const fastTurnId = newId()
        const fastMedia = settledFast.result.status === 'ok' && settledFast.result.media ? await fetchPhoneImage(settledFast.result.media) : null
        const fastTurn = { id: fastTurnId, role: 'jarvis' as const, text: fastReply, ...(fastMedia ? { media: [{ kind: 'image' as const, url: fastMedia, title: settledFast.result.media?.name || 'Foto capturada' }] } : {}) }
        store.getState().pushTurn(fastTurn)
        appendConversationMessage(conversation.current.id, { id: fastTurnId, role: 'jarvis', text: fastReply })
        notifyConversationSaved()
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: fastReply })
        if (history.current.length > 16) history.current = history.current.slice(-16)

        if (settledFast.result.status === 'ok') {
          store.getState().setPhase('speaking')
          speaker.current = spk
          spk.say(fastReply)
          await spk.end()
        } else {
          sfx.play('error')
          store.getState().setError(fastReply)
        }

        const st = settledFast.result.status
        const action = 'action' in settledFast.result && settledFast.result.action
          ? String(settledFast.result.action)
          : fastAction.a
        const summary = st === 'ok' && 'info' in settledFast.result
          ? String(settledFast.result.info)
          : 'message' in settledFast.result
            ? String(settledFast.result.message)
            : st
        let confirmation: 'not_required' | 'accepted' | 'denied' | 'n/a' = 'n/a'
        const level = phoneAutonomy(action)
        if (level === 'safe') confirmation = 'not_required'
        else if (st === 'rejected' && /cancelada por você/i.test(summary)) confirmation = 'denied'
        else if (st === 'ok') confirmation = 'accepted'
        recordTool('phone', action, st, summary, level, confirmation)
        return
      }

      // Explicit research requests are handled deterministically before the LLM.
      if (shouldForceWebSearch(said)) {
        stashWebSearch(said, 'web_search')
        const preWeb = await settleWebTurn((m) => store.getState().setError(m))
        if (stale()) return
        if (preWeb.contextNote) {
          forcedWebContext = preWeb.contextNote
          if (!usingBridge) {
            history.current.push({ role: 'assistant', content: preWeb.contextNote })
            if (history.current.length > 16) history.current = history.current.slice(-16)
          }
        }
        if (preWeb.result.status !== 'idle') {
          const summary = preWeb.result.status === 'ok'
            ? `${preWeb.result.query} — ${preWeb.result.summary}`
            : preWeb.result.message
          recordTool('web', 'web_search', preWeb.result.status, summary, null, 'n/a')
        }
      }

      const promptForAsk = forcedWebContext
        ? `${said}\n\nINSTRUÇÃO: o usuário pediu uma pesquisa na web. Use somente o resultado real da pesquisa no contexto. Responda em português do Brasil, naturalmente e de forma breve. Não pesquise novamente e não emita blocos [[WEB]], [[ACAO]], [[SYSTEM]], [[MEMORIA]] ou [[ESQUECER]]. Se a pesquisa falhou, diga claramente que não foi possível confirmar.`
        : said

      const { text, diagnostic } = await ask(promptForAsk, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return
      if (diagnostic) {
        store.getState().setConnected([diagnostic.provider.toUpperCase()])
        console.info('[jarvis] LLM diagnostic', diagnostic)
      }

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        appendConversationMessage(conversation.current.id, { id: newId(), role: 'jarvis', text: text || '…' }, { diagnostic: diagnostic ? { provider: diagnostic.provider, model: diagnostic.model, fallback: diagnostic.fallback, attempts: diagnostic.attempts, errors: diagnostic.errors } : undefined })
        notifyConversationSaved()
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
      // Orchestrator PHONE: stashed [[ACAO]] → phone.ts → /act → real PhoneResult
      const settled = await settlePhoneTurn((m) => store.getState().setError(m))
      if (stale()) return

      if (settled.contextNote && !usingBridge) {
        const last = history.current[history.current.length - 1]
        if (last && last.role === 'assistant') {
          last.content = `${last.content}\n${settled.contextNote}`
        } else {
          history.current.push({ role: 'assistant', content: settled.contextNote })
        }
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      if (settled.succeeded && settled.result.status === 'ok') {
        // Confirm with the bridge's own info text — never invent success.
        const confirm = createSpeaker()
        speaker.current = confirm
        store.getState().setPhase('speaking')
        confirm.say(settled.result.info)
        await confirm.end()
        if (stale()) return
      } else if (settled.result.status !== 'idle') {
        sfx.play('error')
      }
      if (settled.result.status !== 'idle') {
        const st = settled.result.status
        const action =
          'action' in settled.result && settled.result.action
            ? String(settled.result.action)
            : 'phone'
        const level = phoneAutonomy(action)
        const summary =
          st === 'ok' && 'info' in settled.result
            ? String(settled.result.info)
            : 'message' in settled.result
              ? String(settled.result.message)
              : st
        let confirmation: 'not_required' | 'accepted' | 'denied' | 'n/a' = 'n/a'
        if (level === 'safe' || (action === 'volume' && st === 'ok' && !summary.includes('ajustado'))) {
          confirmation = 'not_required'
        } else if (st === 'rejected' && /cancelada por você/i.test(summary)) {
          confirmation = 'denied'
        } else if (st === 'ok') {
          confirmation = 'accepted'
        } else {
          confirmation = 'n/a'
        }
        recordTool('phone', action, st, summary, level, confirmation)
      }

      // Orchestrator WEB: stashed [[WEB web_search]] → real search → context
      const webSettled = await settleWebTurn((m) => store.getState().setError(m))
      if (stale()) return
      if (webSettled.contextNote && !usingBridge) {
        const last = history.current[history.current.length - 1]
        if (last && last.role === 'assistant') {
          last.content = `${last.content}\n${webSettled.contextNote}`
        } else {
          history.current.push({ role: 'assistant', content: webSettled.contextNote })
        }
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }
      if (webSettled.succeeded && webSettled.result.status === 'ok') {
        // One follow-up turn so the brain answers from the real search note in history.
        store.getState().setPhase('thinking')
        const webTurnId = `web-${Date.now()}`
        store.getState().pushTurn({ id: webTurnId, role: 'jarvis', text: '' })
        let webAnswer = ''
        const { text: webText, diagnostic: webDiagnostic } = await ask(
          'Com base no resultado real da pesquisa web que acabou de entrar no contexto, responda ao usuário em português do Brasil, de forma natural e breve. Não diga que vai pesquisar de novo. Não invente fatos além do resultado. Não emita blocos [[ACAO]], [[WEB]], [[SYSTEM]], [[MEMORIA]] nem [[ESQUECER]].',
          history.current,
          {
            onText: (delta) => {
              if (stale()) return
              webAnswer += delta
              store.getState().appendToLastTurn(delta)
            },
            onTool: () => {},
          },
        )
        if (stale()) return
        const spoken = (webText || webAnswer || '').trim()
        if (!usingBridge) {
          history.current.push({
            role: 'assistant',
            content: spoken || '…',
          })
          const sources = 'sources' in webSettled.result ? webSettled.result.sources : undefined
          store.getState().setLastTurnSources(sources || [])
          appendConversationMessage(conversation.current.id, { id: webTurnId, role: 'jarvis', text: spoken || '…', sources }, {
            diagnostic: webDiagnostic ? { provider: webDiagnostic.provider, model: webDiagnostic.model, fallback: webDiagnostic.fallback, attempts: webDiagnostic.attempts, errors: webDiagnostic.errors } : undefined,
          })
          notifyConversationSaved()
          if (history.current.length > 16) {
            history.current = history.current.slice(-16)
          }
        }
        if (spoken) {
          const confirm = createSpeaker()
          speaker.current = confirm
          store.getState().setPhase('speaking')
          confirm.say(spoken)
          await confirm.end()
          if (stale()) return
        }
        // Synthesis ask must not schedule a second tool run this turn or the next.
        stashPhone(null)
        stashWebSearch(null)
        stashSystem(null)
      } else if (webSettled.result.status !== 'idle') {
        sfx.play('error')
      }
      if (webSettled.result.status !== 'idle') {
        const st = webSettled.result.status
        const summary =
          st === 'ok' && 'summary' in webSettled.result
            ? String(webSettled.result.summary)
            : 'message' in webSettled.result
              ? String(webSettled.result.message)
              : st
        const q =
          'query' in webSettled.result ? String(webSettled.result.query) : ''
        recordTool(
          'web',
          'web_search',
          st,
          q ? `${q} — ${summary}` : summary,
          null,
          'n/a',
        )
      }

      // Orchestrator SYSTEM: local tools only (datetime, bridge_status, memory_list)
      const sysSettled = await settleSystemTurn((m) => store.getState().setError(m))
      if (stale()) return
      if (sysSettled.contextNote && !usingBridge) {
        const last = history.current[history.current.length - 1]
        if (last && last.role === 'assistant') {
          last.content = `${last.content}\n${sysSettled.contextNote}`
        } else {
          history.current.push({ role: 'assistant', content: sysSettled.contextNote })
        }
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }
      if (sysSettled.succeeded && sysSettled.result.status === 'ok') {
        const confirm = createSpeaker()
        speaker.current = confirm
        store.getState().setPhase('speaking')
        confirm.say(sysSettled.result.info)
        await confirm.end()
        if (stale()) return
      } else if (sysSettled.result.status !== 'idle') {
        sfx.play('error')
      }
      if (sysSettled.result.status !== 'idle') {
        const st = sysSettled.result.status
        const action =
          'action' in sysSettled.result ? String(sysSettled.result.action) : 'system'
        const summary =
          st === 'ok' && 'info' in sysSettled.result
            ? String(sysSettled.result.info)
            : 'message' in sysSettled.result
              ? String(sysSettled.result.message)
              : st
        recordTool('system', action, st, summary, null, 'n/a')
      }
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      const raw = err instanceof Error ? err.message : 'Something went wrong.'
      const friendly = /RATE_LIMIT|HTTP 429|Rate limit|rate limit/i.test(raw)
        ? 'Os provedores gratuitos atingiram a cota neste momento. Aguarde um pouco e tente novamente; o JARVIS não precisa ficar ouvindo para isso.'
        : /HTTP 404|model .*not available|no longer available/i.test(raw)
          ? 'O modelo de IA configurado está desatualizado. Atualize o modelo na Vercel e faça um novo deploy.'
          : raw.length > 260
            ? `${raw.slice(0, 257)}…`
            : raw
      store.getState().setError(friendly)
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // V14: no passive follow-up window. After every completed answer,
        // J.A.R.V.I.S. returns to standby and only wakes on an explicit call.
        goDormant()
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /**
   * The mobile/web contract is deliberately simple: dormant means deaf.
   * Speech recognition is armed only after the user presses the microphone.
   */
  const mode = (): VoiceMode => {
    const p = store.getState().phase
    return p === 'listening' ? 'command' : 'deaf'
  }

  const onWake = (_trailing: string) => {
    // Wake words are intentionally disabled in web-mobile mode.
  }

  const onSpeechStart = () => {
    if (store.getState().phase === 'listening') return
    if (store.getState().phase === 'offline' || store.getState().phase === 'boot') return
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const said = text.trim()
    if (!said) {
      store.getState().setPhase('dormant')
      return
    }
    // One button press owns exactly one turn. Close the current recognition
    // session before sending the text to the brain. It cannot reopen by itself.
    voice.current?.cancelCurrent?.()
    store.getState().setCaption('')
    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
    store.getState().setPhase('dormant')
  }

  const startListening = () => {
    const s = store.getState()
    if (s.phase === 'offline' || s.phase === 'boot') return
    s.setError(null)
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    voice.current?.arm?.()
  }

  const toggleListening = () => {
    const p = store.getState().phase
    if (p === 'offline') {
      void powerOn()
      return
    }
    if (p === 'boot') return
    if (p === 'listening') {
      voice.current?.cancelCurrent?.()
      store.getState().setCaption('')
      store.getState().setPhase('dormant')
      return
    }
    if (p === 'thinking' || p === 'tooling' || p === 'speaking') {
      silence()
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    startListening()
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[jarvis] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The score. Must be started from inside this click handler for the same
    // reason as the rest of the audio.
    music.enable()
    music.playBoot()
    music.startAmbient()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * JARVIS asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The interface is JARVIS's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[jarvis] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))

    // Pull the neural voice down during the boot sequence so the first
    // "Hey Jarvis" isn't waiting on an 86MB download. Deliberately not awaited
    // — if it's slow, JARVIS comes up on the system voice and swaps over the
    // moment the model is ready.
    if (TTS_ENGINE === 'kokoro') {
      void kokoro.load()
      voicePoll.current = setInterval(() => {
        const p = kokoro.loadProgress()
        if (kokoro.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, suit schematic, reactor power-up — before the live
    // interface takes over. Kept a touch under the boot cue so the music is
    // still rising as the reactor lands.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())
    store.getState().setVoice(currentVoiceName())

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload.
    await probeCapabilities()

    // Real presence of the Termux phone bridge via existing GET /ping only.
    // Single interval inside phone.ts; offline must not block the rest of the UI.
    startBridgeMonitor((snap) => store.getState().setBridge(snap))

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice(
      {
        mode,
        onWake,
        onSpeechStart,
        onPartial,
        onUtterance,
        onError: onVoiceError,
      },
      { manual: true },
    )

    store.getState().setPhase('dormant')
  }

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : 0
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. At your service, sir.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working, sir.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space is a keyboard shortcut for the same explicit microphone action.
      // It never creates a passive listener or a wake-word mode.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      toggleListening()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      stopBridgeMonitor()
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  return (
    <>
      <Scene />
      <Hud onMic={toggleListening} onSubmitText={(text) => { const value = text.trim(); if (value) void respond(value) }} />
      <Boot />
      <Diagnostics />
      <ConversationHistory />
      <Ignition onStart={() => void powerOn()} />
    </>
  )
}
