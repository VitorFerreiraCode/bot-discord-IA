import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import type { DiscordAction } from '../ai/actions.js';
import { planDiscordRequest } from '../ai/planner.js';
import { listFreeChatModels, validateOpenRouterKey } from '../ai/openrouter.js';
import { pool } from '../db/pool.js';
import {
  authorizeUser,
  cancelPendingChange,
  claimPendingChange,
  createPendingChange,
  deleteUserKey,
  getControlChannel,
  getGuildMonthlyCentralUsage,
  getServiceConfig,
  getUserKey,
  isAuthorized,
  appendPreparedAuditStep,
  claimChangeUndo,
  finishChangeAudit,
  finishChangeUndo,
  getGuildAuditSummary,
  markAuditStepApplied,
  recordUsageTokens,
  reserveUsage,
  revokeUser,
  startChangeAudit,
  setPendingChangeStatus,
  storeUserKey,
} from '../db/queries.js';
import { decryptSecret, encryptSecret } from '../security/key-crypto.js';
import { proposalExpiresAt } from '../security/discord-rules.js';
import { applyDiscordAction, captureActionUndoState, describeAction, describeActionImpact, isActionUndoable, revertDiscordAction } from './actions.js';
import { ensureControlChannel } from './control-channel.js';
import { beginSetup, finishSetupModal, selectServiceModel } from './setup-flow.js';
import { commands } from './commands.js';

const commandRest = new REST({ version: '10' }).setToken(env.discordBotToken());

async function deployGuildCommands(guildId: string): Promise<void> {
  await commandRest.put(Routes.applicationGuildCommands(env.discordClientId(), guildId), { body: commands });
  console.log(`Registered ${commands.length} slash commands in guild ${guildId}.`);
}

const gatewayIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
if (process.env.DISCORD_GUILD_MEMBERS_INTENT?.trim().toLowerCase() === 'true') gatewayIntents.push(GatewayIntentBits.GuildMembers);

