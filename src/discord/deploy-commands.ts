import { REST, Routes } from 'discord.js';
import { env } from '../config/env.js';
import { commands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(env.discordBotToken());
await rest.put(Routes.applicationCommands(env.discordClientId()), { body: commands });
console.log(`Deployed ${commands.length} application commands.`);
