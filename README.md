# J.A.R.V.I.S. 20

Assistente de voz (React + Vite) com interface holográfica, memória local e Phone Bridge para Android.
Tudo roda no plano gratuito, sem cartão e sem assinatura.

## Como ele responde

```text
VOZ / TEXTO
   ↓
ROTEADOR (src/lib/route.ts)
   ├── comandos do celular        → Phone Bridge
   ├── hora/data                  → relógio local
   ├── conversa, criação, contas  → cérebro direto (Gemini/Groq)
   └── qualquer pergunta factual  → PESQUISA NA WEB primeiro, depois o cérebro responde
```

O modelo de IA não é fonte de fatos. Perguntas factuais são pesquisadas antes; o cérebro só redige a resposta a partir do dossiê encontrado, citando fonte e data. Se nada confirmar, ele diz que não conseguiu confirmar.

## Pesquisa web (`server/search.mjs`)

Roda em paralelo, sem chave obrigatória:

1. APIs exatas: cotações (CoinGecko, AwesomeAPI), clima (Open-Meteo), Selic/IPCA (Banco Central), CEP (BrasilAPI).
2. Wikipedia pt/en, com trechos reais e data da última edição.
3. DuckDuckGo (HTML) + leitura das páginas encontradas.
4. Google News e Bing News (RSS) para assuntos atuais.
5. Opcionais, com chave gratuita: Gemini + Google Search grounding, Tavily, Brave Search.

As evidências são ranqueadas por relevância, fonte (oficial/confiável) e data, e recebem uma confiança (alta, média ou baixa) que o JARVIS repassa na fala.

Limites honestos: nenhum sistema garante 100% de verdade. O JARVIS só afirma o que as fontes encontradas sustentam e mostra as fontes no chat. Fontes gratuitas podem ser bloqueadas ou ficar fora do ar; nesse caso ele avisa.

## Configuração (Vercel → Settings → Environment Variables)

Veja `.env.example`. O mínimo é uma chave gratuita do Groq e/ou do Gemini para o cérebro. A pesquisa funciona sem chave.

```text
GROQ_API_KEYS=...
GEMINI_API_KEYS=...
```

Se a pesquisa sem chave estiver falhando no seu deploy (alguns sites bloqueiam IPs de servidor), crie uma conta gratuita e adicione `TAVILY_API_KEY` ou `BRAVE_API_KEY`. Nunca use variáveis com prefixo `VITE_` para chaves.

## Desenvolvimento

```bash
npm install
npm run dev        # API local + Vite
npm test           # selftest do servidor, da pesquisa e do roteador
npm run build
```

## Android / Termux

`public/phone-bridge.mjs` é a ponte local: allowlist de ações, token, escuta só em 127.0.0.1, nunca executa shell arbitrário do modelo. O microfone é sempre manual: nada escuta em segundo plano.

## Créditos

Músicas de Kevin MacLeod (CC BY 4.0), veja `public/audio/CREDITS.md`.
