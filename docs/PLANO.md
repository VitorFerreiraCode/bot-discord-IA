# Plano — Bot Discord IA

## Objetivo

Bot de Discord sem aplicação web para entender pedidos em linguagem natural, consultar a configuração de um servidor existente e propor mudanças confirmáveis. O deploy é um worker persistente no Railway, com opção de execução local.

## Requisitos confirmados

- O servidor Discord já existe; o bot atua somente nos servidores onde foi instalado.
- Ao entrar, o bot cria um canal privado de controle.
- Só administradores e membros autorizados podem usar as funções do servidor.
- A chave central do OpenRouter é obrigatória em OPENROUTER_API_KEY; o processo não inicia sem ela.
- O modelo de partida é openrouter/free. O catálogo consultado na configuração oferece apenas variantes gratuitas compatíveis com chamadas de ferramenta.
- O operador indicado por BOT_OWNER_DISCORD_ID preenche limites globais no fluxo inicial; o bot não fixa cotas por conta própria.
- Uma pessoa pode cadastrar uma chave pessoal do OpenRouter. As chamadas dela usam essa chave, sem fallback silencioso para a central.
- A chave pessoal é validada, cifrada com AES-256-GCM, persistida no PostgreSQL e sua mensagem original é removida. Se a remoção falhar, o bot alerta para apagar manualmente.
- O bot consulta canais, categorias, cargos, permissões efetivas e pessoas mencionadas para diagnosticar o pedido.
- Toda mudança precisa aparecer em uma proposta e de confirmação humana.

## Fluxo atual implementado

1. O administrador instala o bot em um servidor existente e concede as permissões necessárias.
2. O bot cria #comandos-do-bot, privado para dono, administradores, bot e membros autorizados.
3. O operador executa /bot-configurar, informa pedidos centrais por pessoa/dia, pedidos centrais por servidor/mês e tokens máximos de saída.
4. O modelo gratuito openrouter/free é ativado imediatamente. O operador pode manter o router ou selecionar outro modelo gratuito com suporte a ferramentas.
5. Administradores autorizam/removem membros com /bot-autorizar e /bot-revogar.
6. Um membro autorizado descreve o problema no canal privado. Cada solicitação abre um tópico ligado à mensagem; o canal principal não recebe as respostas. Para identificar pessoas ou canais sem ambiguidade, deve mencioná-los no Discord.
7. Se a pessoa não tem chave própria, o bot informa que usará a central e confere as cotas configuradas; se tem, usa a chave individual.
8. A IA recebe o pedido, o histórico recente do tópico e o estado de permissões efetivas e overwrites. Ela retorna diagnóstico e opções concretas de correção, incluindo `ReadMessageHistory`.
9. O bot valida as ações, apresenta resumo e impacto e oferece Confirmar alterações ou Cancelar. A proposta expira após cinco minutos.
10. Só ao confirmar o bot chama a API do Discord. Falhas parciais são reportadas. Ao final, o usuário pode manter o tópico ou encerrá-lo; o histórico não é apagado.

## Ações que o MVP executa

- Permitir/remover visualização de um canal ou categoria para um membro ou cargo específico.
- Permitir leitura do histórico de um canal/categoria para um membro ou cargo específico.
- Criar categoria.
- Criar canal de texto público (usando as permissões da categoria, se houver) ou privado ao solicitante e administradores.

O bot não apaga canais/cargos, não concede Administrator e não executa outras alterações até serem implementadas com validação própria. Se não houver ação suportada, ele explica o diagnóstico ou pede esclarecimento.

## Uso e armazenamento de dados

- Configuração global, autorização por servidor, cotas, uso agregado e propostas pendentes ficam no PostgreSQL.
- Chaves pessoais são cifradas; AI_KEY_ENCRYPTION_KEY precisa ser um segredo estável de 32 bytes em hexadecimal e ficar fora do banco.
- Prompts completos não são guardados como histórico. Uma proposta persiste resumo/ações por até 14 dias para confirmação e auditoria.
- A solicitação e o retrato do servidor (nomes e IDs de canais/cargos e dados de membros mencionados) são enviados ao OpenRouter/provedor selecionado. Não enviar segredos em prompts.
- Chamadas centrais reservam uma tentativa antes de chamar o provedor; tentativas com erro também contam para as cotas. Chaves pessoais não consomem a quota central.
- Respostas sem conteúdo sensível são registradas como contagem de tokens, modelo, usuário, servidor e horário.

## Segurança e validação

- OPENROUTER_API_KEY, token Discord, DATABASE_URL e chave de cifragem são configurados como secrets/variáveis; segredos não entram em logs.
- Código valida IDs contra a guild atual, impede mudanças no próprio canal/categoria de controle e limita os tipos de ação.
- @everyone, exclusões, cargos administrativos e ações irreversíveis não são permitidos pelo planejador.
- Confirmação de mudanças expira em cinco minutos e só administradores/autorizados podem confirmar.
- O bot depende da hierarquia de cargos e permissões concedidas no Discord; erros e ações parciais são comunicados.
- O intent privilegiado Message Content é necessário para mensagens livres no canal privado.

## Arquitetura aprovada

- Node.js 22+, TypeScript e discord.js.
- PostgreSQL no Railway; migrações numeradas executadas antes da inicialização.
- API de Chat Completions do OpenRouter, com filtro de preço de entrada/saída zero e suporte a ferramentas.
- AES-256-GCM com chave mantida fora do banco para chaves de usuários.
- Worker persistente sem frontend ou porta HTTP.

## Próximas capacidades

- Ampliar ferramentas para cargos, mensagens, onboarding e diagnósticos adicionais com revisões de segurança por ação.
- Suportar provedores pessoais além do OpenRouter se necessário.
- Adicionar configuração por cargo, em vez de somente por usuário.
- Definir política/tempo de retenção e comandos para limpar histórico se a conversa persistente for implementada.
