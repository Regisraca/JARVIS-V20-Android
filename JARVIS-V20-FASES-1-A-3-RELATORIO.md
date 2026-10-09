# J.A.R.V.I.S. V20 — avanço até a Fase 3

## Base e preservação
- Base original preservada: `JARVIS-V20-limpo.zip`
- SHA-256 da base original: `46c5ec88fe13e2306f7783340e314d9e8773eafe0c815fb1e811e913cff074e2`
- Versão web: `20.0.0`
- Nenhum projeto Vercel antigo foi removido e nenhum deploy foi feito nesta etapa.
- O pacote de trabalho contém alterações em cima da cópia de trabalho, sem sobrescrever o ZIP original.

## Fase 1 — estabilização: parcial, ainda aberta
### Confirmado
- `npm test`: PASS.
- `node --check` para `api/chat.mjs`, `api/search.mjs`, `server/providers.mjs` e `server/search.mjs`: PASS.
- A bateria do selftest cobre fallback de provedor, pesquisa por API exata, grounding, Wikipedia/DuckDuckGo/notícias, baixa confiança quando a evidência é fraca, falha explícita sem fontes, roteador, Phone Bridge e proteção de segredos.

### Pendente
- `npm install --no-audit --no-fund` excedeu o limite de tempo disponível; não foi gerado lockfile.
- `npm run build`: BLOQUEADO, `vite: not found` porque as dependências não foram instaladas.
- `npm run lint`: BLOQUEADO, `oxlint: not found` pelo mesmo motivo.
- Build Android e teste em aparelho não foram executados.
- Permanecem as diferenças de versão intencionais/por esclarecer entre web `20.0.0`, Phone Bridge `18.3.0` e APK `17.0.0`; não foram alinhadas cegamente.

## Fase 2 — fallback Groq/Gemini: melhoria implementada, precisa validação de build
- O roteador do servidor agora percorre os modelos configurados de cada provedor, em vez de tentar somente o primeiro modelo.
- Erros de compatibilidade de modelo podem seguir para outro modelo; rate limit/timeout/erro de servidor faz avançar para outra chave/provedor, conforme disponibilidade.
- Mantida a leitura de chaves plurais (`GROQ_API_KEYS`, `GEMINI_API_KEYS`) e singulares (`GROQ_API_KEY`, `GEMINI_API_KEY`), sem expor chaves no bundle do navegador.
- O selftest atual confirmou o caminho Groq 429 → Gemini, mas ainda não tem um teste isolado de modelo inválido → segundo modelo válido.

## Fase 3 — pesquisa web: robustez e validação implementadas, precisa validação de build
- `api/search.mjs` agora exige JSON, consulta não vazia e limite de 500 caracteres; responde com códigos de erro explícitos para entradas inválidas.
- `api/chat.mjs` agora exige JSON e aplica limites básicos de quantidade de mensagens e tamanho de conteúdo.
- URLs externas são rejeitadas quando usam protocolo diferente de HTTP(S), credenciais embutidas ou host/endereço local/reservado conhecido.
- Resultados opcionais de Tavily e Brave passam pela validação de URL antes de entrarem no dossiê.
- Mantido o princípio de pesquisa baseada em evidências, com fontes e nível de confiança; ausência de evidência continua sendo falha explícita, não resposta inventada.

## Resultado objetivo
**Fases 2 e 3: alterações de código aplicadas e selftest passando. Fase 1: ainda não homologada por falta de dependências instaladas.**

## Próximo bloqueio para homologação
É necessário completar a instalação de dependências em um ambiente com acesso funcional ao npm registry; então gerar e versionar `package-lock.json`, rodar build/lint/test, acrescentar testes de fallback entre modelos e executar a validação Android/Phone Bridge em aparelho. Não declarar deploy ou homologação antes disso.
