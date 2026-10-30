try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  discordBotToken: () => required('DISCORD_BOT_TOKEN'),
  discordClientId: () => required('DISCORD_CLIENT_ID'),
  databaseUrl: () => required('DATABASE_URL'),
  openRouterApiKey: required('OPENROUTER_API_KEY'),
  botOwnerDiscordId: required('BOT_OWNER_DISCORD_ID'),
};
