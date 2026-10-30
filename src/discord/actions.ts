import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import type { DiscordAction } from '../ai/actions.js';

export function describeAction(guild: Guild, action: DiscordAction): string {
  if (action.type === 'create_role') {
    const permissions = action.permissions.length ? action.permissions.join(', ') : 'sem permissões globais adicionais';
    return `• Criar o cargo **${action.name}** (${permissions}). Motivo: ${action.reason}`;
  }
  if (action.type === 'delete_role') {
    const role = guild.roles.cache.get(action.roleId);
    return `• Excluir o cargo <@&${action.roleId}>${role ? ` (**${role.name}**)` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'allow_read_history') {
    const channel = guild.channels.cache.get(action.channelId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    return `• Permitir que ${target} leia o histórico de <#${action.channelId}>${channel ? ` (#${channel.name})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'set_channel_visibility') {
    const channel = guild.channels.cache.get(action.channelId);
    const target = action.targetType === 'member' ? `<@${action.targetId}>` : `<@&${action.targetId}>`;
    return `• ${action.visible ? 'Permitir' : 'Remover'} visualização de ${target} em <#${action.channelId}>${channel ? ` (#${channel.name})` : ''}. Motivo: ${action.reason}`;
  }
  if (action.type === 'create_category') return `• Criar categoria **${action.name}**. Motivo: ${action.reason}`;
  return `• Criar canal #${action.name}${action.categoryId ? ` em <#${action.categoryId}>` : ''}${action.privateToRequester ? ' privado para quem pediu' : ' com as permissões padrão do servidor'}. Motivo: ${action.reason}`;
}

export async function applyDiscordAction(
  guild: Guild,
  requesterId: string,
  action: DiscordAction,
): Promise<string> {
  const botMember = guild.members.me;
  const roleAction = action.type === 'create_role' || action.type === 'delete_role';
  if (!botMember?.permissions.has(roleAction ? PermissionFlagsBits.ManageRoles : PermissionFlagsBits.ManageChannels)) {
    throw new Error(roleAction ? 'BOT_MISSING_MANAGE_ROLES' : 'BOT_MISSING_MANAGE_CHANNELS');
  }
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
    const protectedRole = role.managed
      || role.permissions.has(PermissionFlagsBits.Administrator)
      || role.permissions.has(PermissionFlagsBits.ManageGuild)
      || role.permissions.has(PermissionFlagsBits.ManageRoles)
      || owner.roles.cache.has(role.id)
      || /(?:^|[^a-z0-9])(?:admin(?:istrator|istrador)?|owner|dono|propriet[aá]rio)(?:$|[^a-z0-9])/i.test(role.name);
    if (protectedRole) throw new Error('PROTECTED_ROLE');
    if (!role.editable) throw new Error('ROLE_ABOVE_BOT_HIERARCHY');
    await role.delete(reason);
    return `Excluí o cargo **${role.name}**.`;
  }

  if (action.type === 'allow_read_history') {
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
    const channel = await guild.channels.fetch(action.channelId);
    if (!channel || !('permissionOverwrites' in channel)) throw new Error('CHANNEL_NOT_FOUND');
    if (action.targetType === 'member') await guild.members.fetch(action.targetId);
    else await guild.roles.fetch(action.targetId);
    await channel.permissionOverwrites.edit(action.targetId, { ReadMessageHistory: true }, { reason });
    return `Permiti a leitura do histórico em #${channel.name}.`;
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

export function controlTextChannel(channel: unknown): channel is TextChannel {
  return typeof channel === 'object' && channel !== null && 'send' in channel && 'permissionOverwrites' in channel;
}
