# J.A.R.V.I.S. Resident — Android shell (v20)

Este módulo abre a interface Web do J.A.R.V.I.S. em uma WebView nativa e oferece uma bolha flutuante opcional.

## Antes de compilar
1. Configure `android/app/src/main/res/values/strings.xml` com a URL HTTPS real do J.A.R.V.I.S.
2. Abra a pasta `android/` no Android Studio (JDK e SDK Android instalados).
3. Compile e instale o APK.
4. Autorize microfone e sobreposição somente se quiser usar voz e bolha flutuante.

## Compatibilidade e segurança
- A WebView permite navegação interna apenas para o mesmo host HTTPS configurado; links externos HTTPS, `mailto:` e `tel:` abrem fora do app.
- A permissão de áudio só é concedida depois da permissão Android `RECORD_AUDIO`; outros recursos de mídia da WebView são recusados.
- A página usa HTTPS. O modo de conteúdo misto em compatibilidade é necessário para o Phone Bridge local em `http://127.0.0.1:8787`; a política de rede permite HTTP apenas para `127.0.0.1` e mantém cleartext bloqueado para os demais hosts. Mantenha a URL remota em HTTPS e nunca exponha a porta da ponte na rede.
- O Phone Bridge continua sendo o serviço Termux separado, com token local e lista fixa de ações. A bolha nativa não executa comandos de shell.
- O nome de versão Android acompanha a linha V20; versão do protocolo da ponte permanece independente e não foi alterada.

## Limites conhecidos
A bolha reabre o J.A.R.V.I.S.; não é uma bolha interativa que execute ações sem abrir a interface. A comunicação com o Phone Bridge precisa ser validada em aparelho real com Termux e Termux:API configurados.
