import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelPermissionChanges } from '../ai/planner.js';
import { containsMassMention, explicitlyRequestsMessageDeletion, isKnownDiscordEntity, isProtectedRole, hasNegatedDestructiveIntent, isProviderTimeout, parseDiscordMessageLinks, proposalExpiresAt, requestMentionsMessages } from '../security/discord-rules.js';
import { applyWithRollback, PartialApplyError } from '../discord/transaction.js';

test('negações e cancelamentos bloqueiam intenção destrutiva, mas relato de problema não', () => {
  assert.equal(hasNegatedDestructiveIntent('Não apague o cargo Ligeirinho'), true);
  assert.equal(hasNegatedDestructiveIntent('cancela, não recrie o cargo'), true);
  assert.equal(hasNegatedDestructiveIntent('Não consigo ver o histórico; apague o cargo antigo'), false);
});

test('protege cargos administrativos, do dono, gerenciados e @everyone', () => {
  const base = { id: '12345678901234567', everyoneId: '00000000000000000', managed: false, administrator: false, manageGuild: false, manageRoles: false, ownerHasRole: false, name: 'Ligeirinho' };
  assert.equal(isProtectedRole({ ...base, administrator: true }), true);
  assert.equal(isProtectedRole({ ...base, ownerHasRole: true }), true);
  assert.equal(isProtectedRole({ ...base, managed: true }), true);
  assert.equal(isProtectedRole({ ...base, id: base.everyoneId }), true);
  assert.equal(isProtectedRole(base), false);
});

test('rejeita permissões desconhecidas ou valores que não sejam booleanos', () => {
  assert.deepEqual(parseChannelPermissionChanges({ ReadMessageHistory: true, Speak: false }), { ReadMessageHistory: true, Speak: false });
  assert.throws(() => parseChannelPermissionChanges({ Administrator: true }), /INVALID_CHANNEL_PERMISSIONS/);
  assert.throws(() => parseChannelPermissionChanges({ Connect: 'true' }), /INVALID_CHANNEL_PERMISSIONS/);
  assert.throws(() => parseChannelPermissionChanges({}), /INVALID_CHANNEL_PERMISSIONS/);
});

test('valida IDs de entidades do Discord contra Snowflake conhecido', () => {
  const known = new Set(['12345678901234567']);
  assert.equal(isKnownDiscordEntity('12345678901234567', known), true);
  assert.equal(isKnownDiscordEntity('99999999999999999', known), false);
  assert.equal(isKnownDiscordEntity('not-an-id', known), false);
});

test('reconhece timeout do provedor sem classificar outros erros como timeout', () => {
  assert.equal(isProviderTimeout(new Error('The operation was aborted due to timeout')), true);
  assert.equal(isProviderTimeout(new Error('OPENROUTER_CHAT_HTTP_401')), false);
});

test('proposta expira cinco minutos após sua criação', () => {
  const createdAt = 1_800_000_000_000;
  assert.equal(proposalExpiresAt(createdAt).getTime(), createdAt + 5 * 60_000);
});

test('falha no meio de uma operação sequencial reverte em ordem inversa', async () => {
  const applied: number[] = [];
  const rolledBack: number[] = [];
  await assert.rejects(
    applyWithRollback([1, 2, 3], async (item) => {
      if (item === 3) throw new Error('simulated API failure');
      applied.push(item);
    }, async (item) => { rolledBack.push(item); }),
    (error: unknown) => error instanceof PartialApplyError && error.rollbackFailures === 0,
  );
  assert.deepEqual(applied, [1, 2]);
  assert.deepEqual(rolledBack, [3, 2, 1]);
});

test('reporta falha da própria reversão parcial', async () => {
  await assert.rejects(
    applyWithRollback([1], async () => { throw new Error('apply failed'); }, async () => { throw new Error('rollback failed'); }),
    (error: unknown) => error instanceof PartialApplyError && error.rollbackFailures === 1,
  );
});

test('exclusão de mensagem exige pedido explícito e respeita negação', () => {
  assert.equal(explicitlyRequestsMessageDeletion('Apague a mensagem de aviso em #geral'), true);
  assert.equal(explicitlyRequestsMessageDeletion('exclui https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678'), true);
  assert.equal(explicitlyRequestsMessageDeletion('Não apague a mensagem fixada'), false);
  assert.equal(explicitlyRequestsMessageDeletion('Fixe a mensagem de regras'), false);
  assert.equal(explicitlyRequestsMessageDeletion('Apague o cargo Ligeirinho'), false);
});

test('extrai links de mensagens do Discord sem duplicar', () => {
  const link = 'https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678';
  assert.deepEqual(parseDiscordMessageLinks(`edite ${link} e ${link}`), [{ guildId: '123456789012345678', channelId: '223456789012345678', messageId: '323456789012345678' }]);
  assert.equal(parseDiscordMessageLinks('https://ptb.discord.com/channels/123456789012345678/223456789012345678/423456789012345678').length, 1);
  assert.deepEqual(parseDiscordMessageLinks('sem links aqui'), []);
});

test('só anexa mensagens ao retrato quando o pedido fala de mensagens', () => {
  assert.equal(requestMentionsMessages('Envie um aviso em #anuncios'), true);
  assert.equal(requestMentionsMessages('fixa a msg de regras'), true);
  assert.equal(requestMentionsMessages('Crie um canal de voz chamado Treino'), false);
  assert.equal(requestMentionsMessages('Por que o cargo X não vê a categoria?'), false);
});

test('detecta menções em massa', () => {
  assert.equal(containsMassMention('Atenção @everyone'), true);
  assert.equal(containsMassMention('Atenção @here!'), true);
  assert.equal(containsMassMention('email@everyonemail.com'), false);
});
