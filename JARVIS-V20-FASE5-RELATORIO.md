# J.A.R.V.I.S. V20 — Fase 5: integração e homologação

## Resultado
Homologação parcial concluída por testes automatizados e verificações estáticas. O pacote foi preparado sem remover projetos da Vercel e sem fazer deploy.

## Correção de integração aplicada
- Alinhada a versão declarada pelo Phone Bridge (`public/phone-bridge.mjs`) de `18.3.0` para `20.0.0`, consistente com o pacote web e o shell Android.
- Ampliado `scripts/selftest.mjs` para verificar a versão do Bridge, o protocolo 2 e a correspondência da versão Android com `package.json`.
- O protocolo do Phone Bridge continua `2`; as rotas `/ping`, `/act` e `/file` não foram alteradas.

## Verificações executadas
- `npm test`: PASSOU — selftest cobre fallback Groq → Gemini, pesquisa e fontes, classificação do roteador, Phone Bridge, microfone manual e segredos fora do navegador.
- `node --check` em todos os módulos `.mjs` dentro de `api/`, `server/`, `scripts/` e `public/`: PASSOU.
- Parsing XML de `AndroidManifest.xml`, `strings.xml` e `network_security_config.xml`: PASSOU.
- Busca no ZIP por `.env`, keystore, `local.properties` e arquivo de credenciais: nenhum encontrado.
- Consistência entre versão web/Bridge/Android: verificada pelo selftest.

## Bloqueios e limites honestos
- `npm install --ignore-scripts --no-audit --no-fund` excedeu o limite de tempo do ambiente. Portanto, não foi possível instalar dependências para executar `npm run build` ou `npm run lint`; não afirmar que esses comandos passaram.
- O ambiente não tem Gradle/Gradle Wrapper configurado; compilação do APK e testes em aparelho Android real continuam pendentes.
- `android/app/src/main/res/values/strings.xml` mantém `https://SEU-JARVIS.vercel.app/` como placeholder. Substituir pela URL real do projeto `Jarvisregis` antes de compilar o APK.
- Nenhum deploy foi feito. Projetos antigos da Vercel permanecem intocados.
- Recursos que dependem de chaves de API, Termux:API, permissões Android ou depuração sem fio precisam de teste no ambiente real.

## Segurança / compatibilidade
- Phone Bridge continua vinculado a `127.0.0.1`, com token, allowlist de ações e limite de tentativas.
- Não colocar chaves Groq/Gemini em variáveis `VITE_*` nem no código do navegador.
- O assistente mantém ativação manual do microfone; não é um serviço de escuta contínua.

## Próximo passo necessário para homologação completa
1. Informar/configurar a URL HTTPS publicada do J.A.R.V.I.S. no shell Android.
2. Em ambiente com rede e dependências disponíveis, executar `npm ci` (ou `npm install`), `npm test`, `npm run lint` e `npm run build`.
3. Abrir `android/` no Android Studio, compilar APK e testar no aparelho com Termux + Termux:API.
4. Só depois aprovar o deploy de produção para o novo projeto `Jarvisregis`.
