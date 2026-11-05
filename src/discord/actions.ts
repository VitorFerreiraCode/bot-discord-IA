import {
  ChannelType,
  EmbedBuilder,
  GatewayIntentBits,
  GuildOnboardingMode,
  PermissionFlagsBits,
  type Guild,
  type GuildOnboardingPromptData,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type PermissionOverwriteOptions,
  type Role,
  type TextChannel,
} from 'discord.js';
import type { ChannelPermissionChanges, ChannelPermissionName, DiscordAction, MessageEmbedInput } from '../ai/actions.js';
import { containsMassMention, isProtectedRole } from '../security/discord-rules.js';
import { applyWithRollback, PartialApplyError } from './transaction.js';

interface PermissionOverwriteState {
  allow: { has(permission: bigint): boolean };
  deny: { has(permission: bigint): boolean };
}

export function describeAction(guild: Guild, action: DiscordAction): string {
  if (action.type === 'configure_onboarding_question') return `• Configurar a pergunta **${action.title}** com ${action.options.length} opção(ões); onboarding ${action.enabled ? 'ativado' : 'desativado'}. Perguntas e opções existentes serão preservadas. Motivo: ${action.reason}`;
  if (action.type === 'edit_channel') return `• Editar <#${action.channelId}>: ${Object.entries(action.changes).map(([key, value]) => `${key} → ${String(value)}`).join(', ')}. Motivo: ${action.reason}`;
  if (action.type === 'edit_role') return `• Editar <@&${action.roleId}>: ${Object.keys(action.changes).join(', ')}. Motivo: ${action.reason}`;
  if (action.type === 'set_member_role') return `• ${action.assigned ? 'Atribuir' : 'Remover'} o cargo <@&${action.roleId}> ${action.assigned ? 'a' : 'de'} <@${action.memberId}>. Motivo: ${action.reason}`;
  if (action.type === 'delete_channel') return `• Excluir <#${action.channelId}>${guild.channels.cache.get(action.channelId) && 'name' in guild.channels.cache.get(action.channelId)! ? ` (${(guild.channels.cache.get(action.channelId) as {name:string}).name})` : ''}. Essa ação não pode ser desfeita. Motivo: ${action.reason}`;
  if (action.type === 'edit_welcome_screen') return `• Atualizar a tela de boas-vindas do servidor${action.enabled === undefined ? '' : action.enabled ? ' e ativá-la' : ' e desativá-la'}${action.description ? `: ${action.description}` : ''}. Motivo: ${action.reason}`;
  if (action.type === 'create_role') {
    const permissions = action.permissions.length ? action.permissions.join(', ') : 'sem permissões globais adicionais';
    return `• Criar o cargo **${action.name}** (${permissions}). Motivo: ${action.reason}`;
  }
  if (action.type === 'delete_role') {
    const role = guild.roles.cache.get(action.roleId);
    return `• Excluir o cargo <@&${action.roleId}>${role ? ` (**${role.name}**)` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'recreate_role_for_category') {
    const role = guild.roles.cache.get(action.roleId);
    const category = guild.channels.cache.get(action.categoryId);
    const memberIntentNote = guild.client.options.intents.has(GatewayIntentBits.GuildMembers)
      ? ''
      : ' Antes de confirmar, habilite Server Members Intent no portal e DISCORD_GUILD_MEMBERS_INTENT=true no serviço para preservar os membros.';
    return `• Substituir o cargo **${role?.name ?? action.roleId}**, preservando membros e permissões não administrativas, e conceder visualização/leitura do histórico à categoria <#${action.categoryId}> e aos canais de texto filhos${category && 'name' in category ? ` de **${category.name}**` : ''}. Motivo: ${action.reason}${memberIntentNote}`;
  }
  if (action.type === 'allow_read_history') {
    const channel = guild.channels.cache.get(action.channelId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    return `• Permitir que ${target} leia o histórico de <#${action.channelId}>${channel ? ` (#${channel.name})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'set_channel_permissions') {
    const channel = guild.channels.cache.get(action.channelId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    const changes = Object.entries(action.permissions).map(([permission, enabled]) => `${permission}: ${enabled ? 'permitir' : 'negar'}`).join(', ');
    return `• Ajustar ${changes} para ${target} em <#${action.channelId}>${channel && 'name' in channel ? ` (${channel.name})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'set_category_permissions') {
    const category = guild.channels.cache.get(action.categoryId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    const changes = Object.entries(action.permissions).map(([permission, enabled]) => `${permission}: ${enabled ? 'permitir' : 'negar'}`).join(', ');
    const childScope = Object.keys(action.permissions).every((key) => key === 'ReadMessageHistory')
      ? 'e nos canais de texto filhos'
      : Object.keys(action.permissions).every((key) => key === 'Connect' || key === 'Speak')
        ? 'e nos canais de voz filhos'
        : 'e nos canais filhos compatíveis';
    return `• Ajustar ${changes} para ${target} na categoria **${category && 'name' in category ? category.name : action.categoryId}** ${childScope}. Motivo: ${action.reason}`;
  }
  if (action.type === 'set_voice_mute') {
    return `• ${action.muted ? 'Silenciar' : 'Desmutar'} <@${action.memberId}> no servidor. Motivo: ${action.reason}`;
  }
  if (action.type === 'set_channel_visibility') {
    const channel = guild.channels.cache.get(action.channelId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    return `• ${action.visible ? 'Permitir' : 'Remover'} visualização de ${target} em <#${action.channelId}>${channel ? ` (#${channel.name})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'create_category') return `• Criar categoria **${action.name}**. Motivo: ${action.reason}`;
  if (action.type === 'create_voice_channel') {
    const extras = [action.userLimit ? `limite de ${action.userLimit} pessoa(s)` : '', action.bitrate ? `bitrate ${Math.round(action.bitrate / 1000)} kbps` : ''].filter(Boolean).join(', ');
    return `• Criar canal de voz 🔊 **${action.name}**${action.categoryId ? ` em <#${action.categoryId}>` : ''}${action.privateToRequester ? ' privado para quem pediu e administradores' : ' com as permissões da categoria/servidor'}${extras ? ` (${extras})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'edit_category') {
    const category = guild.channels.cache.get(action.categoryId);
    const changes = [action.changes.name ? `nome → **${action.changes.name}**` : '', action.changes.position !== undefined ? `posição → ${action.changes.position}` : ''].filter(Boolean).join(', ');
    return `• Editar a categoria **${category?.name ?? action.categoryId}**: ${changes}. Motivo: ${action.reason}`;
  }
  if (action.type === 'send_message') {
    const preview = action.content ? `\n  > ${truncate(action.content, 300).replace(/\n/g, '\n  > ')}` : '';
    const embed = action.embed ? `\n  Embed: ${action.embed.title ? `**${truncate(action.embed.title, 100)}** — ` : ''}${truncate(action.embed.description ?? '', 200)}` : '';
    const mentionNote = !action.notifyMentions
      ? ' Menções não notificam ninguém.'
      : containsMassMention(`${action.content ?? ''} ${action.embed?.description ?? ''}`)
        ? ' ⚠️ Vai notificar @everyone/@here (todo o servidor ou quem está online).'
        : ' ⚠️ Menções citadas na mensagem serão notificadas.';
    return `• Enviar mensagem em <#${action.channelId}>.${mentionNote} Motivo: ${action.reason}${preview}${embed}`;
  }
  if (action.type === 'edit_message') {
    const preview = action.content !== undefined ? `\n  Novo texto:\n  > ${truncate(action.content, 300).replace(/\n/g, '\n  > ')}` : '';
    const embed = action.embed === null ? '\n  Embed: remover' : action.embed ? `\n  Novo embed: ${action.embed.title ? `**${truncate(action.embed.title, 100)}** — ` : ''}${truncate(action.embed.description ?? '', 200)}` : '';
    return `• Editar a mensagem ${messageLink(guild, action.channelId, action.messageId)} do bot. Motivo: ${action.reason}${preview}${embed}`;
  }
  if (action.type === 'delete_message') return `• Excluir a mensagem ${messageLink(guild, action.channelId, action.messageId)}. Essa ação não pode ser desfeita. Motivo: ${action.reason}`;
  if (action.type === 'pin_message') return `• ${action.pinned ? 'Fixar' : 'Desafixar'} a mensagem ${messageLink(guild, action.channelId, action.messageId)}. Motivo: ${action.reason}`;
  return `• Criar canal #${action.name}${action.categoryId ? ` em <#${action.categoryId}>` : ''}${action.privateToRequester ? ' privado para quem pediu' : ' com as permissões padrão do servidor'}. Motivo: ${action.reason}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function messageLink(guild: Guild, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guild.id}/${channelId}/${messageId}`;
}

async function fetchTargetMessage(guild: Guild, channelId: string, messageId: string): Promise<Message> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('MESSAGE_CHANNEL_NOT_FOUND');
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) throw new Error('MESSAGE_NOT_FOUND');
  return message;
}

function buildEmbed(embed: MessageEmbedInput): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  return builder;
}

/** Confere no canal alvo as permissões que o bot precisa para a ação de mensagem. */
function assertBotChannelPermissions(guild: Guild, channel: GuildBasedChannel, required: Array<[bigint, string]>): void {
  const permissions = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
  const missing = required.filter(([flag]) => !permissions?.has(flag)).map(([, code]) => code);
  if (missing.length) throw new Error(`BOT_MISSING_CHANNEL_PERMISSIONS:${missing.join(',')}`);
}

function permissionValue(overwrite: PermissionOverwriteState | undefined, permission: ChannelPermissionName): boolean | null {
  if (!overwrite) return null;
  const bit = PermissionFlagsBits[permission];
  if (overwrite.allow.has(bit)) return true;
  if (overwrite.deny.has(bit)) return false;
  return null;
}

function countCachedMemberDenies(guild: Guild, channel: { permissionOverwrites: { cache: Map<string, PermissionOverwriteState & { id?: string; type?: number }> } }, roleId: string, permissions: ChannelPermissionChanges): number {
  const role = guild.roles.cache.get(roleId);
  if (!role) return 0;
  const deniedMembers = new Set<string>();
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (overwrite.type !== 1 || !role.members.has(overwrite.id ?? '')) continue;
    if (Object.entries(permissions).some(([name, value]) => value === true && overwrite.deny.has(PermissionFlagsBits[name as ChannelPermissionName]))) {
      deniedMembers.add(overwrite.id ?? '');
    }
  }
  return deniedMembers.size;
}

export async function describeActionImpact(guild: Guild, action: DiscordAction): Promise<string> {
  const base = describeAction(guild, action);
  if (action.type === 'edit_message' || action.type === 'delete_message' || action.type === 'pin_message') {
    const target = await fetchTargetMessage(guild, action.channelId, action.messageId).catch(() => null);
    if (!target) return `${base}\n  Atenção: não encontrei essa mensagem; a execução vai falhar se ela não existir.`;
    const author = target.author.id === guild.client.user.id ? 'este bot' : `<@${target.author.id}>`;
    const current = target.content ? truncate(target.content, 300).replace(/\n/g, '\n  > ') : '(sem texto; só embed/anexo)';
    const authorNote = action.type === 'edit_message' && target.author.id !== guild.client.user.id ? '\n  Atenção: o Discord só permite editar mensagens escritas pelo próprio bot; essa ação vai falhar.' : '';
    const pinNote = action.type === 'pin_message' && target.pinned === action.pinned ? `\n  Observação: a mensagem já está ${action.pinned ? 'fixada' : 'desafixada'}.` : '';
    return `${base}\n  Mensagem atual (autor: ${author}):\n  > ${current}${authorNote}${pinNote}`;
  }
  if (action.type === 'set_voice_mute') {
    const member = await guild.members.fetch(action.memberId).catch(() => null);
    const current = !member ? 'não foi possível consultar' : !member.voice.channelId ? 'membro não está conectado a um canal de voz' : member.voice.serverMute ? 'ativo' : 'inativo';
    return `${base}\n  Estado atual do server mute: ${current} → ${action.muted ? 'ativo' : 'inativo'}.`;
  }
  if (action.type === 'set_channel_permissions' || action.type === 'set_channel_visibility' || action.type === 'allow_read_history') {
    const channelId = action.channelId;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !('permissionOverwrites' in channel)) return `${base}\n  Impacto: não consegui consultar o estado atual.`;
    const target = action.targetType === 'role'
      ? await guild.roles.fetch(action.targetId).catch(() => null)
      : await guild.members.fetch(action.targetId).catch(() => null);
    if (!target) return `${base}\n  Impacto: não consegui consultar o alvo.`;
    const permissions: ChannelPermissionChanges = action.type === 'set_channel_permissions'
      ? action.permissions
      : action.type === 'set_channel_visibility'
        ? { ViewChannel: action.visible }
        : { ReadMessageHistory: true };
    const overwrite = channel.permissionOverwrites.cache.get(action.targetId);
    const effective = channel.permissionsFor(target);
    const details = Object.entries(permissions).map(([name, after]) => {
      const permission = name as ChannelPermissionName;
      const explicitBefore = permissionValue(overwrite, permission);
      const effectiveBefore = effective?.has(PermissionFlagsBits[permission]) ?? false;
      return `    ${permission}: efetiva ${effectiveBefore ? 'permitida' : 'negada'}; overwrite ${explicitBefore === null ? 'herdado/neutro' : explicitBefore ? 'permitir' : 'negar'} → ${after ? 'permitir' : 'negar'}`;
    });
    let voiceNote = '';
    if (Object.keys(permissions).some((permission) => permission === 'Speak')) {
      if (action.targetType === 'member' && 'voice' in target) {
        if (target.voice.serverMute) voiceNote += '\n  Observação: a pessoa está com server mute; permitir Speak não remove esse silenciamento de moderação.';
        if (target.voice.selfMute) voiceNote += '\n  Observação: a pessoa está em self mute; só ela pode desativá-lo no cliente Discord.';
      } else if (action.targetType === 'role') {
        const serverMuted = [...guild.voiceStates.cache.values()].filter((state) => state.serverMute && state.member?.roles.cache.has(action.targetId)).length;
        if (serverMuted) voiceNote += `\n  Observação: ${serverMuted} membro(s) em cache desse cargo estão com server mute; permitir Speak não os desmuta.`;
      }
    }
    const memberDenyCount = action.targetType === 'role' ? countCachedMemberDenies(guild, channel, action.targetId, permissions) : 0;
    const overwriteNote = memberDenyCount ? `\n  Atenção: ${memberDenyCount} membro(s) em cache desse cargo têm negação individual; a permissão do cargo pode não bastar para eles.` : '';
    return `${base}\n  Impacto antes/depois:\n${details.join('\n')}${overwriteNote}${voiceNote}`;
  }
  if (action.type === 'set_category_permissions') {
    const category = await guild.channels.fetch(action.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) return `${base}\n  Impacto: não consegui consultar os canais filhos.`;
    const target = action.targetType === 'role'
      ? await guild.roles.fetch(action.targetId).catch(() => null)
      : await guild.members.fetch(action.targetId).catch(() => null);
    if (!target) return `${base}\n  Impacto: não consegui consultar o alvo.`;
    const fetched = await guild.channels.fetch();
    const allChannels = [...(fetched?.values() ?? [])].filter((channel): channel is NonNullable<typeof channel> => channel !== null);
    const keys = Object.keys(action.permissions);
    const children = allChannels.filter((channel) => {
      if (channel.parentId !== category.id || !('permissionOverwrites' in channel)) return false;
      if (keys.length && keys.every((key) => key === 'ReadMessageHistory')) {
        return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type);
      }
      if (keys.length && keys.every((key) => key === 'Connect' || key === 'Speak')) {
        return [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type);
      }
      return true;
    });
    const changed = children.filter((channel) => Object.entries(action.permissions).some(([name, value]) => permissionValue(channel.permissionOverwrites.cache.get(action.targetId), name as ChannelPermissionName) !== value));
    const memberDenyCount = action.targetType === 'role'
      ? children.reduce((count, channel) => count + countCachedMemberDenies(guild, channel, action.targetId, action.permissions), 0)
      : 0;
    const labels = changed.slice(0, 12).map((channel) => `#${channel.name}`);
    const extra = changed.length > labels.length ? ` e mais ${changed.length - labels.length}` : '';
    const categoryOverwrite = category.permissionOverwrites.cache.get(action.targetId);
    const categoryEffective = category.permissionsFor(target);
    const details = Object.entries(action.permissions).map(([name, value]) => {
      const permission = name as ChannelPermissionName;
      const previous = permissionValue(categoryOverwrite, permission);
      const effective = categoryEffective?.has(PermissionFlagsBits[permission]) ?? false;
      const explicit = previous === null ? 'neutro/herdado' : previous ? 'permitir' : 'negar';
      return `    ${name}: efetiva ${effective ? 'permitida' : 'negada'}; overwrite ${explicit} → ${value ? 'permitir' : 'negar'}`;
    }).join('\n');
    const memberNote = memberDenyCount ? `\n  Atenção: há ${memberDenyCount} negação(ões) individuais em membros em cache; confirme esses membros separadamente se continuarem sem acesso.` : '';
    return `${base}\n  Impacto: ${changed.length} dos ${children.length} canais filhos terão o overwrite alterado (${labels.join(', ')}${extra}).\n  Antes/depois na categoria:\n${details}${memberNote}`;
  }
  if (action.type === 'recreate_role_for_category') {
    const role = await guild.roles.fetch(action.roleId).catch(() => null);
    let count = role?.members.size ?? 0;
    let exact = false;
    if (role && guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) {
      const members = await guild.members.fetch().catch(() => null);
      if (members) { count = [...members.values()].filter((member) => member.roles.cache.has(role.id)).length; exact = true; }
    }
    return `${base}\n  Impacto: migrará ${count} membro(s)${exact ? '' : ' atualmente em cache; contagem pode estar incompleta'}. Não há reversão automática para a exclusão do cargo antigo.`;
  }
  if (action.type === 'delete_role') {
    const role = await guild.roles.fetch(action.roleId).catch(() => null);
    return `${base}\n  Impacto: afetará ${role?.members.size ?? 'um número não consultado de'} membro(s). A exclusão não tem reversão automática.`;
  }
  return isActionUndoable(action) ? base : `${base}\n  Impacto: esta ação não tem reversão automática.`;
}

type UndoableDiscordAction = Extract<DiscordAction, { type: 'set_channel_visibility' | 'allow_read_history' | 'set_channel_permissions' | 'set_category_permissions' | 'set_voice_mute' }>;

export function isActionUndoable(action: DiscordAction): action is UndoableDiscordAction {
  return ['set_channel_visibility', 'allow_read_history', 'set_channel_permissions', 'set_category_permissions', 'set_voice_mute'].includes(action.type);
}

function permissionFieldsForAction(action: Exclude<UndoableDiscordAction, { type: 'set_voice_mute' }>): ChannelPermissionChanges {
  if (action.type === 'set_channel_visibility') return { ViewChannel: action.visible };
  if (action.type === 'allow_read_history') return { ReadMessageHistory: true };
  return action.permissions;
}

function channelsForCategoryAction<T extends { parentId: string | null; type: number }>(action: Extract<DiscordAction, { type: 'set_category_permissions' }>, channels: T[]): T[] {
  const keys = Object.keys(action.permissions);
  return channels.filter((channel) => {
    if (channel.parentId !== action.categoryId) return false;
    if (keys.length && keys.every((key) => key === 'ReadMessageHistory')) {
      return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type);
    }
    if (keys.length && keys.every((key) => key === 'Connect' || key === 'Speak')) {
      return [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type);
    }
    return true;
  });
}

