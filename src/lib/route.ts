/**
 * Intent router (no imports on purpose, so it can be tested in plain Node).
 *
 * Principle: a language model is not a source of facts. Anything that looks like a
 * factual question or a request for information is researched on the web first and
 * answered from the evidence. Only conversation, creative/transform tasks, simple
 * arithmetic and phone commands skip the search.
 */

export type QueryRoute = 'SYSTEM' | 'WEB' | 'PHONE' | 'LLM'

const norm = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Leading vocative: "jarvis, ..." / "hey jarvis ..."
const VOCATIVE = /^(?:(?:hey|hi|ok|okay|ola|e ai|ei)\s+)?(?:jarvis|jarvys|jervis|travis|jarviss|jarv)\b[\s,.:;!?-]*/

const SYSTEM_RE = /\b(que horas|qual a hora|que dia (?:e )?hoje|qual a data|data de hoje|que dia da semana)\b/

const EXPLICIT_WEB_RE =
  /\b(pesquise|pesquisa|pesquisar|procure|procurar|busque|buscar|busca|na internet|na web|noticias|noticia|ultimas|ultimos|ultima|ultimo|hoje|agora|atual|atualmente|cotacao|preco atual|valor atual|tempo agora|clima agora|resultado da eleicao)\b/

const QUESTION_START_RE =
  /^(?:quem|qual|quais|quando|onde|quanto|quantos|quantas|quanta|como|porque|por que|por qual|o que|oque|que|existe|existem|sera que|e verdade|foi|fez|era|tem|ha|havera|aconteceu|diga|fale|me fale|me diga|me conte|conte|explique|explica|me explique|fala sobre|o que voce sabe|descubra|descobre|confirme|verifique|me ajuda a saber|pode me dizer|voce sabe|sabe me dizer|sabe quem|sabe qual|sabe quando|sabe onde)\b/

const INFO_WORD_RE =
  /\b(quem e|quem foi|quem sao|quem era|quem ganhou|quem venceu|quem fez|quem criou|quem inventou|quem descobriu|qual e|qual foi|qual era|quais sao|quando foi|quando e|quando sera|quando nasceu|quando morreu|onde fica|onde e|onde foi|quanto custa|quanto vale|quanto esta|quanto tem|quantos anos|capital de|populacao|presidente|prefeito|governador|ministro|tecnico|treinador|placar|resultado|classificacao|tabela|campeao|cotacao|preco|temperatura|previsao|vai chover|significa|significado|definicao|o que e|o que sao|o que significa|o que aconteceu|o que houve|lancamento|estreia|elenco|dono d[aeo]|fundador|ceo)\b/

const CHITCHAT_RE =
  /^(?:oi|ola|opa|e ai|bom dia|boa tarde|boa noite|obrigad[oa]|valeu|tchau|ate mais|ate logo|tudo bem|tudo bom|como vai|como voce esta|como vc esta|como esta voce|quem e voce|quem e vc|qual o seu nome|qual e o seu nome|como voce se chama|o que voce faz|o que voce pode fazer|o que vc faz|voce esta ai|ta ai|esta ai|testando|teste|sim|nao|ok|certo|entendi|beleza|legal|bacana|que bom|que legal|pode ser|fala comigo|conversa comigo|me anima|estou|to |me sinto|tenho medo|estou triste)\b/

const ABOUT_ME_RE = /^(?:quem e (?:voce|vc)|qual (?:e )?o seu nome|como (?:voce|vc) se chama|o que (?:voce|vc) (?:faz|pode fazer|sabe fazer))\b/

const CREATIVE_RE =
  /^(?:escreva|escreve|crie|cria|invente|inventa|traduza|traduz|resuma|resume|corrija|corrige|reescreva|reescreve|melhore|melhora|faca um poema|faca uma poesia|faca uma musica|me conte uma piada|conte uma piada|conte uma historia|me conte uma historia|faca uma rima|gere|gera|simule|finja|imagine|brinque|vamos brincar|vamos jogar)\b/

const ARITHMETIC_RE =
  /(?:\d\s*[+\-*/x×÷^]\s*\d|\b\d+\s*%\s*de\s*\d|\braiz (?:quadrada|cubica)\b|\bquanto (?:e|da|vai dar|sera)\s+\d)/

const PHONE_ACTION_RE =
  /\b(abre|abrir|abra|feche|fechar|manda|mandar|envia|enviar|toque|tocar|ligue|ligar|desligue|desligar|volume|lanterna|pisque|piscar|print|tire uma foto|tirar foto|tira uma foto|camera|copie|copiar|cole|colar|wifi|bluetooth|spotify|configuracoes|sequencia|cinco vezes|tres vezes)\b/

const PHONE_DATA_RE =
  /\b(leia|ler|leia minhas|ler minhas|mensagem|mensagens|sms|notificacao|notificacoes|whatsapp|telegram|messenger|signal|arquivo|txt|foto que tirou|ultima foto)\b/

const PHONE_START_RE =
  /^(?:abre|abrir|abra|feche|fechar|manda|mandar|envia|enviar|toque|tocar|toca|ligue|ligar|desligue|desligar|aumente|diminua|abaixe|suba|pisque|piscar|tire|tira|copie|copiar|cole|colar|ative|ativa|desative|desativa|leia|ler|le|mostre minhas|mostra minhas)\b/

/** Strip the vocative so "Jarvis, quem é..." is judged by what follows. */
export function stripVocative(text: string): string {
  return norm(text).replace(VOCATIVE, '').trim()
}

export function routeQuery(text: string): QueryRoute {
  const q = stripVocative(text)
  if (!q) return 'LLM'

  if (SYSTEM_RE.test(q)) return 'SYSTEM'
  if (ABOUT_ME_RE.test(q)) return 'LLM'

  // Phone commands that start with an imperative verb are never web searches.
  if (PHONE_START_RE.test(q) && !/\b(pesquise|pesquisa|procure|busque)\b/.test(q)) return 'PHONE'

  // Explicit research request or time-sensitive wording always searches.
  if (EXPLICIT_WEB_RE.test(q)) return 'WEB'

  if (PHONE_DATA_RE.test(q) && /\b(mensagem|mensagens|sms|notificacao|notificacoes|whatsapp|telegram|messenger|signal|arquivo|txt|foto)\b/.test(q)) return 'PHONE'

  if (ARITHMETIC_RE.test(q)) return 'LLM'
  if (CHITCHAT_RE.test(q) && !INFO_WORD_RE.test(q)) return 'LLM'
  if (CREATIVE_RE.test(q)) return 'LLM'

  if (PHONE_ACTION_RE.test(q) && !QUESTION_START_RE.test(q) && !q.endsWith('?')) return 'PHONE'

  // Anything that reads as a question or a request for information gets researched.
  if (q.endsWith('?') || QUESTION_START_RE.test(q) || INFO_WORD_RE.test(q)) return 'WEB'

  // Longer free-form statements are treated as information requests too; very short
  // fragments are most likely conversation.
  if (q.split(' ').length >= 5) return 'WEB'

  return 'LLM'
}
