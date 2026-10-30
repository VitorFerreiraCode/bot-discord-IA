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
import { SAFE_ROLE_PERMISSION_NAMES, type DiscordAction, type SafeRolePermission } from '../ai/actions.js';

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
  const needsManageRoles = roleAction || action.type === 'allow_read_history' || action.type === 'set_channel_visibility' || action.type === 'create_text_channel' || action.type === 'recreate_role_for_category';
  const needsManageChannels = !roleAction;
  if (!botMember) throw new Error('BOT_MEMBER_NOT_CACHED');
  if (needsManageRoles && !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error('BOT_MISSING_MANAGE_ROLES');
  if (needsManageChannels && !botMember.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('BOT_MISSING_MANAGE_CHANNELS');
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
        for (const permission of SAFE_ROLE_PERMISSION_NAMES) {
          if (permission === 'ViewChannel' || permission === 'ReadMessageHistory') continue;
          const bit = PermissionFlagsBits[permission];
          if (oldOverwrite?.allow.has(bit)) overwrite[permission] = true;
          else if (oldOverwrite?.deny.has(bit)) overwrite[permission] = false;
        }
        await channel.permissionOverwrites.edit(replacement.id, overwrite, { reason });
      }

      for (const member of assignedMembers) {
        await member.roles.add(replacement, reason);
        migratedMembers.push(member);
      }
      await oldRole.delete(reason);
      return `Recriei o cargo <@&${replacement.id}>, migrei ${migratedMembers.length} membros e configurei acesso e leitura do histórico na categoria e nos ${childTextChannels.length} canais de texto.`;
    } catch (error) {
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

function roleIsProtectedAtRuntime(guild: Guild, role: Role): boolean {
  return role.id === guild.roles.everyone.id
    || role.managed
    || role.permissions.has(PermissionFlagsBits.Administrator)
    || role.permissions.has(PermissionFlagsBits.ManageGuild)
    || role.permissions.has(PermissionFlagsBits.ManageRoles)
    || guild.members.cache.get(guild.ownerId)?.roles.cache.has(role.id) === true
    || /(?:^|[^a-z0-9])(?:admin(?:istrator|istrador)?|owner|dono|propriet[aá]rio)(?:$|[^a-z0-9])/i.test(role.name);
}

export function controlTextChannel(channel: unknown): channel is TextChannel {
  return typeof channel === 'object' && channel !== null && 'send' in channel && 'permissionOverwrites' in channel;
}
