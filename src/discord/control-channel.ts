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
  if (stored?.type === ChannelType.GuildText) return stored;

  const botId = client.user?.id;
  if (!botId) throw new Error('Discord client is not ready');
  const rolePermissions = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.roles.everyone.id && role.id !== botId)
    .map((role) => role.permissions.has(PermissionFlagsBits.ManageGuild)
      ? { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
      : { id: role.id, deny: [PermissionFlagsBits.ViewChannel] });

  const channel = await guild.channels.create({
    name: 'comandos-do-bot',
    type: ChannelType.GuildText,
    topic: 'Canal privado para conversar com o Bot Discord IA.',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...rolePermissions,
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      {
        id: guild.ownerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
    reason: 'Canal privado de controle do Bot Discord IA',
  });
  await setControlChannel(guild.id, channel.id);
  await channel.send('Canal privado de controle criado. Administradores podem autorizar membros com `/bot-autorizar`. O operador do serviço pode executar `/bot-configurar` para iniciar a configuração global.');
  return channel;
}
