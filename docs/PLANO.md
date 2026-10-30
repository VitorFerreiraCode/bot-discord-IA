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
9. O bot valida as ações, consulta o estado antes/depois, mostra canais afetados, membros em cache e alertas sobre negações individuais/silenciamentos de moderação, e oferece Confirmar alterações ou Cancelar. A proposta expira após cinco minutos.
10. Só ao confirmar o bot chama a API do Discord. Falhas parciais são reportadas. Ao final, o usuário pode manter o tópico ou encerrá-lo; o histórico não é apagado.
11. Permissões aplicadas e server mute podem ser revertidos por 24 horas se ninguém tiver alterado o mesmo valor depois. Mudanças concorrentes impedem a reversão automática para evitar sobrescrever o estado mais novo.
12. `/bot-status` mostra conexão, intents, permissões, hierarquia, banco, modelo gratuito, canal privado e resumo da auditoria recente.

## Ações que o MVP executa

- Permitir/remover visualização de um canal ou categoria para um membro ou cargo específico.
- Permitir leitura do histórico de um canal/categoria para um membro ou cargo específico.
- Ajustar `ViewChannel`, `ReadMessageHistory`, `Connect` e `Speak` em canal para um membro/cargo; aplicar permissões compatíveis à categoria e aos canais filhos.
- Criar cargos com permissões básicas seguras e excluir cargos comuns após confirmação explícita; cargos administrativos, do dono, `@everyone` e gerenciados são protegidos.
- Recriar um cargo e migrar seus membros, preservando permissões não administrativas e configurando visibilidade/leitura do histórico na categoria e nos canais de texto. Requer Server Members Intent habilitado no portal e em `DISCORD_GUILD_MEMBERS_INTENT`.
- Ajustar server mute de um membro mencionado somente quando o pedido atual disser explicitamente para desmutar/mutar e o bot tiver `MuteMembers`. Self mute é uma ação do próprio usuário; permitir `Speak` não o remove.
- Criar categoria.
- Criar canal de texto público (usando as permissões da categoria, se houver) ou privado ao solicitante e administradores.

O bot não apaga canais, não concede Administrator e não executa exclusões de cargos protegidos. Alterações e exclusões de cargos comuns só ocorrem após validação e confirmação.

## Uso e armazenamento de dados

- Configuração global, autorização por servidor, cotas, uso agregado e propostas pendentes ficam no PostgreSQL.
- Chaves pessoais são cifradas; AI_KEY_ENCRYPTION_KEY precisa ser um segredo estável de 32 bytes em hexadecimal e ficar fora do banco.
- Prompts completos não são guardados como histórico. Uma proposta persiste resumo/ações por até 14 dias para confirmação e auditoria.
- A solicitação e o retrato do servidor (nomes e IDs de canais/cargos e dados de membros mencionados) são enviados ao OpenRouter/provedor selecionado. Não enviar segredos em prompts.
- Chamadas centrais reservam uma tentativa antes de chamar o provedor; tentativas com erro também contam para as cotas. Chaves pessoais não consomem a quota central.
- Respostas sem conteúdo sensível são registradas como contagem de tokens, modelo, usuário, servidor e horário.
- Mudanças confirmadas são auditadas por até 90 dias: solicitante, confirmador, tipos/IDs das ações, resultado e estado necessário para reversão. O texto integral do pedido e chaves de API não entram na auditoria.

## Segurança e validação

- OPENROUTER_API_KEY, token Discord, DATABASE_URL e chave de cifragem são configurados como secrets/variáveis; segredos não entram em logs.
- Código valida IDs contra a guild atual, impede mudanças no próprio canal/categoria de controle e limita os tipos de ação.
- @everyone, exclusões, cargos administrativos e ações irreversíveis não são permitidos pelo planejador.
- Confirmação de mudanças expira em cinco minutos e só administradores/autorizados podem confirmar.
- O bot depende da hierarquia de cargos e permissões concedidas no Discord; erros e ações parciais são comunicados.
- A reversão automática expira em 24 horas e só aparece para planos inteiramente reversíveis. Se um overwrite ou estado de mute foi alterado depois da ação original, a reversão é bloqueada para preservar a mudança mais recente.
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

## Correções e melhorias implementadas nesta revisão

- A IA pode retornar diagnóstico sem alteração quando não há uma correção segura; não precisa inventar uma ação para preencher o plano.
- Exclusão/recriação de cargo exige intenção explícita na mensagem atual. O histórico do tópico não autoriza sozinho uma ação destrutiva, e negações/cancelamentos impedem a inferência determinística.
- Recriar cargo exige um único cargo e uma única categoria identificáveis pelo pedido; se houver ambiguidade, a inferência automática não gera proposta.
- O retrato prioriza canais da categoria citada, canais/cargos mencionados e cargos dos membros citados; a lista de canais e cargos não depende mais apenas dos primeiros itens em cache.
- A recriação copia os overwrites antigos do cargo nos canais alvo, preservando permissões de canal além de ViewChannel/ReadMessageHistory, e só tenta excluir o cargo antigo após criar, configurar e migrar o novo.
- Se a chamada para excluir o cargo antigo falhar de forma incerta, o bot mantém o novo cargo e orienta conferência manual em vez de tentar removê-lo e arriscar perder o único cargo ativo.
- O seletor reconhece mais pedidos comuns em português e prioriza modelos gratuitos com ferramentas e capacidade de raciocínio nas tarefas mais complexas. Chamadas têm timeout menor e uma tentativa de fallback de plano limitada.
- Enquanto aguarda o provedor, o bot renova o indicador de digitação e atualiza a mensagem de progresso. Logs correlacionam etapas por um ID curto sem registrar o texto completo do pedido.
- Pedidos claros para reparar histórico em categoria/canal e fala/conexão em um canal de voz podem usar um plano determinístico local. Isso evita depender de um modelo que não retornou a ferramenta; a proposta ainda precisa de confirmação antes de executar.
- As propostas mostram estado efetivo e overwrite explícito antes/depois, quantos canais terão overwrite alterado e canais afetados. Avisam quando negações individuais ou server mute podem impedir a correção do cargo.
- Permissões de categoria usam uma sequência com snapshot e rollback: se um canal falhar, o bot tenta restaurar as alterações anteriores e registra o resultado.
- Alterações confirmadas iniciam auditoria antes da execução, registram cada etapa e guardam apenas metadados de ações (sem prompts ou segredos). Permissões e server mute oferecem botão de reversão por 24 horas com verificação de conflito.
- `/bot-status` consulta estado do gateway, banco, configuração/modelo, intents, permissões do bot no servidor/canal privado, estados de mute em voz e resumo de auditoria.
- `npm test` cobre negações, cargos protegidos, IDs Discord, permissões aceitas, timeouts, validade temporal das propostas e rollback em falhas sequenciais.

## Próximas melhorias técnicas recomendadas

1. Adicionar testes de integração com um servidor Discord de teste e PostgreSQL para falhas reais da API, expiração no banco e reinício durante execução.
2. Carregar sob demanda canais/categorias/cargos relacionados e resumir retratos em servidores grandes, mantendo contagens e aviso de dados omitidos.
3. Considerar fila por servidor e limite de chamadas simultâneas para evitar rajadas, rate limits do Discord/OpenRouter e atrasos em servidores movimentados.
4. Tornar o período de retenção da auditoria configurável pelo operador.
