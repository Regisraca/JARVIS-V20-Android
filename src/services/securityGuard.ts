import { getBridgeSnapshot } from '../lib/phone'
import type { PhoneActionSafety } from '../types/jarvis'

/** External web text is data, never executable J.A.R.V.I.S. syntax. */
export function sanitizeExternalContent(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/\[\[\s*(?:ACAO|WEB|SYSTEM|PHONE)\s*(?:\{[\s\S]*?\})?\s*\]\]/gi, '[CONTEÚDO REMOVIDO POR SEGURANÇA]')
    .replace(/\[\[/g, '&#91;&#91;').replace(/\]\]/g, '&#93;&#93;').trim()
}

/** Validation for the real bridge vocabulary. Membership comes only from /ping.actions. */
export function validatePhoneAction(actionPayload: unknown): { valid: boolean; reason?: string } {
  if (!actionPayload || typeof actionPayload !== 'object') return { valid: false, reason: 'Payload deve ser um objeto JSON válido.' }
  const payload = actionPayload as Record<string, unknown>
  if (typeof payload.a !== 'string' || !payload.a.trim()) return { valid: false, reason: "Propriedade 'a' é obrigatória e deve ser string." }
  const actions = getBridgeSnapshot().actions
  if (actions) return actions.includes(payload.a) ? { valid: true } : { valid: false, reason: `Ação '${payload.a}' não está confirmada pela Phone Bridge.` }
  // Compatibilidade de inicialização: antes do primeiro /ping, preserve o vocabulário V14.
  const bootstrap = ['url','musica','app','arquivo','ler_arquivo','abrir_ultima_foto','whatsapp','home','voltar','recentes','wifi','bluetooth','notificacoes','ler_notificacoes','ler_mensagens','ler_sms','fechar','lanterna','piscar_lanterna','vibrar','bateria','volume','falar','copiar','colar','aviso','foto','sequencia','whatsapp_print_ultimas','configuracoes','print','ytmusic_tocar','spotify_tocar','app_pesquisar','ui_ler_tela','whatsapp_ler_conversa','whatsapp_pendencias']
  return bootstrap.includes(payload.a) ? { valid: true } : { valid: false, reason: `Ação '${payload.a}' não reconhecida ou não autorizada.` }
}

const SENSITIVE = new Set(['whatsapp', 'ui_ler_tela', 'whatsapp_ler_conversa', 'whatsapp_pendencias', 'print', 'foto', 'copiar', 'volume', 'ler_arquivo', 'ler_mensagens', 'ler_sms', 'ler_notificacoes', 'sequencia', 'whatsapp_print_ultimas'])
const DESTRUCTIVE = new Set(['fechar'])

export class SecurityGuard {
  sanitizeWebData(content: string): string { return sanitizeExternalContent(content) }

  classifyPhoneAction(actionName: string): PhoneActionSafety {
    const actions = getBridgeSnapshot().actions
    if (!actions || !actions.includes(actionName)) return 'unknown'
    if (DESTRUCTIVE.has(actionName)) return 'destructive'
    if (SENSITIVE.has(actionName)) return 'sensitive'
    return 'safe'
  }

  validatePhonePayload(payload: Record<string, unknown>): { allowed: boolean; reason?: string } {
    const action = String(payload.a || '')
    const safety = this.classifyPhoneAction(action)
    if (safety === 'unknown') return { allowed: false, reason: `Ação não anunciada pelo phone-bridge.mjs: ${action}` }
    if (safety === 'destructive' && payload.userConfirmed !== true) return { allowed: false, reason: `Ação (${action}) exige confirmação explícita do usuário.` }
    return { allowed: true }
  }
}
