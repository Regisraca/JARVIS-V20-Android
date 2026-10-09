# J.A.R.V.I.S. Resident — Android (desenvolvimento)

## Como testar a experiência nativa de IA

1. Compile e instale o APK de desenvolvimento (JDK 17, Android SDK 35).
2. Abra **J.A.R.V.I.S.**: a tela inicial agora é o chat Android nativo.
3. Toque em **APIs** → **Adicionar API**.
4. Escolha **Gemini** (endpoint `https://generativelanguage.googleapis.com/v1beta/models`) ou **OpenAI-compatible** (endpoint completo de chat, por exemplo `https://api.groq.com/openai/v1/chat/completions` ou `https://api.openai.com/v1/chat/completions`).
5. Gemini, Groq e OpenAI já possuem presets de endpoint/modelo: normalmente basta selecionar o provedor e informar **sua própria chave API**. Para outros, informe endpoint/modelo compatíveis. O APK não inclui chaves nem promete uso gratuito.
6. Adicione quantas APIs desejar. A ordem na lista determina prioridade; use **↑** para promover uma API, **Pausar** para desativar e **Testar** para fazer uma requisição real (que pode consumir créditos). Se a primeira falhar, o chat tenta a próxima habilitada.
7. Use **Interface web** para abrir a interface visual anterior. Nessa interface, as APIs continuam sendo gerenciadas pelo backend hospedado, não pelo cofre Android.

As credenciais são cifradas em repouso pelo Android Keystore (AES-GCM), não ficam no código do APK nem são expostas ao JavaScript do WebView. Android backup está desabilitado para evitar transportar dados cifrados sem a chave Keystore. A lista de provedores e endpoints é guardada separadamente, sem segredos.

## Estado e limites

- O chat **nativo** usa requisições HTTPS diretamente aos provedores, com fallback e indicação da IA que respondeu. Isso exige conexão com a internet e uma chave válida.
- Não foi adicionada integração das APIs pessoais ao chat **web/voz**. A interface web usa o backend existente.
- A função **Interface web** continua carregando a URL HTTPS especificada em `app/src/main/res/values/strings.xml`. A UI remota precisa estar disponível.
- A bolha flutuante e as ações de telefone da interface web continuam com suas limitações anteriores; o Phone Bridge Termux não foi removido.
- O chat nativo oferece ditado por voz (quando há um reconhecedor instalado) e leitura de respostas por TextToSpeech. Ainda não há modo de escuta contínua, palavra de ativação, nem execução de ações do telefone pela nova tela.
- Requisições aos provedores podem consumir créditos pagos.
- Confirme os termos de segurança e uso de cada provedor antes de inserir uma chave.
- Essa implementação ainda requer **build CI e teste real em Android**. Não declare o APK pronto para distribuição sem essa validação.

## Segurança da WebView antiga

- Só permite navegação interna HTTPS para o host configurado; outros links abrem fora do app.
- Concede áudio somente após autorização de microfone.
- Conteúdo misto é permitido por compatibilidade com a ponte Termux em `127.0.0.1:8787` na interface web anterior, não no chat nativo.
- O código nativo não expõe as credenciais ao WebView.
