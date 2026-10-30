import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { env } from '../config/env.js';
import { getServiceConfig, saveServiceConfig, updateServiceModel } from '../db/queries.js';
import { listFreeChatModels } from '../ai/openrouter.js';

function limitInput(customId: string, label: string): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Informe o limite que deseja configurar')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(8),
  );
}

export async function beginSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.user.id !== env.botOwnerDiscordId) {
    await interaction.reply({ content: 'Este comando é exclusivo do operador do serviço.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId('service-config-modal')
    .setTitle('Configuração global do Bot IA')
    .addComponents(
      limitInput('userDailyLimit', 'Pedidos centrais por pessoa ao dia'),
      limitInput('guildMonthlyLimit', 'Pedidos centrais por servidor ao mês'),
      limitInput('maxOutputTokens', 'Máximo de tokens de saída por resposta'),
    );
  await interaction.showModal(modal);
}

function readLimit(interaction: ModalSubmitInteraction, id: string, label: string, max: number): number {
  const value = Number(interaction.fields.getTextInputValue(id));
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} precisa ser um número entre 1 e ${max}.`);
  }
  return value;
}

export async function finishSetupModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.user.id !== env.botOwnerDiscordId) {
    await interaction.reply({ content: 'Somente o operador pode salvar a configuração global.', ephemeral: true });
    return;
  }
  let userDailyLimit: number;
  let guildMonthlyLimit: number;
  let maxOutputTokens: number;
  try {
    userDailyLimit = readLimit(interaction, 'userDailyLimit', 'Limite diário', 100_000);
    guildMonthlyLimit = readLimit(interaction, 'guildMonthlyLimit', 'Limite mensal', 1_000_000);
    maxOutputTokens = readLimit(interaction, 'maxOutputTokens', 'Máximo de tokens', 32_000);
  } catch (error) {
    await interaction.reply({ content: error instanceof Error ? error.message : 'Valores inválidos.', ephemeral: true });
    return;
  }

  const previousConfig = await getServiceConfig();
  let models: Awaited<ReturnType<typeof listFreeChatModels>> = [];
  try {
    models = await listFreeChatModels(env.openRouterApiKey, true);
  } catch {
    // The built-in free router remains the safe initial model if the catalog is unavailable.
  }
  const previousModelIsFree = previousConfig?.modelId === 'openrouter/free'
    || models.some((model) => model.id === previousConfig?.modelId);
  const modelId = previousModelIsFree ? previousConfig!.modelId : 'openrouter/free';
  await saveServiceConfig({
    configuredBy: interaction.user.id,
    modelId,
    userDailyLimit,
    guildMonthlyLimit,
    maxOutputTokens,
  });
  if (models.length === 0) {
    await interaction.reply({
      content: 'Configuração salva com openrouter/free. Não consegui carregar outras opções agora; o modelo gratuito padrão continua ativo.',
      ephemeral: true,
    });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('service-model-select')
    .setPlaceholder('Opcional: escolha outro modelo gratuito')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      { label: 'OpenRouter Free Router (recomendado)', value: 'openrouter/free', description: 'Escolhe um modelo gratuito compatível em cada pedido', default: modelId === 'openrouter/free' },
      ...models.map((model) => ({
        label: model.name.slice(0, 100),
        value: model.id.slice(0, 100),
        description: model.id.slice(0, 100),
        default: model.id === modelId,
      })),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  await interaction.reply({
    content: `Configuração salva. Limites: ${userDailyLimit} pedidos centrais por pessoa/dia, ${guildMonthlyLimit} por servidor/mês e ${maxOutputTokens} tokens de saída. O modelo gratuito \`${modelId}\` está ativo. Você pode mantê-lo ou escolher outra opção gratuita abaixo.`,
    components: [row],
    ephemeral: true,
  });
}

export async function selectServiceModel(interaction: import('discord.js').StringSelectMenuInteraction): Promise<void> {
  if (interaction.user.id !== env.botOwnerDiscordId) {
    await interaction.reply({ content: 'Somente o operador pode escolher o modelo global.', ephemeral: true });
    return;
  }
  const modelId = interaction.values[0];
  if (!modelId) {
    await interaction.reply({ content: 'Nenhum modelo foi selecionado.', ephemeral: true });
    return;
  }
  if (modelId !== 'openrouter/free') {
    const models = await listFreeChatModels(env.openRouterApiKey, true);
    if (!models.some((model) => model.id === modelId)) {
      await interaction.reply({ content: 'Esse modelo não aparece mais no catálogo gratuito e compatível. Execute `/bot-configurar` para escolher outro.', ephemeral: true });
      return;
    }
  }
  await updateServiceModel(modelId);
  await interaction.update({ content: `Modelo global atualizado para \`${modelId}\`.`, components: [] });
}
