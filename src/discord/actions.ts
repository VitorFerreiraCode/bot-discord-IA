import {
  ChannelType,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type PermissionOverwriteOptions,
  type Role,
  type TextChannel,
} from 'discord.js';
import type { ChannelPermissionChanges, ChannelPermissionName, DiscordAction } from '../ai/actions.js';
import { isProtectedRole } from '../security/discord-rules.js';
import { applyWithRollback, PartialApplyError } from './transaction.js';

interface PermissionOverwriteState {
  allow: { has(permission: bigint): boolean };
  deny: { has(permission: bigint): boolean };
}

export function describeAction(guild: Guild, action: DiscordAction): string {
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
  return `• Criar canal #${action.name}${action.categoryId ? ` em <#${action.categoryId}>` : ''}${action.privateToRequester ? ' privado para quem pediu' : ' com as permissões padrão do servidor'}. Motivo: ${action.reason}`;
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
  const roleAction = action.type === 'create_role' || action.type === 'delete_role';
  const needsManageRoles = roleAction || action.type === 'allow_read_history' || action.type === 'set_channel_permissions' || action.type === 'set_category_permissions' || action.type === 'set_channel_visibility' || action.type === 'create_text_channel' || action.type === 'recreate_role_for_category';
  const needsManageChannels = !roleAction && action.type !== 'set_voice_mute';
  if (!botMember) throw new Error('BOT_MEMBER_NOT_CACHED');
  if (needsManageRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
  if (needsManageChannels && !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('BOT_MISSING_MANAGE_CHANNELS');
  if (action.type === 'set_voice_mute' && !botMember.permissions.has(PermissionFlagsBits.MuteMembers)) throw new Error('BOT_MISSING_MUTE_MEMBERS');
  const reason = `Bot Discord IA: ${action.reason}`.slice(0, 500);

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

  if (action.type === 'create_category') {
    const created = await guild.channels.create({
      name: action.name,
      type: ChannelType.GuildCategory,
      reason,
    });
    return `Criei a categoria ${created.name}.`;
  }

  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
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
            ? { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
            : { id: role.id, deny: [PermissionFlagsBits.ViewChannel] }),
        { id: requesterId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ]
    : syncedOverwrites;
  const created = await guild.channels.create({
    name: action.name,
    type: ChannelType.GuildText,
    parent: parent?.id,
    permissionOverwrites: overwrites,
    reason,
  });
  return `Criei o canal <#${created.id}>.`;
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
