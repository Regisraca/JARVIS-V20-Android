# J.A.R.V.I.S. V20 — preparação para gerar APK

- A URL do shell Android foi configurada para o deploy web existente: https://jarvis-v20-fase5-corrigido.vercel.app/.
- Adicionado workflow GitHub Actions `.github/workflows/android-apk.yml` para compilar `android/` com Java 17 e Gradle 8.13 e guardar o APK debug como artefato.
- O workflow ainda não foi executado. Nenhum APK foi gerado ou testado em aparelho nesta etapa.
- Para disparar: enviar este projeto a um repositório GitHub e abrir Actions → Build JARVIS Android APK → Run workflow. Ao terminar, baixar o artefato `jarvis-v20-debug-apk` e extrair `app-debug.apk`.
- A URL usada é a implantação web já informada anteriormente. Quando o projeto `Jarvisregis` tiver uma URL própria publicada, atualize `android/app/src/main/res/values/strings.xml` e execute novamente.
- Não inclua `.env`, chaves Groq/Gemini ou keystores no repositório.