export async function captureActionUndoState(guild: Guild, action: DiscordAction): Promise<unknown | null> {
  if (!isActionUndoable(action)) return null;
  if (action.type === 'set_voice_mute') {
    const member = await guild.members.fetch(action.memberId);
    return { muted: member.voice.serverMute, appliedMuted: action.muted };
  }
  const permissions = permissionFieldsForAction(action);
  const targetId = action.targetId;
  const targets: Array<{ channelId: string; permissions: ChannelPermissionChanges; applied: ChannelPermissionChanges }> = [];
  if (action.type === 'set_category_permissions') {
    const category = await guild.channels.fetch(action.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_NOT_FOUND');
    const fetched = await guild.channels.fetch();
    const channels = [...(fetched?.values() ?? [])].filter((channel): channel is NonNullable<typeof channel> => channel !== null);
    const children = channelsForCategoryAction(action, channels);
    targets.push({ channelId: category.id, permissions: {}, applied: { ...permissions } });
    for (const channel of children) targets.push({ channelId: channel.id, permissions: {}, applied: { ...permissions } });
  } else {
    targets.push({ channelId: action.channelId, permissions: {}, applied: { ...permissions } });
  }
  for (const target of targets) {
    const channel = await guild.channels.fetch(target.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    const overwrite = channel.permissionOverwrites.cache.get(targetId);
    target.permissions = Object.fromEntries(Object.keys(permissions).map((permission) => [permission, permissionValue(overwrite, permission as ChannelPermissionName)])) as ChannelPermissionChanges;
  }
  return { targetId, targetType: action.targetType, targets };
}

export async function revertDiscordAction(guild: Guild, action: DiscordAction, state: unknown): Promise<string> {
  const botMember = guild.members.me;
  if (!botMember) throw new Error('BOT_MEMBER_NOT_CACHED');
  if (action.type === 'set_voice_mute') {
    if (!botMember.permissions.has(PermissionFlagsBits.MuteMembers)) throw new Error('BOT_MISSING_MUTE_MEMBERS');
    const member = await guild.members.fetch(action.memberId);
    const snapshot = state as { muted?: unknown; appliedMuted?: unknown };
    if (typeof snapshot.muted !== 'boolean' || typeof snapshot.appliedMuted !== 'boolean') throw new Error('INVALID_UNDO_SNAPSHOT');
    if (member.voice.serverMute !== snapshot.appliedMuted) throw new Error('UNDO_CONFLICT');
    await member.voice.setMute(snapshot.muted, 'Reverter alteração aprovada pelo Bot Discord IA');
    return `Restaurei o estado anterior de server mute para <@${member.id}>.`;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('BOT_MISSING_PERMISSION_FOR_UNDO');
  const snapshot = state as { targetId?: unknown; targetType?: unknown; targets?: Array<{ channelId?: unknown; permissions?: unknown; applied?: unknown }> };
  if (typeof snapshot.targetId !== 'string' || (snapshot.targetType !== 'role' && snapshot.targetType !== 'member') || !Array.isArray(snapshot.targets)) throw new Error('INVALID_UNDO_SNAPSHOT');
  if (snapshot.targetType === 'role') {
    const role = await guild.roles.fetch(snapshot.targetId);
    if (!role?.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
  } else {
    await guild.members.fetch(snapshot.targetId);
  }
  const targets = [...snapshot.targets].reverse();
  const resolved: Array<{ channelId: string; before: PermissionOverwriteOptions }> = [];
  for (const target of targets) {
    if (typeof target.channelId !== 'string' || !target.permissions || typeof target.permissions !== 'object' || !target.applied || typeof target.applied !== 'object') throw new Error('INVALID_UNDO_SNAPSHOT');
    const channel = await guild.channels.fetch(target.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('UNDO_CHANNEL_NOT_FOUND');
    const overwrite = channel.permissionOverwrites.cache.get(snapshot.targetId);
    for (const [name, appliedValue] of Object.entries(target.applied as Record<string, unknown>)) {
      if (typeof appliedValue !== 'boolean' || permissionValue(overwrite, name as ChannelPermissionName) !== appliedValue) throw new Error('UNDO_CONFLICT');
    }
    resolved.push({ channelId: target.channelId, before: target.permissions as PermissionOverwriteOptions });
  }
  for (const target of resolved) {
    const channel = await guild.channels.fetch(target.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('UNDO_CHANNEL_NOT_FOUND');
    await channel.permissionOverwrites.edit(snapshot.targetId, target.before, { reason: 'Reverter alteração aprovada pelo Bot Discord IA' });
  }
  const target = snapshot.targetType === 'member' ? `<@${snapshot.targetId}>` : `<@&${snapshot.targetId}>`;
  return `Restaurei os overwrites anteriores para ${target} em ${targets.length} canal(is).`;
}

export async function applyDiscordAction(
  guild: Guild,
  requesterId: string,
  action: DiscordAction,
): Promise<string> {
  const botMember = guild.members.me;
  const roleAction = action.type === 'create_role' || action.type === 'delete_role' || action.type === 'edit_role' || action.type === 'set_member_role';
  const needsManageRoles = roleAction || action.type === 'allow_read_history' || action.type === 'set_channel_permissions' || action.type === 'set_category_permissions' || action.type === 'set_channel_visibility' || action.type === 'recreate_role_for_category'
    || action.type === 'create_text_channel' || action.type === 'create_voice_channel';
  const needsManageChannels = ['allow_read_history', 'set_channel_permissions', 'set_category_permissions', 'set_channel_visibility', 'create_category', 'create_text_channel', 'create_voice_channel', 'edit_category', 'edit_channel', 'delete_channel', 'recreate_role_for_category'].includes(action.type);
  if (!botMember) throw new Error('BOT_MEMBER_NOT_CACHED');
  if (needsManageRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
  if (needsManageChannels && !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('BOT_MISSING_MANAGE_CHANNELS');
  if (action.type === 'set_voice_mute' && !botMember.permissions.has(PermissionFlagsBits.MuteMembers)) throw new Error('BOT_MISSING_MUTE_MEMBERS');
  const reason = `Bot Discord IA: ${action.reason}`.slice(0, 500);

  if (action.type === 'configure_onboarding_question') {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('BOT_MISSING_MANAGE_GUILD');
    const onboarding = await guild.fetchOnboarding();
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const prompts = [...onboarding.prompts.values()];
    const matchingPromptIndex = prompts.findIndex((prompt) => normalize(prompt.title) === normalize(action.title));
    if (matchingPromptIndex < 0 && prompts.length >= 5) throw new Error('ONBOARDING_PROMPT_LIMIT');
    const existingPrompt = matchingPromptIndex >= 0 ? prompts[matchingPromptIndex]! : null;
    if (existingPrompt && existingPrompt.options.size + action.options.filter((wanted) => ![...existingPrompt.options.values()].some((option) => normalize(option.title) === normalize(wanted.title))).length > 25) throw new Error('ONBOARDING_OPTION_LIMIT');
    const desiredOptions = action.options.map((option) => {
      const roleIds = option.roleNames.map((name) => {
        const matches = [...guild.roles.cache.values()].filter((role) => normalize(role.name) === normalize(name));
        if (matches.length !== 1 || !matches[0]!.editable) throw new Error(`ONBOARDING_ROLE_NOT_FOUND:${name}`);
        return matches[0]!.id;
      });
      const channelIds = option.channelNames.map((name) => {
        const matches = [...guild.channels.cache.values()].filter((channel) => 'name' in channel && normalize(channel.name) === normalize(name));
        if (matches.length !== 1) throw new Error(`ONBOARDING_CHANNEL_NOT_FOUND:${name}`);
        return matches[0]!.id;
      });
      return { title: option.title, description: option.description, roles: roleIds, channels: channelIds };
    });
    const serializedPrompts: GuildOnboardingPromptData[] = prompts.map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      singleSelect: prompt.singleSelect,
      required: prompt.required,
      inOnboarding: prompt.inOnboarding,
      type: prompt.type,
      options: [...prompt.options.values()].map((option) => ({
        id: option.id, title: option.title, description: option.description ?? undefined,
        roles: [...option.roles.keys()], channels: [...option.channels.keys()], emoji: option.emoji?.toString() ?? undefined,
      })),
    }));
    if (existingPrompt) {
      const promptData = serializedPrompts[matchingPromptIndex]!;
      const options = [...(promptData.options as readonly import('discord.js').GuildOnboardingPromptOptionData[])];
      for (const desired of desiredOptions) {
        const option = options.find((entry) => normalize(entry.title) === normalize(desired.title));
        if (option) {
          (option as { roles?: string[] }).roles = [...new Set([...(option.roles as readonly string[] | undefined ?? []), ...desired.roles])];
          (option as { channels?: string[] }).channels = [...new Set([...(option.channels as readonly string[] | undefined ?? []), ...desired.channels])];
        } else options.push({ title: desired.title, description: desired.description, roles: desired.roles, channels: desired.channels });
      }
      promptData.options = options;
      promptData.required = action.required;
      promptData.singleSelect = action.singleSelect;
      promptData.inOnboarding = true;
    } else {
      serializedPrompts.push({ title: action.title, singleSelect: action.singleSelect, required: action.required, inOnboarding: true, options: [
        ...desiredOptions.map((option) => ({ title: option.title, description: option.description, roles: option.roles, channels: option.channels })),
      ] });
    }
    await guild.editOnboarding({ prompts: serializedPrompts, defaultChannels: [...onboarding.defaultChannels.keys()], enabled: action.enabled, mode: GuildOnboardingMode.OnboardingAdvanced, reason });
    return `Atualizei o onboarding: pergunta **${action.title}** com ${action.options.length} opção(ões). As demais perguntas foram preservadas.`;
  }

  if (action.type === 'edit_channel') {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    const { parentId, ...channelChanges } = action.changes;
    await channel.edit({ ...channelChanges, ...(parentId === undefined ? {} : { parent: parentId }), reason });
    return `Atualizei as propriedades de #${channel.name}.`;
  }

  if (action.type === 'edit_role') {
    const role = await guild.roles.fetch(action.roleId);
    if (!role || !role.editable || roleIsProtectedAtRuntime(guild, role)) throw new Error('PROTECTED_ROLE');
    const changes = { ...action.changes, ...(action.changes.permissions ? { permissions: action.changes.permissions.map((permission) => PermissionFlagsBits[permission]) } : {}) };
    await role.edit({ ...changes, reason });
    return `Atualizei o cargo **${role.name}**.`;
  }

  if (action.type === 'set_member_role') {
    const member = await guild.members.fetch(action.memberId);
    const role = await guild.roles.fetch(action.roleId);
    if (!role || !role.editable || roleIsProtectedAtRuntime(guild, role)) throw new Error('PROTECTED_ROLE');
    if (action.assigned) await member.roles.add(role, reason);
    else await member.roles.remove(role, reason);
    return `${action.assigned ? 'Atribuí' : 'Removi'} o cargo **${role.name}** ${action.assigned ? 'de' : 'de'} ${member.displayName}.`;
  }

  if (action.type === 'delete_channel') {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel) throw new Error('INVALID_CHANNEL_DELETION_TARGET');
    const label = channel.name;
    await channel.delete(reason);
    return `Excluí o canal/categoria **${label}**.`;
  }

  if (action.type === 'edit_welcome_screen') {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('BOT_MISSING_MANAGE_GUILD');
    const current = await guild.fetchWelcomeScreen();
    await guild.editWelcomeScreen({
      enabled: action.enabled ?? current.enabled,
      description: action.description ?? current.description ?? undefined,
      welcomeChannels: action.welcomeChannels?.map((entry) => ({ channel: entry.channelId, description: entry.description, emoji: entry.emoji })) ?? [...current.welcomeChannels.values()].flatMap((entry) => entry.channel ? [{ channel: entry.channel.id, description: entry.description, emoji: entry.emoji?.toString() ?? undefined }] : []),
    });
    return 'Atualizei a tela de boas-vindas do servidor.';
  }

  if (action.type === 'create_role') {
    const permissions = action.permissions.map((permission) => PermissionFlagsBits[permission]);
    const role = await guild.roles.create({ name: action.name, permissions, reason });
    return `Criei o cargo <@&${role.id}> sem conceder permissões de administração.`;
  }

  if (action.type === 'delete_role') {
    const role = await guild.roles.fetch(action.roleId);
    if (!role || role.id === guild.roles.everyone.id) throw new Error('ROLE_NOT_FOUND_OR_EVERYONE');
    const owner = await guild.members.fetch(guild.ownerId);
    const protectedRole = isProtectedRole({
      id: role.id,
      everyoneId: guild.roles.everyone.id,
      managed: role.managed,
      administrator: role.permissions.has(PermissionFlagsBits.Administrator),
      manageGuild: role.permissions.has(PermissionFlagsBits.ManageGuild),
      manageRoles: role.permissions.has(PermissionFlagsBits.ManageRoles),
      ownerHasRole: owner.roles.cache.has(role.id),
      name: role.name,
    });
    if (protectedRole) throw new Error('PROTECTED_ROLE');
    if (!role.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    await role.delete(reason);
    return `Excluí o cargo **${role.name}**.`;
  }

  if (action.type === 'set_voice_mute') {
    const member = await guild.members.fetch(action.memberId);
    await member.voice.setMute(action.muted, reason);
    return `${action.muted ? 'Silenciei' : 'Desmutei'} <@${member.id}> no servidor.`;
  }

  if (action.type === 'recreate_role_for_category') {
    if (!guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) throw new Error('BOT_GUILD_MEMBERS_INTENT_REQUIRED');
    const oldRole = await guild.roles.fetch(action.roleId);
    await guild.members.fetch(guild.ownerId);
    const category = await guild.channels.fetch(action.categoryId);
    if (!oldRole || roleIsProtectedAtRuntime(guild, oldRole)) throw new Error('PROTECTED_ROLE');
    if (!oldRole.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_NOT_FOUND');

    // Fetch the full member list before changing anything; without it, deleting the old role could strip access from uncached members.
    const members = await guild.members.fetch();
    const assignedMembers = [...members.values()].filter((member) => member.roles.cache.has(oldRole.id));
    const fetchedChannels = await guild.channels.fetch();
    if (!fetchedChannels) throw new Error('GUILD_CHANNELS_NOT_FETCHED');
    const channels = [...fetchedChannels.values()].filter((channel): channel is NonNullable<typeof channel> => channel !== null);
    const childTextChannels = channels.filter((channel) => channel.parentId === category.id && [
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
      ChannelType.GuildMedia,
    ].includes(channel.type));
    const preservedPermissions = oldRole.permissions.toArray().filter((permission) => !['Administrator', 'ManageGuild', 'ManageRoles'].includes(permission));
    let replacement: Role | null = null;
    let oldRoleDeletionStarted = false;
    const migratedMembers: GuildMember[] = [];
    try {
      replacement = await guild.roles.create({
        name: oldRole.name,
        color: oldRole.color,
        hoist: oldRole.hoist,
        mentionable: oldRole.mentionable,
        permissions: preservedPermissions,
        reason,
      });
      await replacement.setPosition(oldRole.position, { reason });

      const targetChannels = [category, ...childTextChannels];
      for (const channel of targetChannels) {
        const oldOverwrite = channel.permissionOverwrites.cache.get(oldRole.id);
        const overwrite: PermissionOverwriteOptions = { ViewChannel: true, ReadMessageHistory: true };
        for (const permission of oldOverwrite?.allow.toArray() ?? []) {
          if (permission !== 'ViewChannel' && permission !== 'ReadMessageHistory') overwrite[permission as keyof PermissionOverwriteOptions] = true;
        }
        for (const permission of oldOverwrite?.deny.toArray() ?? []) {
          if (permission !== 'ViewChannel' && permission !== 'ReadMessageHistory') overwrite[permission as keyof PermissionOverwriteOptions] = false;
        }
        await channel.permissionOverwrites.edit(replacement.id, overwrite, { reason });
      }

      for (const member of assignedMembers) {
        await member.roles.add(replacement, reason);
        migratedMembers.push(member);
      }
      oldRoleDeletionStarted = true;
      await oldRole.delete(reason);
      return `Recriei o cargo <@&${replacement.id}>, migrei ${migratedMembers.length} membros e configurei acesso e leitura do histórico na categoria e nos ${childTextChannels.length} canais de texto.`;
    } catch (error) {
      if (oldRoleDeletionStarted) {
        const detail = error instanceof Error ? error.message.slice(0, 180) : 'erro desconhecido';
        throw new Error(`ROLE_RECREATE_COMMIT_UNCERTAIN: ${detail}; o cargo novo foi mantido para evitar remover o único cargo ativo. Confira os cargos e membros antes de repetir.`);
      }
      const rollbackErrors: string[] = [];
      if (replacement) {
        const failedReplacement = replacement;
        for (const member of migratedMembers) {
          await member.roles.remove(failedReplacement, 'Reverter substituição incompleta do cargo').catch(() => rollbackErrors.push(`member:${member.id}`));
        }
        await failedReplacement.delete('Reverter substituição incompleta do cargo').catch(() => rollbackErrors.push(`role:${failedReplacement.id}`));
      }
      const detail = error instanceof Error ? error.message.slice(0, 180) : 'erro desconhecido';
      const rollback = rollbackErrors.length ? ` ROLLBACK_INCOMPLETE ${rollbackErrors.slice(0, 8).join(',')}` : ' rollback completed';
      throw new Error(`ROLE_RECREATE_FAILED: ${detail};${rollback}`);
    }
  }

  if (action.type === 'allow_read_history') {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    if (action.targetType === 'member') await guild.members.fetch(action.targetId);
    else {
      const targetRole = await guild.roles.fetch(action.targetId);
      if (!targetRole?.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    }
    await channel.permissionOverwrites.edit(action.targetId, { ReadMessageHistory: true }, { reason });
    return `Permiti a leitura do histórico em #${channel.name}.`;
  }

  if (action.type === 'set_channel_permissions') {
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    if (action.targetType === 'member') await guild.members.fetch(action.targetId);
    else {
      const targetRole = await guild.roles.fetch(action.targetId);
      if (!targetRole?.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    }
    await channel.permissionOverwrites.edit(action.targetId, action.permissions, { reason });
    const changes = Object.entries(action.permissions).map(([permission, enabled]) => `${permission} ${enabled ? 'permitido' : 'negado'}`).join(', ');
    return `Atualizei ${changes} em #${channel.name}.`;
  }

  if (action.type === 'set_category_permissions') {
    const category = await guild.channels.fetch(action.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_NOT_FOUND');
    if (action.targetType === 'member') await guild.members.fetch(action.targetId);
    else {
      const targetRole = await guild.roles.fetch(action.targetId);
      if (!targetRole?.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    }
    const fetchedChannels = await guild.channels.fetch();
    const childChannels = [...(fetchedChannels?.values() ?? [])]
      .filter((channel): channel is NonNullable<typeof channel> => {
        if (!channel || channel.parentId !== category.id || !('permissionOverwrites' in channel)) return false;
        if (action.permissions.ReadMessageHistory !== undefined && Object.keys(action.permissions).every((key) => key === 'ReadMessageHistory')) {
          return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(channel.type);
        }
        if ((action.permissions.Connect !== undefined || action.permissions.Speak !== undefined)
          && Object.keys(action.permissions).every((key) => key === 'Connect' || key === 'Speak')) {
          return [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type);
        }
        return true;
      });
    const changesNeeded = (channel: { permissionOverwrites: { cache: Map<string, PermissionOverwriteState> } }) => Object.entries(action.permissions).some(([name, value]) =>
      permissionValue(channel.permissionOverwrites.cache.get(action.targetId), name as ChannelPermissionName) !== value);
    const targets = [
      ...(changesNeeded(category) ? [category] : []),
      ...childChannels.filter((channel) => changesNeeded(channel)),
    ];
    const previousPermissions = new Map(targets.map((channel) => {
      const existing = channel.permissionOverwrites.cache.get(action.targetId);
      const priorValues = Object.fromEntries(Object.keys(action.permissions).map((permission) => {
        const bit = PermissionFlagsBits[permission as keyof typeof PermissionFlagsBits];
        return [permission, existing?.allow.has(bit) ? true : existing?.deny.has(bit) ? false : null];
      })) as PermissionOverwriteOptions;
      return [channel.id, priorValues];
    }));
    try {
      await applyWithRollback(
        targets,
        async (channel) => { await channel.permissionOverwrites.edit(action.targetId, action.permissions, { reason }); },
        async (channel) => { await channel.permissionOverwrites.edit(action.targetId, previousPermissions.get(channel.id)!, { reason: 'Reverter correção parcial de permissões' }); },
      );
    } catch (error) {
      const partial = error instanceof PartialApplyError ? error : null;
      const sourceError = partial?.originalError ?? error;
      const detail = sourceError instanceof Error ? sourceError.message.slice(0, 160) : 'erro desconhecido';
      const rollbackStatus = partial?.rollbackFailures ? `ROLLBACK_INCOMPLETE ${partial.rollbackFailures} canal(is)` : 'rollback completed';
      throw new Error(`CATEGORY_PERMISSION_UPDATE_FAILED: ${detail}; ${rollbackStatus}`);
    }
    const changes = Object.entries(action.permissions).map(([permission, enabled]) => `${permission} ${enabled ? 'permitido' : 'negado'}`).join(', ');
    return `Atualizei ${changes} na categoria ${category.name} e em ${childChannels.length} canais filhos.`;
  }

  if (action.type === 'set_channel_visibility') {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    if (action.targetType === 'member') await guild.members.fetch(action.targetId);
    else await guild.roles.fetch(action.targetId);
    await channel.permissionOverwrites.edit(action.targetId, { ViewChannel: action.visible }, { reason });
    return `Atualizei a permissão de visualização em #${channel.name}.`;
  }

  if (action.type === 'edit_category') {
    const category = await guild.channels.fetch(action.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_NOT_FOUND');
    const previousName = category.name;
    await category.edit({ ...action.changes, reason });
    return `Atualizei a categoria **${previousName}**${action.changes.name ? ` (agora **${action.changes.name}**)` : ''}.`;
  }

  if (action.type === 'send_message') {
    const channel = await guild.channels.fetch(action.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('send' in channel)) throw new Error('MESSAGE_CHANNEL_NOT_FOUND');
    assertBotChannelPermissions(guild, channel, [
      [PermissionFlagsBits.ViewChannel, 'ViewChannel'],
      [channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages, channel.isThread() ? 'SendMessagesInThreads' : 'SendMessages'],
      ...(action.embed ? [[PermissionFlagsBits.EmbedLinks, 'EmbedLinks'] as [bigint, string]] : []),
    ]);
    const sent = await channel.send({
      ...(action.content ? { content: action.content } : {}),
      ...(action.embed ? { embeds: [buildEmbed(action.embed)] } : {}),
      allowedMentions: action.notifyMentions ? { parse: ['users', 'roles', 'everyone'] } : { parse: [] },
    });
    return `Enviei a mensagem em <#${channel.id}>: ${sent.url}`;
  }

  if (action.type === 'edit_message') {
    const target = await fetchTargetMessage(guild, action.channelId, action.messageId);
    if (target.author.id !== guild.client.user.id) throw new Error('CAN_ONLY_EDIT_OWN_MESSAGES');
    await target.edit({
      ...(action.content === undefined ? {} : { content: action.content }),
      ...(action.embed === undefined ? {} : { embeds: action.embed ? [buildEmbed(action.embed)] : [] }),
      allowedMentions: { parse: [] },
    });
    return `Editei a mensagem ${target.url}.`;
  }

  if (action.type === 'delete_message') {
    const target = await fetchTargetMessage(guild, action.channelId, action.messageId);
    if (target.author.id !== guild.client.user.id) {
      assertBotChannelPermissions(guild, target.channel as GuildBasedChannel, [[PermissionFlagsBits.ManageMessages, 'ManageMessages']]);
    }
    await target.delete();
    return `Excluí a mensagem de ${target.author.id === guild.client.user.id ? 'este bot' : `<@${target.author.id}>`} em <#${target.channelId}>.`;
  }

  if (action.type === 'pin_message') {
    const target = await fetchTargetMessage(guild, action.channelId, action.messageId);
    assertBotChannelPermissions(guild, target.channel as GuildBasedChannel, [[PermissionFlagsBits.PinMessages, 'PinMessages']]);
    if (target.pinned === action.pinned) return `A mensagem já estava ${action.pinned ? 'fixada' : 'desafixada'}: ${target.url}`;
    if (action.pinned) await target.pin(reason);
    else await target.unpin(reason);
    return `${action.pinned ? 'Fixei' : 'Desafixei'} a mensagem ${target.url}.`;
  }

  if (action.type === 'create_category') {
    const created = await guild.channels.create({
      name: action.name,
      type: ChannelType.GuildCategory,
      reason,
    });
    return `Criei a categoria ${created.name}.`;
  }

  const isVoice = action.type === 'create_voice_channel';
  const memberAccess = isVoice
    ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  const parent = action.categoryId ? await guild.channels.fetch(action.categoryId) : null;
  if (parent && parent.type !== ChannelType.GuildCategory) throw new Error('CATEGORY_NOT_FOUND');
  const syncedOverwrites = parent && 'permissionOverwrites' in parent
    ? parent.permissionOverwrites.cache.map((overwrite) => ({ id: overwrite.id, allow: overwrite.allow, deny: overwrite.deny, type: overwrite.type }))
    : undefined;
  const overwrites = action.privateToRequester
    ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...[...guild.roles.cache.values()]
          .filter((role) => role.id !== guild.roles.everyone.id && role.id !== botMember.id)
          .map((role) => role.permissions.has(PermissionFlagsBits.ManageGuild)
            ? { id: role.id, allow: memberAccess }
            : { id: role.id, deny: [PermissionFlagsBits.ViewChannel] }),
        { id: requesterId, allow: memberAccess },
        { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, ...(isVoice ? [PermissionFlagsBits.Connect] : [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])] },
      ]
    : syncedOverwrites;
  const created = isVoice
    ? await guild.channels.create({
        name: action.name,
        type: ChannelType.GuildVoice,
        parent: parent?.id,
        permissionOverwrites: overwrites,
        ...(action.userLimit === undefined ? {} : { userLimit: action.userLimit }),
        ...(action.bitrate === undefined ? {} : { bitrate: Math.min(action.bitrate, guild.maximumBitrate) }),
        reason,
      })
    : await guild.channels.create({
        name: action.name,
        type: ChannelType.GuildText,
        parent: parent?.id,
        permissionOverwrites: overwrites,
        reason,
      });
  return `Criei o canal ${isVoice ? 'de voz ' : ''}<#${created.id}>.`;
}

function roleIsProtectedAtRuntime(guild: Guild, role: Role): boolean {
  return isProtectedRole({
    id: role.id,
    everyoneId: guild.roles.everyone.id,
    managed: role.managed,
    administrator: role.permissions.has(PermissionFlagsBits.Administrator),
    manageGuild: role.permissions.has(PermissionFlagsBits.ManageGuild),
    manageRoles: role.permissions.has(PermissionFlagsBits.ManageRoles),
    ownerHasRole: guild.members.cache.get(guild.ownerId)?.roles.cache.has(role.id) === true,
    name: role.name,
  });
}

export function controlTextChannel(channel: unknown): channel is TextChannel {
  return typeof channel === 'object' && channel !== null && 'send' in channel && 'permissionOverwrites' in channel;
}
