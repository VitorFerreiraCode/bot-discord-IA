import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { commands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(env.discordBotToken());
const clientId = env.discordClientId();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log(`Deployed ${commands.length} guild commands to ${guildId} for application ${clientId}.`);
} else {
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Deployed ${commands.length} global commands for application ${clientId}.`);
}