export const client = new Client({ intents: gatewayIntents });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot conectado como ${readyClient.user.tag}.`);
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await deployGuildCommands(guild.id);
    } catch (error) {
      console.error(`Could not register slash commands in guild ${guild.id}:`, safeError(error));
    }
    try {
      await ensureControlChannel(readyClient, guild);
    } catch (error) {
      console.error(`Could not provision control channel for guild ${guild.id}:`, safeError(error));
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await deployGuildCommands(guild.id);
  } catch (error) {
    console.error(`Could not register slash commands in guild ${guild.id}:`, safeError(error));
  }
  try {
    const channel = await ensureControlChannel(client, guild);
    console.log(`Provisioned control channel ${channel.id} in guild ${guild.id}.`);
  } catch (error) {
    console.error(`Could not provision control channel for guild ${guild.id}:`, safeError(error));
  }
});

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  return error.message.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 160);
}

async function memberCanUse(guild: Guild, userId: string): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null);
  return Boolean(member?.permissions.has(PermissionFlagsBits.Administrator) || member?.permissions.has(PermissionFlagsBits.ManageGuild) || await isAuthorized(guild.id, userId));
}

async function handleAccessCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Este comando só pode ser usado por administradores do servidor.', ephemeral: true });
    return;
  }

  const target = interaction.options.getUser('membro', true);
  if (target.bot) {
    await interaction.reply({ content: 'Não é possível autorizar outro bot.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'bot-autorizar') {
    await authorizeUser(interaction.guild.id, target.id, interaction.user.id);
    const channel = await ensureControlChannel(client, interaction.guild);
    await channel.permissionOverwrites.edit(target.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
    }, { reason: `Acesso autorizado por ${interaction.user.tag}` });
    await interaction.reply({ content: `${target} agora pode usar o canal privado de controle.`, ephemeral: true });
    return;
  }

  await revokeUser(interaction.guild.id, target.id);
  const channel = await ensureControlChannel(client, interaction.guild);
  await channel.permissionOverwrites.delete(target.id, `Acesso revogado por ${interaction.user.tag}`).catch(() => null);
  await interaction.reply({ content: `A autorização de ${target} foi removida.`, ephemeral: true });
}

async function handleBotStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Este comando só pode ser usado por administradores do servidor.', ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const lines = [`**Status do bot em ${guild.name}**`, `Discord Gateway: ${client.isReady() ? '✅ conectado' : '❌ desconectado'}`];
  try {
    await pool.query('SELECT 1');
    lines.push('PostgreSQL: ✅ conectado');
  } catch {
    lines.push('PostgreSQL: ❌ sem conexão');
  }

  const config = await getServiceConfig().catch(() => null);
  lines.push(`Configuração global: ${config ? `✅ ativa (modelo configurado: \`${config.modelId}\`)` : '❌ pendente; operador deve usar /bot-configurar'}`);
  lines.push(`Chave central: ${env.openRouterApiKey ? '✅ presente' : '❌ ausente'}`);
  lines.push(`Message Content Intent: ${client.options.intents.has(GatewayIntentBits.MessageContent) ? '✅ ativo' : '❌ inativo'}`);
  lines.push(`Server Members Intent: ${client.options.intents.has(GatewayIntentBits.GuildMembers) ? '✅ ativo' : '⚠️ inativo (necessário para migração completa de cargos)'}`);

  const botMember = guild.members.me;
  const requiredPermissions: Array<[string, bigint]> = [
    ['Gerenciar canais', PermissionFlagsBits.ManageChannels],
    ['Gerenciar cargos/permissões', PermissionFlagsBits.ManageRoles],
    ['Gerenciar mensagens', PermissionFlagsBits.ManageMessages],
  ];
  const missingPermissions = botMember ? requiredPermissions.filter(([, permission]) => !botMember.permissions.has(permission)).map(([label]) => label) : requiredPermissions.map(([label]) => label);
  lines.push(missingPermissions.length ? `Permissões globais do bot ausentes: ${missingPermissions.join(', ')}` : 'Permissões globais do bot: ✅ completas');
  lines.push(`Silenciar/desmutar membros (opcional): ${botMember?.permissions.has(PermissionFlagsBits.MuteMembers) ? '✅ disponível' : '⚠️ sem permissão Mute Members'}`);
  lines.push(`Cargo mais alto do bot: ${botMember?.roles.highest.name ?? 'não encontrado'} (posição ${botMember?.roles.highest.position ?? '—'})`);

  const controlId = await getControlChannel(guild.id).catch(() => null);
  const control = controlId ? await guild.channels.fetch(controlId).catch(() => null) : null;
  lines.push(`Canal privado: ${control ? `✅ <#${control.id}>` : '❌ não encontrado; tente reiniciar o bot ou revisar as permissões'}`);
  if (control && botMember && 'permissionsFor' in control) {
    const controlPermissions = control.permissionsFor(botMember);
    const missingControl: string[] = [];
    if (!controlPermissions?.has(PermissionFlagsBits.ViewChannel)) missingControl.push('Ver canal');
    if (!controlPermissions?.has(PermissionFlagsBits.SendMessages)) missingControl.push('Enviar mensagens');
    if (!controlPermissions?.has(PermissionFlagsBits.ReadMessageHistory)) missingControl.push('Ler histórico');
    lines.push(missingControl.length ? `Permissões do canal privado ausentes: ${missingControl.join(', ')}` : 'Permissões no canal privado: ✅ completas');
    const canUseThreads = controlPermissions?.has(PermissionFlagsBits.CreatePublicThreads)
      && controlPermissions.has(PermissionFlagsBits.SendMessagesInThreads)
      && controlPermissions.has(PermissionFlagsBits.ManageThreads);
    lines.push(`Tópicos no canal privado (criar, responder e arquivar): ${canUseThreads ? '✅ disponíveis' : '⚠️ faltam permissões específicas no canal'}`);
  }
  const mutedMembers = [...guild.voiceStates.cache.values()].filter((state) => state.serverMute).length;
  const selfMutedMembers = [...guild.voiceStates.cache.values()].filter((state) => state.selfMute).length;
  lines.push(`Voz no momento: ${mutedMembers} server mute(s), ${selfMutedMembers} self mute(s) entre membros em cache`);
  lines.push('Hierarquia: o cargo do bot precisa ficar acima dos cargos que ele deve editar.');

  if (config) {
    try {
      const models = await listFreeChatModels(env.openRouterApiKey);
      const selectedAvailable = config.modelId === 'openrouter/free' || models.some((model) => model.id === config.modelId);
      lines.push(`Catálogo OpenRouter gratuito: ${selectedAvailable ? '✅ disponível' : '⚠️ modelo atual ausente'} (${models.length} modelos compatíveis listados)`);
    } catch {
      lines.push('Catálogo OpenRouter gratuito: ⚠️ não foi possível consultar agora');
    }
  }
  const audit = await getGuildAuditSummary(guild.id).catch(() => null);
  lines.push(audit ? `Auditoria (30 dias): ${audit.total} mudanças, ${audit.failures} falhas, ${audit.undone} reversões` : 'Auditoria: ⚠️ indisponível; confirme se a migração de banco foi aplicada');
  await interaction.editReply(lines.join('\n'));
}

async function handleKeyMessage(message: Message, key: string): Promise<void> {
  let result = 'Não consegui salvar a chave. Confira a configuração do serviço e tente novamente.';
  let saved = false;
  try {
    await validateOpenRouterKey(key);
    const encrypted = encryptSecret(key);
    await storeUserKey(message.author.id, encrypted);
    saved = true;
    result = 'Chave pessoal do OpenRouter validada e salva cifrada. Seus próximos pedidos usarão sua chave e não consumirão a chave central.';
  } catch (error) {
    console.error(`Personal OpenRouter key setup failed for user ${message.author.id}:`, safeError(error));
    const code = error instanceof Error ? error.message : '';
    if (code === 'OPENROUTER_KEY_INVALID') result = 'O OpenRouter recusou essa chave. Não a salvei; gere ou copie uma chave válida e tente novamente.';
    else if (code.includes('AI_KEY_ENCRYPTION_KEY')) result = 'A chave foi validada pelo OpenRouter, mas ainda não foi salva porque falta configurar AI_KEY_ENCRYPTION_KEY no serviço.';
    else if (code.includes('HTTP_')) result = 'Não consegui validar a chave com o OpenRouter agora. Tente novamente em instantes.';
  }
  let deleted = true;
  try { await message.delete(); } catch { deleted = false; }
  if (!deleted) result += ' Não consegui apagar a mensagem no canal: apague-a manualmente agora.';
  if (!saved && !deleted) result += ' A chave não foi salva.';
  await message.author.send(result).catch(async () => {
    const fallback = saved ? 'Sua chave foi salva, mas não consegui enviar a confirmação por DM.' : 'Não consegui salvar sua chave nem enviar uma confirmação por DM. Apague a mensagem se ela ainda estiver visível.';
    await (message.channel as TextChannel).send(`<@${message.author.id}> ${fallback}`).catch(() => null);
  });
}

function actionRows(changeId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`change-confirm:${changeId}`).setLabel('Confirmar alterações').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`change-cancel:${changeId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary),
  )];
}

