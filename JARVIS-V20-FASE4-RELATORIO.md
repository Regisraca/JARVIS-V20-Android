# J.A.R.V.I.S. V20 — Relatório da Fase 4 (Android + Phone Bridge)

## Escopo
Mudanças incrementais no shell Android para melhorar compatibilidade e reduzir risco de regressão. O contrato do Phone Bridge (`PROTOCOL = 2`), suas rotas (`/ping`, `/act`, `/file`) e o cliente web em `src/lib/phone.ts` foram preservados.

## Arquivos alterados
- `android/app/src/main/AndroidManifest.xml`: adicionada permissão INTERNET e configuração explícita de segurança de rede.
- `android/app/src/main/res/xml/network_security_config.xml`: mantém cleartext bloqueado por padrão e permite HTTP apenas para `127.0.0.1`, usado pelo Phone Bridge local.
- `android/app/src/main/java/com/jarvis/resident/MainActivity.kt`: valida URL HTTPS configurada, limita navegação na WebView ao host configurado, envia links externos HTTPS/mailto/tel ao sistema, desativa acesso a arquivos, concede captura de áudio somente após permissão Android, nega outros recursos e evita reabrir a tela de sobreposição em loop.
- `android/app/src/main/java/com/jarvis/resident/FloatingBubbleService.kt`: limpeza defensiva da bolha ao encerrar o serviço.
- `android/app/build.gradle.kts`: versão Android alinhada para `versionCode 20` e `versionName 20.0.0`.
- `android/app/src/main/res/values/strings.xml`: nome de exibição alinhado a J.A.R.V.I.S.; URL de produção permanece deliberadamente como placeholder.
- `android/README.md`: instruções, requisitos e limitações atualizados.

## Verificações executadas
- `node scripts/selftest.mjs`: PASSOU.
- `node --check` para os módulos `.mjs` em `api/`, `server/`, `scripts/` e `public/`: PASSOU.
- Parsing XML do `AndroidManifest.xml`, `strings.xml` e `network_security_config.xml`: PASSOU.
- Verificações estáticas para HTTPS, restrição do host WebView, permissão de áudio, negação de permissões não relacionadas, prevenção de loop de sobreposição e início do foreground service: PASSARAM.
- O SHA-256 do ZIP final está disponível via `sha256sum` no arquivo entregue; não é armazenado dentro do próprio ZIP para evitar autorreferência.

## Não verificado / pendente
- Não há `gradle` nem `gradlew` no ambiente usado, então não foi possível compilar o APK Kotlin/Android nesta sessão.
- Não foi possível testar em aparelho físico, Android Studio, Termux e Termux:API.
- `strings.xml` ainda contém `https://SEU-JARVIS.vercel.app/`: deve ser substituído pela URL real antes de instalar/compilar o APK.
- A compatibilidade HTTP local do WebView e do Phone Bridge deve ser confirmada no aparelho. A porta 8787 deve continuar vinculada a `127.0.0.1`; não a exponha na rede.
- A bolha é um shell nativo que reabre a interface web, não um assistente autônomo em background. O microfone continua dependendo da permissão do usuário.

## Estratégia contra conflitos
Não foram removidos módulos web, nem alteradas rotas ou versão do protocolo do Phone Bridge. Os projetos antigos da Vercel não foram tocados e nenhum deploy foi feito.
