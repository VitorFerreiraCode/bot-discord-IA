import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('bot-configurar')
    .setDescription('Configuração global inicial do serviço (somente operador).'),
  new SlashCommandBuilder()
    .setName('bot-autorizar')
    .setDescription('Autoriza uma pessoa a comandar o bot neste servidor.')
    .addUserOption((option) => option.setName('membro').setDescription('Pessoa que receberá acesso').setRequired(true)),
  new SlashCommandBuilder()
    .setName('bot-revogar')
    .setDescription('Remove a autorização de uma pessoa neste servidor.')
    .addUserOption((option) => option.setName('membro').setDescription('Pessoa que perderá acesso').setRequired(true)),
  new SlashCommandBuilder()
    .setName('bot-chave-remover')
    .setDescription('Remove sua chave pessoal do OpenRouter salva pelo bot.'),
  new SlashCommandBuilder()
    .setName('bot-status')
    .setDescription('Verifica conexão, intents, permissões, banco e configuração do bot.'),
].map((command) => command.toJSON());
