# Bot Discord IA

Bot de Discord sem aplicação web para entender pedidos em linguagem natural, diagnosticar permissões e propor mudanças em um servidor existente. O bot cria um canal privado de controle ao entrar no servidor. Ele pode rodar como worker no Railway ou como processo local contínuo.

## O que já está implementado

- Conexão ao Discord e PostgreSQL, migrações automáticas e criação do canal privado `#comandos-do-bot`.
- Acesso restrito ao dono, administradores e membros autorizados com `/bot-autorizar` e `/bot-revogar`.
- Configuração global com `/bot-configurar`: o operador informa os limites centrais, o padrão inicia em `openrouter/free` e pode escolher outro modelo gratuito compatível com chamadas de ferramenta.
- Cada pedido no canal privado abre um tópico vinculado à mensagem; as respostas ficam no tópico para manter `#comandos-do-bot` sem respostas acumuladas. O bot inclui até 20 mensagens recentes do tópico no contexto.
- Respostas com a chave central mostram a contagem mensal usada pelo servidor no próprio resultado, sem uma mensagem adicional de aviso para cada pedido.
- O bot explica o diagnóstico e propõe ações para visibilidade e leitura de histórico, além de criar categorias/canais/cargos e excluir cargos comuns. Só aplica mudanças após clicar em **Confirmar alterações**. Propostas expiram em cinco minutos.
- Chaves pessoais do OpenRouter podem ser coladas no canal privado: o bot valida a chave, salva cifrada e apaga a mensagem. Os pedidos daquela pessoa usam a chave pessoal sem fallback silencioso para a central. `/bot-chave-remover` remove a chave.
- Limites de consumo da chave central são solicitados ao operador na configuração; não há quotas fixas codificadas.

O MVP pode ajustar visibilidade e leitura de histórico em canais/categorias, criar categorias/canais/cargos básicos e excluir cargos comuns. O bot bloqueia a exclusão de `@everyone`, cargos com permissões administrativas, cargos atribuídos ao dono e cargos gerenciados por integrações. Toda exclusão exige confirmação explícita. O bot consulta menções e a estrutura para o diagnóstico; se o alvo não estiver claro, mencione a pessoa/canal/cargo explicitamente no pedido.

## 1. Criar e configurar o app no Discord

O app Discord é separado do projeto Railway e não exige site, painel web, domínio, OAuth login de usuários, Client Secret ou Redirect URI.