function undoActionRows(changeId: string, includeTopic: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const undoRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`change-undo:${changeId}`).setLabel('Reverter alterações').setStyle(ButtonStyle.Primary),
  );
  return [undoRow, ...(includeTopic ? topicChoiceRows() : [])];
}

function auditMetadata(actions: DiscordAction[]): unknown[] {
  return actions.map((action) => {
    const entry: Record<string, unknown> = { type: action.type };
    if ('channelId' in action) entry.channelId = action.channelId;
    if ('categoryId' in action && action.categoryId) entry.categoryId = action.categoryId;
    if ('roleId' in action) entry.roleId = action.roleId;
    if ('memberId' in action) entry.memberId = action.memberId;
    if ('targetType' in action) entry.targetType = action.targetType;
    if ('targetId' in action) entry.targetId = action.targetId;
    if ('permissions' in action) entry.permissions = Object.keys(action.permissions);
    if ('visible' in action) entry.visible = action.visible;
    if ('muted' in action) entry.muted = action.muted;
    if ('name' in action) entry.name = action.name;
    return entry;
  });
}

function actionWithoutReason(action: DiscordAction): Omit<DiscordAction, 'reason'> & { reason?: never } {
  const { reason: _redactedReason, ...safeAction } = action;
  return safeAction as Omit<DiscordAction, 'reason'> & { reason?: never };
}

function topicChoiceRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('topic:save').setLabel('Salvar tópico').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('topic:close').setLabel('Encerrar tópico').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('topic:edit').setLabel('Editar pedido').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('topic:rename').setLabel('Renomear').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('topic:summary').setLabel('Resumo').setStyle(ButtonStyle.Secondary),
  )];
}

const topicClosingQuestion = '\n\nDeseja salvar esse tópico ou posso encerrar após me informar?';

async function sendTopicMessage(channel: TextChannel | ThreadChannel, content: string): Promise<void> {
  const isThread = channel.isThread();
  await channel.send({
    content: `${content}${isThread ? topicClosingQuestion : ''}`.slice(0, 2000),
    components: isThread ? topicChoiceRows() : [],
  });
}

async function getThreadHistory(message: Message): Promise<string | undefined> {
  if (!message.channel.isThread()) return undefined;
  const thread = message.channel as ThreadChannel;
  const recent = await thread.messages.fetch({ limit: 20 }).catch(() => null);
  if (!recent) return undefined;
  const entries = [...recent.values()]
    .filter((entry) => entry.id !== message.id && (entry.content.trim() || entry.embeds.length > 0))
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map((entry) => {
      const embedText = entry.embeds.map((embed) => [embed.title, embed.description, ...embed.fields.map((field) => `${field.name}: ${field.value}`)].filter(Boolean).join('\n')).filter(Boolean).join('\n');
      const content = [entry.content, embedText].filter(Boolean).join('\n').replace(/\s+/g, ' ').slice(0, 1200);
      return `${entry.author.bot ? 'Bot' : entry.author.username}: ${content}`;
    });
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter?.content.trim() && !entries.some((entry) => entry.includes(starter.content.slice(0, 80)))) {
    entries.unshift(`${starter.author.username}: ${starter.content.replace(/\s+/g, ' ').slice(0, 900)}`);
  }
  return entries.slice(-20).join('\n').slice(-8000) || undefined;
}

