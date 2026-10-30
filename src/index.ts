import { startBot, stopBot } from './discord/bot.js';

await startBot();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopBot().finally(() => process.exit(0));
  });
}
