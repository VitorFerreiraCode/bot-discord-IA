import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
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
  recordUsageTokens,
  reserveUsage,
  revokeUser,
  setPendingChangeStatus,
  storeUserKey,
} from '../db/queries.js';
import { decryptSecret, encryptSecret } from '../security/key-crypto.js';
import { applyDiscordAction, describeAction } from './actions.js';
import { ensureControlChannel } from './control-channel.js';
import { beginSetup, finishSetupModal, selectServiceModel } from './setup-flow.js';
import { commands } from './commands.js';

const commandRest = new REST({ version: '10' }).setToken(env.discordBotToken());

async function deployGuildCommands(guildId: string): Promise<void> {
  await commandRest.put(Routes.applicationGuildCommands(env.discordClientId(), guildId), { body: commands });
  console.log(`Registered ${commands.length} slash commands in guild ${guildId}.`);
}

export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

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

function topicChoiceRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('topic:save').setLabel('Salvar tópico').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('topic:close').setLabel('Encerrar tópico').setStyle(ButtonStyle.Danger),
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
      const content = [entry.content, embedText].filter(Boolean).join('\n').slice(0, 1200);
      return `${entry.author.bot ? 'Bot' : entry.author.username}: ${content}`;
    });
  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter?.content.trim() && !entries.some((entry) => entry.includes(starter.content.slice(0, 80)))) {
    entries.unshift(`${starter.author.username}: ${starter.content.slice(0, 900)}`);
  }
  return entries.slice(-20).join('\n').slice(-8000) || undefined;
}

async function processRequest(message: Message): Promise<void> {
  if (!message.guild) return;
  if (!await memberCanUse(message.guild, message.author.id)) return;
  const controlChannelId = await getControlChannel(message.guild.id);
  const isControlThread = message.channel.isThread() && message.channel.parentId === controlChannelId;
  if (message.channelId !== controlChannelId && !isControlThread) return;
  const requestText = message.content.trim();
  if (!requestText) return;
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
  const encryptedKey = await getUserKey(message.author.id);
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
    usageId = await reserveUsage(message.guild.id, message.author.id, source, config.modelId, config);
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
  try {
    progressMessage = await responseChannel.send('⏳ Recebi seu pedido. A IA está analisando; atualizarei esta mensagem com o resultado.');
    await responseChannel.sendTyping();
    const history = await getThreadHistory(message);
    const result = await planDiscordRequest({ message, apiKey, model: config.modelId, maxOutputTokens: config.maxOutputTokens, history });
    await recordUsageTokens(usageId, result.inputTokens, result.outputTokens);
    const guildUsage = source === 'central' ? await getGuildMonthlyCentralUsage(message.guild.id).catch(() => null) : null;
    const usageDescription = guildUsage === null ? '' : `\n\nUso da chave central neste servidor neste mês: **${guildUsage}/${config.guildMonthlyLimit} pedidos**.`;
    if (!result.plan) {
      const topicRows = responseChannel.isThread() ? topicChoiceRows() : [];
      await progressMessage.edit({ content: `${result.text.slice(0, 1600)}${usageDescription}${topicClosingQuestion}`.slice(0, 2000), embeds: [], components: topicRows, allowedMentions: { parse: [] } });
      return;
    }

    const actions = result.plan.actions;
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    await createPendingChange({
      id,
      guildId: message.guild.id,
      channelId: responseChannel.id,
      requestedBy: message.author.id,
      summary: result.plan.summary,
      actions,
      expiresAt,
    });
    const actionDescription = actions.map((action) => describeAction(message.guild!, action)).join('\n').slice(0, 2600);
    const embed = new EmbedBuilder()
      .setTitle('Diagnóstico e proposta de alteração')
      .setDescription(`${result.plan.summary.slice(0, 750)}\n\n**Correções propostas**\n${actionDescription}\n\nPosso implementar após sua confirmação.${usageDescription}${topicClosingQuestion}`.slice(0, 4000))
      .setFooter({ text: 'Nada será alterado sem confirmação. Esta proposta expira em 5 minutos.' });
    await progressMessage.edit({
      content: null,
      embeds: [embed],
      components: [...actionRows(id), ...(responseChannel.isThread() ? topicChoiceRows() : [])],
      allowedMentions: { parse: [], users: [], roles: [] },
    });
  } catch (error) {
    console.error(`AI request failed for guild ${message.guild.id}:`, safeError(error));
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
  const completed: string[] = [];
  for (const action of actions) {
    try {
      completed.push(await applyDiscordAction(interaction.guild, change.requestedBy, action));
    } catch (error) {
      await setPendingChangeStatus(id, 'failed');
      console.error(`Approved Discord action failed in guild ${interaction.guild.id}:`, safeError(error));
      const progress = completed.length ? ` Ações aplicadas antes da falha: ${completed.join(' ')}` : '';
      const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
      await interaction.editReply({ content: `Não consegui concluir todas as ações. Já aplicadas: ${completed.length}/${actions.length}.${progress} Confira as permissões e a hierarquia do cargo do bot.${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components: topicRows });
      return;
    }
  }
  await setPendingChangeStatus(id, 'completed');
  const topicRows = interaction.channel?.isThread() ? topicChoiceRows() : [];
  await interaction.editReply({ content: `Concluído. ${completed.join(' ')}${interaction.channel?.isThread() ? topicClosingQuestion : ''}`, embeds: [], components: topicRows });
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
    if (interaction.isStringSelectMenu() && interaction.customId === 'service-model-select') {
      await selectServiceModel(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('topic:')) {
      await handleTopicButton(interaction);
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