1. Abra o [Discord Developer Portal](https://discord.com/developers/applications), crie uma **New Application** e escolha o nome.
2. Em **General Information**, copie **Application ID** para `DISCORD_CLIENT_ID`.
3. Abra **Bot**, crie o bot se necessário e use **Reset Token**. Guarde o token em `DISCORD_BOT_TOKEN` e nunca o compartilhe ou comite. Se vazar, redefina-o no portal.
4. Em **Bot > Privileged Gateway Intents**, habilite **Message Content Intent**. É necessário para interpretar mensagens livres no canal de controle. O Discord exige que intents privilegiados estejam habilitados no portal e solicitados no código; veja a [documentação oficial](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents).
5. Ative Developer Mode no Discord, clique com o botão direito no seu perfil e escolha **Copy User ID**. Esse ID vai em `BOT_OWNER_DISCORD_ID` e protege a configuração global.
6. Em **OAuth2 > URL Generator**, marque os escopos `bot` e `applications.commands`. Gere o link e adicione o bot a um servidor de teste.
7. Conceda ao bot **View Channels**, **Send Messages**, **Read Message History**, **Manage Channels**, **Manage Roles**, **Manage Messages**, **Manage Threads**, **Create Public Threads** e **Send Messages in Threads**. Cada pedido é tratado em um tópico vinculado para manter o canal principal limpo; no fim, o bot pergunta se deve salvar o tópico ou encerrá-lo. Se não tiver permissão para criar um tópico, ele responde no canal de controle. Ele precisa apagar a mensagem depois que salva uma chave pessoal. Não conceda **Administrator**. Deixe o cargo do bot acima dos cargos que ele precisará editar.
8. Ao iniciar, o bot registra automaticamente os slash commands em cada servidor onde está instalado; também registra ao ser adicionado a um novo servidor. Essa publicação por servidor é imediata e não exige rodar `npm run commands:deploy`. No Discord, digite `/` e selecione `/bot-configurar` na lista; não envie o nome como texto comum. O operador usa o formulário para definir limites e escolher o modelo gratuito. Administradores podem autorizar outros membros.

Os escopos `bot` e `applications.commands` são os necessários para instalar o usuário bot e usar slash commands ([documentação de application commands do Discord](https://docs.discord.com/developers/docs/interactions/slash-commands)).

## 2. Variáveis de ambiente

Copie `.env.example` para `.env` em execução local. No Railway, preencha as variáveis em **Service > Variables**. Nunca comite `.env`.

| Variável | Obrigatória | Onde obter / para que serve |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Sim | **Bot > Reset Token** no Developer Portal. Segredo do bot Discord. |
| `DISCORD_CLIENT_ID` | Sim | **General Information > Application ID**. |
| `DISCORD_GUILD_ID` | Não | Opcional, apenas para publicação manual via `npm run commands:deploy`; o bot publica automaticamente os comandos nos servidores onde está instalado. |
| `BOT_OWNER_DISCORD_ID` | Sim | Seu User ID do Discord. Só esta pessoa pode executar `/bot-configurar`. |
| `DATABASE_URL` | Sim | URL PostgreSQL local ou referência Railway como `${{Postgres.DATABASE_URL}}` (ajuste `Postgres` ao nome do serviço criado). |
| `OPENROUTER_API_KEY` | **Sim, sempre** | Chave central do OpenRouter. É obrigatória já na primeira inicialização; sem ela o processo não inicia. |
| `AI_KEY_ENCRYPTION_KEY` | Sim, para cadastrar chave pessoal | Gere com `openssl rand -hex 32`. São 32 bytes em hexadecimal, usados para cifrar chaves antes de persistir no PostgreSQL. Guarde como segredo separado do banco. |
| `NODE_ENV` | Não | `development` localmente; `production` no Railway. |

O modelo inicial não é escolhido por variável: o assistente começa em `openrouter/free`. Na configuração, o catálogo é consultado ao vivo e a lista mostra apenas opções com custo de entrada/saída zero e suporte a ferramentas. O modelo Router escolhe um modelo gratuito compatível em cada chamada; o catálogo muda, então os nomes não ficam hard-coded. OpenRouter documenta o [router gratuito](https://openrouter.ai/openrouter/free) e sua [API de catálogo de modelos](https://openrouter.ai/docs/api/api-reference/models/get-models). Modelos gratuitos ainda têm rate limits e podem ficar indisponíveis.

Os pedidos enviados à IA incluem o texto digitado e um retrato do servidor com nomes/IDs de canais e cargos e dados de membros explicitamente mencionados. Esses dados são enviados ao OpenRouter e ao provedor escolhido; não inclua senhas ou segredos nos pedidos.

Uma pessoa pode colar a chave `sk-or-v1-...` no canal de controle. Após validação e gravação cifrada, o bot apaga a mensagem e confirma por DM. Se o bot não conseguir apagá-la, avisa para remoção manual. `/bot-chave-remover` apaga a chave pessoal salva. Depois de cadastrar uma chave pessoal, aquela pessoa não consome a chave central e uma falha na chave própria não troca automaticamente para a central.

## 3. Rodar localmente

Pré-requisitos: Node.js 22+, PostgreSQL acessível, o app Discord acima e uma chave OpenRouter.

```bash
cd "/home/vnxxrz/Área de trabalho/bot-discord-IA"
npm install
cp .env.example .env
```

Edite `.env` e preencha as variáveis obrigatórias, incluindo `OPENROUTER_API_KEY`. Gere e configure também `AI_KEY_ENCRYPTION_KEY` para habilitar chaves pessoais. Mantenha esse segredo estável; trocá-lo sem recifrar as chaves salvas impede que sejam abertas.

```bash
npm run build
npm run db:migrate
npm run commands:deploy
npm run dev
```

`npm run dev` mantém o bot conectado enquanto o terminal está aberto. Fechar o terminal ou suspender/desligar o computador desconecta o bot.

### Manter ligado em uma máquina local

Use PM2 para reiniciar o processo em falhas e iniciar com o Linux. Execute os comandos da pasta do projeto, onde está o `.env`:

```bash
npm run build
npm run db:migrate
npm run commands:deploy
npm install --global pm2
pm2 start dist/index.js --name bot-discord-ia
pm2 save
pm2 startup
```

`pm2 startup` imprime uma instrução adicional: copie e execute a instrução exibida, depois rode `pm2 save` novamente. Veja os logs com `pm2 logs bot-discord-ia`. Após atualizar o código, rode `npm run build` e `pm2 restart bot-discord-ia`. A máquina precisa ficar ligada e online para o bot permanecer ativo.

Se quiser manter os segredos e banco no Railway, mas rodar o processo local, vincule Railway CLI ao projeto e execute `railway run npm run dev`; a plataforma fornece as variáveis configuradas ao processo local ([Railway Variables](https://docs.railway.com/variables)).

## 4. Deploy no Railway

1. Crie um repositório GitHub para esta pasta e envie os arquivos, sem `.env`.
2. No Railway, crie um projeto conectado ao repositório como um serviço persistente de bot.
3. Adicione um serviço **PostgreSQL** ao mesmo projeto. No serviço do bot, crie `DATABASE_URL` como referência à variável do PostgreSQL; por exemplo `${{Postgres.DATABASE_URL}}`. O nome antes do ponto deve corresponder ao nome real do serviço. O Railway fornece `DATABASE_URL` para os serviços ([guia oficial do PostgreSQL](https://docs.railway.com/databases/postgresql)).
4. Cadastre `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `BOT_OWNER_DISCORD_ID`, `OPENROUTER_API_KEY`, `AI_KEY_ENCRYPTION_KEY`, `DATABASE_URL` e `NODE_ENV=production` em **Variables**.
5. `railway.json` compila o TypeScript, executa migrações e inicia o bot. Ao conectar, ele registra os slash commands em cada servidor, e o log informa o ID do servidor. Não é necessário rodar `npm run commands:deploy`, domínio público ou porta HTTP. O comando manual continua disponível para manutenção e pode publicar globalmente quando `DISCORD_GUILD_ID` estiver vazio.
6. Confira os logs do serviço e teste o canal criado no Discord. Rode `/bot-configurar` como operador; preencha os três limites que o bot perguntar e mantenha `openrouter/free` ou selecione outro modelo gratuito.
7. Para testar a chave pessoal, cole a chave OpenRouter no canal privado. Confira que a mensagem sumiu e a confirmação chegou por DM; depois mande um pedido usando essa chave.

O Railway oferece referências de variáveis entre serviços e deploy conectado ao GitHub ([variáveis](https://docs.railway.com/variables), [serviços](https://docs.railway.com/services)).

## Teste inicial sugerido no Discord

1. No servidor de teste, confirme que existe `#comandos-do-bot` e que só você/admins o veem. Publique os comandos para esse servidor conforme a etapa de deploy.
2. No Discord, digite `/` e escolha `/bot-configurar` na lista de comandos do **mesmo bot**; a mensagem deve aparecer como comando de aplicação, com o ícone do bot, antes de enviar. Se o bot responder que o serviço ainda não foi configurado no canal, isso veio do processamento de mensagem comum: o comando slash não foi selecionado. Se o comando responder que é exclusivo do operador, confira se `BOT_OWNER_DISCORD_ID` é o seu User ID.
3. Informe os limites que quer para pedidos centrais por pessoa/dia, por servidor/mês e tokens máximos por resposta. `openrouter/free` fica ativo de imediato.
4. No canal privado, envie: `Por que <@membro> não consegue ver <#canal>?` e troque pelas menções reais.
5. Confira diagnóstico, ação proposta e impacto; pressione **Confirmar alterações** só quando a proposta estiver correta. Sem confirmação, nada muda.
6. Teste `/bot-autorizar` e `/bot-revogar` com outra conta/membro autorizado.

Veja [docs/PLANO.md](docs/PLANO.md) para as próximas capacidades e regras de segurança.
