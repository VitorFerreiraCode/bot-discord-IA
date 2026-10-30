import {
  ChannelType,
  Client,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { ensureGuild, getControlChannel, setControlChannel } from '../db/queries.js';

export async function ensureControlChannel(client: Client, guild: Guild): Promise<TextChannel> {
  await ensureGuild(guild.id, guild.ownerId);
  const storedId = await getControlChannel(guild.id);
  const stored = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  const botId = client.user?.id;
  if (!botId) throw new Error('Discord client is not ready');
  if (stored?.type === ChannelType.GuildText) {
    await stored.permissionOverwrites.edit(botId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageMessages: true,
      ManageThreads: true,
      CreatePublicThreads: true,
      SendMessagesInThreads: true,
    }, { reason: 'Atualizar permissões do canal privado de controle' });
    await stored.permissionOverwrites.edit(guild.ownerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      SendMessagesInThreads: true,
    }, { reason: 'Permitir ao proprietário conversar nos tópicos de controle' });
    for (const role of guild.roles.cache.values()) {
      if (role.id !== guild.roles.everyone.id && role.id !== botId && role.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await stored.permissionOverwrites.edit(role.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          SendMessagesInThreads: true,
        }, { reason: 'Permitir a administradores conversar nos tópicos de controle' });
      }
    }
    return stored;
  }

  const [owner, botMember] = await Promise.all([
    guild.members.fetch(guild.ownerId),
    guild.members.fetch(botId),
  ]);
  const rolePermissions = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.roles.everyone.id && role.id !== botId)
    .map((role) => role.permissions.has(PermissionFlagsBits.ManageGuild)
      ? { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads] }
      : { id: role.id, deny: [PermissionFlagsBits.ViewChannel] });

  const channel = await guild.channels.create({
    name: 'comandos-do-bot',
    type: ChannelType.GuildText,
    topic: 'Canal privado para conversar com o Bot Discord IA.',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...rolePermissions,
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.ManageThreads,
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
      {
        id: owner.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
      },
    ],
    reason: 'Canal privado de controle do Bot Discord IA',
  });
  await setControlChannel(guild.id, channel.id);
  await channel.send('Canal privado de controle criado. Administradores podem autorizar membros com `/bot-autorizar`. O operador do serviço pode executar `/bot-configurar` para iniciar a configuração global.');
  return channel;
}