async function processRequest(message: Message, requestTextOverride?: string, requesterId = message.author.id): Promise<void> {
  if (!message.guild) return;
  if (!await memberCanUse(message.guild, requesterId)) return;
  const controlChannelId = await getControlChannel(message.guild.id);
  const isControlThread = message.channel.isThread() && message.channel.parentId === controlChannelId;
  if (message.channelId !== controlChannelId && !isControlThread) return;
  const requestText = (requestTextOverride ?? message.content).trim();
  if (!requestText) return;
  const requestId = randomUUID().slice(0, 8);
  const requestStartedAt = Date.now();
  let responseChannel: TextChannel | ThreadChannel = message.channel as TextChannel | ThreadChannel;
  if (!isControlThread) {
    try {
      const title = requestText.replace(/<[@#&!]\d+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 85) || 'análise detalhada';
      responseChannel = await message.startThread({ name: `Pedido: ${title}`, autoArchiveDuration: 1440 });
    } catch (error) {
      console.warn(`Could not create request thread for message ${message.id}:`, safeError(error));
    }
  }

  const config = await getServiceConfig();
  if (!config) {
    await sendTopicMessage(responseChannel, 'O serviço ainda não foi configurado. O operador deve executar `/bot-configurar` para definir limites e modelo gratuito.');
    return;
  }

  let apiKey: string;
  let source: 'central' | 'personal';
  const encryptedKey = await getUserKey(requesterId);
  if (encryptedKey) {
    try {
      apiKey = decryptSecret(encryptedKey);
      source = 'personal';
    } catch {
      await sendTopicMessage(responseChannel, 'Não consegui abrir sua chave pessoal salva. Ela foi mantida sem fallback para a chave central; remova-a com `/bot-chave-remover` e envie novamente.');
      return;
    }
  } else {
    apiKey = env.openRouterApiKey;
    source = 'central';
  }

  if (config.modelId !== 'openrouter/free') {
    try {
      const currentFreeModels = await listFreeChatModels(env.openRouterApiKey);
      if (!currentFreeModels.some((model) => model.id === config.modelId)) {
        await sendTopicMessage(responseChannel, 'O modelo configurado não aparece mais entre os modelos gratuitos compatíveis. O operador precisa executar /bot-configurar e escolher novamente.');
        return;
      }
    } catch {
      await sendTopicMessage(responseChannel, 'Não consegui conferir o catálogo gratuito do OpenRouter. Tente novamente em instantes.');
      return;
    }
  }

  let usageId: string;
  try {
    usageId = await reserveUsage(message.guild.id, requesterId, source, config.modelId, config);
  } catch (error) {
    if (error instanceof Error && error.message === 'USER_DAILY_LIMIT') {
      await sendTopicMessage(responseChannel, 'Você atingiu o limite diário configurado para a chave central. Cadastre sua chave pessoal ou aguarde a renovação do limite.');
    } else if (error instanceof Error && error.message === 'GUILD_MONTHLY_LIMIT') {
      await sendTopicMessage(responseChannel, 'Este servidor atingiu o limite mensal configurado para a chave central. Uma pessoa pode cadastrar uma chave própria para continuar usando.');
    } else {
      await sendTopicMessage(responseChannel, 'Não consegui reservar o uso da IA. Tente novamente mais tarde.');
    }
    return;
  }

  let progressMessage: Message | null = null;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let slowNoticeSent = false;
  try {
    console.info(`[${requestId}] Pedido recebido no servidor ${message.guild.id}, usuário ${message.author.id}, chave ${source}.`);
    progressMessage = await responseChannel.send('⏳ Recebi seu pedido. A IA está analisando; atualizarei esta mensagem com o resultado.');
    await responseChannel.sendTyping();
    typingInterval = setInterval(() => {
      void responseChannel.sendTyping().catch(() => null);
      if (!slowNoticeSent && progressMessage && Date.now() - requestStartedAt > 25_000) {
        slowNoticeSent = true;
        void progressMessage.edit('⏳ A análise ainda está em andamento. Estou consultando o modelo gratuito e verificando o estado do servidor.').catch(() => null);
      }
    }, 8_000);
    typingInterval.unref?.();
    const history = await getThreadHistory(message);
    const result = await planDiscordRequest({ message, apiKey, model: config.modelId, maxOutputTokens: config.maxOutputTokens, history, traceId: requestId, requestTextOverride });
    clearInterval(typingInterval);
    typingInterval = null;
    await recordUsageTokens(usageId, result.inputTokens, result.outputTokens, result.modelId);
    const guildUsage = source === 'central' ? await getGuildMonthlyCentralUsage(message.guild.id).catch(() => null) : null;
    const modelDescription = result.modelId.startsWith('local/')
      ? 'Correção preparada pelas regras locais do bot; nenhum pedido foi enviado ao provedor de IA.'
      : `Modelo gratuito selecionado: \`${result.modelId}\`.`;
    const usageDescription = `${guildUsage === null ? '' : `\n\nUso da chave central neste servidor neste mês: **${guildUsage}/${config.guildMonthlyLimit} pedidos**.`}\n\n${modelDescription}`;
    if (!result.plan) {
      const topicRows = responseChannel.isThread() ? topicChoiceRows() : [];
      await progressMessage.edit({ content: `${result.text.slice(0, 1600)}${usageDescription}${topicClosingQuestion}`.slice(0, 2000), embeds: [], components: topicRows, allowedMentions: { parse: [] } });
      return;
    }

    const actions = result.plan.actions;
    const id = randomUUID();
    const expiresAt = proposalExpiresAt(Date.now());
    await createPendingChange({
      id,
      guildId: message.guild.id,
      channelId: responseChannel.id,
      requestedBy: requesterId,
      summary: result.plan.summary,
      actions,
      expiresAt,
    });
    const actionDescription = (await Promise.all(actions.map(async (action) => {
      try { return await describeActionImpact(message.guild!, action); }
      catch { return `${describeAction(message.guild!, action)}\n  Impacto: não consegui fazer a prévia detalhada; confira as permissões do bot.`; }
    }))).join('\n').slice(0, 3000);
    const embed = new EmbedBuilder()
      .setTitle('Diagnóstico e proposta de alteração')
      .setDescription(`${result.plan.summary.slice(0, 650)}\n\n**Prévia do impacto (estado atual → alteração)**\n${actionDescription}\n\nPosso implementar após sua confirmação.${usageDescription}${topicClosingQuestion}`.slice(0, 4000))
      .setFooter({ text: 'Nada será alterado sem confirmação. Esta proposta expira em 5 minutos.' });
    await progressMessage.edit({
      content: null,
      embeds: [embed],
      components: [...actionRows(id), ...(responseChannel.isThread() ? topicChoiceRows() : [])],
      allowedMentions: { parse: [], users: [], roles: [] },
    });
  } catch (error) {
    if (typingInterval) clearInterval(typingInterval);
    console.error(`[${requestId}] AI request failed for guild ${message.guild.id}:`, safeError(error));
    const status = safeError(error);
    let errorMessage: string;
    if (status.includes('HTTP_401')) {
      errorMessage = source === 'personal'
        ? 'Sua chave pessoal foi recusada pelo OpenRouter. Não usei a chave central como alternativa. Remova/substitua sua chave com `/bot-chave-remover`.'
        : 'A chave central do OpenRouter foi recusada. O operador precisa revisar `OPENROUTER_API_KEY`.';
    } else if (status.includes('HTTP_429')) {
      errorMessage = 'O OpenRouter limitou temporariamente este modelo. Aguarde ou escolha outro modelo gratuito na configuração global.';
    } else if (/timeout|aborted/i.test(status)) {
      errorMessage = 'O modelo gratuito demorou mais de 2 minutos e a tentativa automática com outro modelo também não terminou. Nenhuma mudança foi aplicada; tente novamente em instantes ou escolha outro modelo gratuito.';
    } else if (status.includes('HTTP_400') || status.includes('HTTP_404') || status.includes('HTTP_422')) {
      errorMessage = 'O OpenRouter recusou a solicitação para o modelo atual. Tente novamente; se persistir, o operador deve selecionar outro modelo gratuito. O motivo técnico foi registrado nos logs do serviço.';
    } else if (status.includes('MODEL_NO_STRUCTURED_PLAN')) {
      errorMessage = 'Tentei outros modelos gratuitos, mas nenhum retornou um plano de correção estruturado. Nenhuma mudança foi aplicada; tente reformular o pedido ou repita em instantes.';
    } else {
      errorMessage = 'Não consegui concluir a análise desta vez. Nenhuma mudança foi aplicada; tente novamente. Se continuar, o log do serviço registra o erro do provedor para o operador corrigir.';
    }
    const topicQuestion = responseChannel.isThread() ? topicClosingQuestion : '';
    if (progressMessage) {
      await progressMessage.edit({ content: `${errorMessage}${topicQuestion}`, embeds: [], components: responseChannel.isThread() ? topicChoiceRows() : [] }).catch(() => responseChannel.send(`${errorMessage}${topicQuestion}`));
    } else {
      await responseChannel.send(`${errorMessage}${topicQuestion}`);
    }
  }
}

async function handleChangeButton(interaction: import('discord.js').ButtonInteraction): Promise<void> {
  if (!interaction.guild || !await memberCanUse(interaction.guild, interaction.user.id)) {
    await interaction.reply({ content: 'Você não está autorizado a confirmar mudanças neste servidor.', ephemeral: true });
    return;
  }
  const [action, id] = interaction.customId.split(':');
  if (!id) {
    await interaction.reply({ content: 'Esta proposta é inválida.', ephemeral: true });
    return;
  }

  if (action === 'change-cancel') {
    const cancelled = await cancelPendingChange(id, interaction.guild.id, interaction.user.id);
    if (!cancelled) {
      await interaction.reply({ content: 'Somente quem pediu pode cancelar esta proposta, ou ela já expirou.', ephemeral: true });
      return;
    }
    const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
    await interaction.update({ content: `Proposta cancelada. Nenhuma mudança foi aplicada.${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components: topicRows });
    return;
  }

  const change = await claimPendingChange(id, interaction.guild.id);
  if (!change) {
    const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
    await interaction.update({ content: `Esta proposta expirou ou já foi processada. Nenhuma nova alteração foi aplicada.${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components: topicRows });
    return;
  }
  await interaction.update({ content: 'Confirmação recebida. Estou aplicando as ações aprovadas...', embeds: [], components: [] });

  const actions = Array.isArray(change.actions) ? change.actions as DiscordAction[] : [];
  try {
    await startChangeAudit({
      pendingChangeId: id,
      guildId: interaction.guild.id,
      requestedBy: change.requestedBy,
      confirmedBy: interaction.user.id,
      actionMetadata: auditMetadata(actions),
    });
  } catch (error) {
    await setPendingChangeStatus(id, 'failed');
    console.error(`Could not start change audit ${id}:`, safeError(error));
    await interaction.editReply({ content: 'Não apliquei nenhuma alteração porque não consegui iniciar o registro de auditoria. Verifique se a migração do banco foi aplicada.', components: interaction.channel?.isThread() ? topicChoiceRows() : [] });
    return;
  }
  const completed: string[] = [];
  let allActionsReversible = actions.length > 0;
  for (const action of actions) {
    try {
      const before = await captureActionUndoState(interaction.guild, action);
      const reversible = isActionUndoable(action) && before !== null;
      if (!reversible) allActionsReversible = false;
      await appendPreparedAuditStep(id, { action: actionWithoutReason(action), before, reversible, status: 'prepared' });
      completed.push(await applyDiscordAction(interaction.guild, change.requestedBy, action));
      await markAuditStepApplied(id);
    } catch (error) {
      await setPendingChangeStatus(id, 'failed');
      await finishChangeAudit(id, completed.length ? 'partial_failed' : 'failed', null).catch((auditError) => console.error(`Could not finalize failed audit ${id}:`, safeError(auditError)));
      console.error(`Approved Discord action failed in guild ${interaction.guild.id}:`, safeError(error));
      const progress = completed.length ? ` Ações aplicadas antes da falha: ${completed.join(' ')}` : '';
      const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
      const failure = safeError(error);
      const reason = failure.includes('PROTECTED_ROLE')
        ? 'Bloqueei a exclusão porque o cargo é de administrador/dono ou é gerenciado pelo Discord.'
        : failure.includes('BOT_GUILD_MEMBERS_INTENT_REQUIRED')
          ? 'Para preservar todos os membros ao recriar o cargo, habilite Server Members Intent no Developer Portal e configure DISCORD_GUILD_MEMBERS_INTENT=true no Railway. Não excluí o cargo antigo.'
        : failure.includes('ROLE_RECREATE_COMMIT_UNCERTAIN')
          ? 'A API falhou durante a remoção final do cargo antigo. Mantive o cargo novo para evitar perda de acesso; confira os dois cargos e os membros antes de repetir.'
        : failure.includes('ROLE_RECREATE_FAILED') && failure.includes('ROLLBACK_INCOMPLETE')
          ? 'A substituição falhou e a reversão não terminou por completo. Confira os logs e a lista de cargos/membros antes de tentar de novo.'
        : failure.includes('ROLE_RECREATE_FAILED')
          ? 'A substituição falhou antes de concluir. O bot tentou reverter o cargo novo e manter o antigo; confira os logs antes de repetir.'
        : failure.includes('ROLE_ABOVE_BOT_HIERARCHY')
          ? 'O cargo está acima do cargo do bot na hierarquia do servidor.'
          : failure.includes('CATEGORY_PERMISSION_UPDATE_FAILED') && failure.includes('ROLLBACK_INCOMPLETE')
            ? 'A correção da categoria falhou parcialmente e a reversão também não terminou. Confira os canais da categoria antes de tentar de novo.'
          : failure.includes('CATEGORY_PERMISSION_UPDATE_FAILED')
            ? 'A correção da categoria falhou; reverti as permissões que já tinham sido alteradas. Confira o log se o problema persistir.'
          : failure.includes('BOT_MISSING_MANAGE_ROLES')
            ? 'O bot precisa da permissão Gerenciar cargos.'
            : failure.includes('BOT_MISSING_MANAGE_GUILD')
              ? 'O bot precisa da permissão Gerenciar servidor para editar o onboarding.'
              : failure.includes('ONBOARDING_PROMPT_LIMIT')
                ? 'O onboarding já tem o limite de perguntas do Discord. Nenhuma pergunta foi removida; apague ou combine uma pergunta manualmente e tente novamente.'
                : failure.includes('ONBOARDING_OPTION_LIMIT')
                  ? 'A pergunta de jogos já atingiu o limite de opções do Discord. Nenhuma pergunta foi removida; ajuste as opções manualmente e tente novamente.'
                  : failure.includes('50035') || failure.includes('ONBOARDING')
                    ? 'O Discord recusou a alteração do onboarding. Confirme que a Comunidade e o onboarding estão ativados e que os canais padrão atendem aos requisitos do Discord. Confira o log se persistir.'
            : failure.includes('BOT_MISSING_MUTE_MEMBERS')
              ? 'Para remover o server mute solicitado, o bot precisa da permissão Silenciar membros (Mute Members).'
            : 'Confira as permissões do bot e a hierarquia de cargos.';
      await interaction.editReply({ content: `Não consegui concluir todas as ações. Já aplicadas: ${completed.length}/${actions.length}.${progress} ${reason}${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components: topicRows });
      return;
    }
  }
  await setPendingChangeStatus(id, 'completed');
  const undoExpiresAt = allActionsReversible ? new Date(Date.now() + 24 * 60 * 60_000) : null;
  await finishChangeAudit(id, 'applied', undoExpiresAt);
  const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
  const components = allActionsReversible ? undoActionRows(id, Boolean(interaction.channel?.isThread())) : topicRows;
  const undoMessage = allActionsReversible ? '\nVocê pode reverter essas permissões pelas próximas 24 horas.' : '';
  await interaction.editReply({ content: `Concluído. ${completed.join(' ')}${undoMessage}${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components });
}

async function handleChangeUndoButton(interaction: import('discord.js').ButtonInteraction, changeId: string): Promise<void> {
  if (!interaction.guild || !await memberCanUse(interaction.guild, interaction.user.id)) {
    await interaction.reply({ content: 'Você não está autorizado a reverter mudanças neste servidor.', ephemeral: true });
    return;
  }
  const journal = await claimChangeUndo(changeId, interaction.guild.id);
  if (!journal) {
    await interaction.reply({ content: 'A reversão expirou, já foi processada ou esta alteração não tem reversão automática disponível.', ephemeral: true });
    return;
  }
  await interaction.update({ content: 'Reversão confirmada. Estou restaurando as permissões anteriores...', embeds: [], components: [] });
  const steps = [...journal].reverse();
  const restored: string[] = [];
  try {
    for (const raw of steps) {
      if (!raw || typeof raw !== 'object') throw new Error('INVALID_UNDO_ENTRY');
      const step = raw as { action?: unknown; before?: unknown; status?: unknown; reversible?: unknown };
      if (step.status !== 'applied' || step.reversible !== true || !step.action) throw new Error('UNDO_NOT_FULLY_REVERSIBLE');
      restored.push(await revertDiscordAction(interaction.guild, step.action as DiscordAction, step.before));
    }
    await finishChangeUndo(changeId, 'undone');
    await interaction.editReply({ content: `Revertido. ${restored.join(' ')}${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, components: interaction.channel?.isThread() ? topicChoiceRows() : [] });
  } catch (error) {
    await finishChangeUndo(changeId, 'undo_failed');
    console.error(`Undo failed for change ${changeId} in guild ${interaction.guild.id}:`, safeError(error));
    const detail = safeError(error).includes('UNDO_CONFLICT')
      ? 'O estado atual mudou depois da alteração original; não sobrescrevi esse valor para preservar a mudança mais recente.'
      : 'Confira as permissões e o estado atual do servidor antes de tentar novamente.';
    await interaction.editReply({
      content: `Não consegui completar a reversão automática. Já reverti ${restored.length}/${steps.length} etapa(s). ${detail}${interaction.channel?.isThread() ? topicClosingQuestion : ''}`,
      components: interaction.channel?.isThread() ? topicChoiceRows() : [],
    });
  }
}

async function handleTopicButton(interaction: import('discord.js').ButtonInteraction): Promise<void> {
  const [, action] = interaction.customId.split(':');
  const thread = interaction.channel;
  if (!interaction.guild || !thread?.isThread() || thread.parentId !== await getControlChannel(interaction.guild.id)) {
    await interaction.reply({ content: 'Esse botão só funciona no tópico de um pedido do bot.', ephemeral: true });
    return;
  }
  if (!await memberCanUse(interaction.guild, interaction.user.id)) {
    await interaction.reply({ content: 'Você não está autorizado a gerenciar este tópico.', ephemeral: true });
    return;
  }
  if (action === 'save') {
    await interaction.reply({ content: 'Tópico salvo. O histórico permanece disponível no Discord, mesmo que seja arquivado por inatividade.', ephemeral: true });
    return;
  }
  if (action === 'edit') {
    const modal = new ModalBuilder().setCustomId('topic-edit-submit').setTitle('Editar pedido para a IA');
    const field = new TextInputBuilder().setCustomId('request').setLabel('Descreva o que você quer corrigir').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(3000).setValue((await thread.messages.fetch({ limit: 30 }).catch(() => null))?.filter((message) => !message.author.bot).sort((a, b) => b.createdTimestamp - a.createdTimestamp).first()?.content.slice(0, 3000) ?? '');
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
    await interaction.showModal(modal);
    return;
  }
  if (action === 'rename') {
    const modal = new ModalBuilder().setCustomId('topic-rename-submit').setTitle('Renomear tópico');
    const field = new TextInputBuilder().setCustomId('name').setLabel('Novo nome do tópico').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(thread.name.slice(0, 100));
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
    await interaction.showModal(modal);
    return;
  }
  if (action === 'summary') {
    await interaction.deferReply({ ephemeral: true });
    const messages = await thread.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) {
      await interaction.editReply('Não consegui ler as mensagens deste tópico. Confira se o bot tem acesso ao histórico.');
      return;
    }
    const ordered = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const requests = ordered.filter((message) => !message.author.bot && message.content.trim()).slice(-8).map((message) => `• ${message.content.replace(/\s+/g, ' ').slice(0, 230)}`);
    const outcomes = ordered.filter((message) => message.author.bot && (message.content.trim() || message.embeds.length)).slice(-5).map((message) => {
      const text = [message.content, ...message.embeds.map((embed) => `${embed.title ?? ''} ${embed.description ?? ''}`)].join(' ').replace(/\s+/g, ' ').trim();
      return text ? `• ${text.slice(0, 230)}` : '';
    }).filter(Boolean);
    const summary = [`**Pedidos**\n${requests.join('\n') || '• Nenhum pedido de texto encontrado.'}`, `**Respostas e andamento**\n${outcomes.join('\n') || '• Ainda sem resposta registrada.'}`].join('\n\n').slice(0, 1700);
    await sendTopicMessage(thread, `**Resumo do tópico**\n${summary}`);
    await interaction.editReply('Resumo publicado neste tópico.');
    return;
  }
  await interaction.reply({ content: 'Encerrando o tópico. O histórico continuará salvo no Discord.', ephemeral: true });
  await thread.setArchived(true, `Tópico encerrado por ${interaction.user.tag}`).catch(async (error) => {
    console.error(`Could not archive request thread ${thread.id}:`, safeError(error));
    await interaction.followUp({ content: 'Não consegui encerrar o tópico por falta de permissão. Ele continua salvo e pode ser arquivado manualmente.', ephemeral: true }).catch(() => null);
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'bot-configurar') {
        await beginSetup(interaction);
        return;
      }
      if (interaction.commandName === 'bot-autorizar' || interaction.commandName === 'bot-revogar') {
        await handleAccessCommand(interaction);
        return;
      }
      if (interaction.commandName === 'bot-status') {
        await handleBotStatus(interaction);
        return;
      }
      if (interaction.commandName === 'bot-chave-remover') {
        if (!interaction.guild || !await memberCanUse(interaction.guild, interaction.user.id)) {
          await interaction.reply({ content: 'Você não está autorizado neste servidor.', ephemeral: true });
          return;
        }
        await deleteUserKey(interaction.user.id);
        await interaction.reply({ content: 'Sua chave pessoal foi removida. Os próximos pedidos usarão a chave central e respeitarão os limites configurados.', ephemeral: true });
        return;
      }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'service-config-modal') {
      await finishSetupModal(interaction);
      return;
    }
    if (interaction.isModalSubmit() && (interaction.customId === 'topic-edit-submit' || interaction.customId === 'topic-rename-submit')) {
      const thread = interaction.channel;
      if (!interaction.guild || !thread?.isThread() || thread.parentId !== await getControlChannel(interaction.guild.id) || !await memberCanUse(interaction.guild, interaction.user.id)) {
        await interaction.reply({ content: 'Você não está autorizado a editar este tópico.', ephemeral: true });
        return;
      }
      if (interaction.customId === 'topic-rename-submit') {
        const name = interaction.fields.getTextInputValue('name').trim();
        if (!name) {
          await interaction.reply({ content: 'Informe um nome para o tópico.', ephemeral: true });
          return;
        }
        await thread.setName(name.slice(0, 100), `Renomeado por ${interaction.user.tag}`);
        await interaction.reply({ content: `Tópico renomeado para **${name.slice(0, 100)}**.`, ephemeral: true });
        return;
      }
      const request = interaction.fields.getTextInputValue('request').trim();
      if (!request) {
        await interaction.reply({ content: 'O pedido não pode ficar vazio.', ephemeral: true });
        return;
      }
      const messages = await thread.messages.fetch({ limit: 50 }).catch(() => null);
      const original = messages?.filter((message) => !message.author.bot && message.content.trim()).sort((a, b) => b.createdTimestamp - a.createdTimestamp).first();
      if (!original) {
        await interaction.reply({ content: 'Não encontrei uma mensagem de pedido para editar. Envie o pedido novamente no tópico.', ephemeral: true });
        return;
      }
      await interaction.reply({ content: 'Pedido atualizado. Vou analisar a nova descrição agora.', ephemeral: true });
      await processRequest(original, request, interaction.user.id);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'service-model-select') {
      await selectServiceModel(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('topic:')) {
      await handleTopicButton(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('change-undo:')) {
      const changeId = interaction.customId.slice('change-undo:'.length);
      await handleChangeUndoButton(interaction, changeId);
      return;
    }
    if (interaction.isButton() && (interaction.customId.startsWith('change-confirm:') || interaction.customId.startsWith('change-cancel:'))) {
      await handleChangeButton(interaction);
    }
  } catch (error) {
    console.error('Interaction failed:', safeError(error));
    const response = { content: 'Não consegui concluir essa ação. Confira as permissões e tente novamente.', ephemeral: true } as const;
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => null);
      else await interaction.reply(response).catch(() => null);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  try {
    const controlChannelId = await getControlChannel(message.guild.id);
    const isControlThread = message.channel.isThread() && message.channel.parentId === controlChannelId;
    if (message.channelId !== controlChannelId && !isControlThread) return;
    const keyMatch = message.content.match(/sk-or-v1-[A-Za-z0-9_-]{20,}/);
    if (keyMatch) {
      if (await memberCanUse(message.guild, message.author.id)) await handleKeyMessage(message, keyMatch[0]);
      else {
        await message.delete().catch(() => null);
        await message.author.send('Apaguei a mensagem que parecia conter uma chave. Você precisa ser autorizado por um administrador antes de cadastrar uma chave pessoal.').catch(() => null);
      }
      return;
    }
    await processRequest(message);
  } catch (error) {
    console.error(`Message handling failed in guild ${message.guild.id}:`, safeError(error));
    await message.reply('Não consegui processar esse pedido. Tente novamente ou peça ao administrador para conferir a configuração.').catch(() => null);
  }
});

export async function startBot(): Promise<void> {
  await pool.query('SELECT 1');
  await client.login(env.discordBotToken());
}

export async function stopBot(): Promise<void> {
  client.destroy();
  await pool.end();
}
