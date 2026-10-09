# Configuração de provedores de IA — implementação por etapas

Objetivo: permitir que cada pessoa instale o APK e configure uma ou várias APIs de IA, sem Termux ou edição manual de variáveis no servidor.

## Etapa 1 — armazenamento local (iniciada)

`ProviderCredentialVault.kt` usa Android Keystore (AES-256-GCM) para cifrar credenciais por identificador de provedor. O armazenamento persistente contém apenas os dados cifrados. O cofre não é exposto ao JavaScript do WebView.

**Ainda não está integrado à interface**: não há formulário para adicionar/testar provedores, nem adaptadores de requisição nativa. O fluxo atual de chat continua usando `/api/chat` e as chaves configuradas no servidor.

## Próximas etapas

1. Criar interface nativa para cadastrar, testar, escolher e excluir provedores sem limite artificial de quantidade.
2. Implementar adaptadores nativos para provedores conhecidos e endpoints OpenAI-compatible configuráveis, com validação de HTTPS e proteção contra redirecionamentos e vazamento de tokens.
3. Implementar ordem de preferência, fallback em erros temporários e indicação verificável do provedor/modelo usado.
4. Integrar o mecanismo nativo de IA à conversa e manter o backend existente como alternativa opcional.
5. Migrar ações de telefone do Termux para APIs Android com permissões explícitas e confirmação para ações sensíveis.
6. Adicionar testes automatizados e validar o APK antes de publicar.

## Limites de segurança

- Nunca retornar a chave em texto claro para JavaScript remoto.
- Nunca enviar credenciais do usuário para o servidor Vercel por padrão.
- Não presumir que Wi-Fi/Bluetooth podem ser alternados por apps comuns no Android moderno.
- Não prometer leitura de histórico completo do WhatsApp nem execução de ações sem permissão do usuário.
- Não incluir credenciais reais em logs, commits ou artefatos de compilação.
