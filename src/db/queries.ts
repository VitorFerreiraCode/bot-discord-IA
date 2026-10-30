import { pool } from './pool.js';

export async function ensureGuild(guildId: string, ownerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO guilds (guild_id, owner_id) VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET owner_id = EXCLUDED.owner_id`,
    [guildId, ownerId],
  );
  await pool.query(
    `INSERT INTO authorized_users (guild_id, user_id, access_level, granted_by)
     VALUES ($1, $2, 'owner', $2)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET access_level = 'owner'`,
    [guildId, ownerId],
  );
}

export async function getControlChannel(guildId: string): Promise<string | null> {
  const result = await pool.query<{ control_channel_id: string | null }>(
    'SELECT control_channel_id FROM guilds WHERE guild_id = $1', [guildId],
  );
  return result.rows[0]?.control_channel_id ?? null;
}

export async function setControlChannel(guildId: string, channelId: string): Promise<void> {
  await pool.query('UPDATE guilds SET control_channel_id = $2 WHERE guild_id = $1', [guildId, channelId]);
}

export async function isAuthorized(guildId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM authorized_users WHERE guild_id = $1 AND user_id = $2', [guildId, userId],
  );
  return result.rowCount === 1;
}

export async function authorizeUser(guildId: string, userId: string, grantedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO authorized_users (guild_id, user_id, granted_by)
     VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [guildId, userId, grantedBy],
  );
}

export async function revokeUser(guildId: string, userId: string): Promise<void> {
  await pool.query(
    "DELETE FROM authorized_users WHERE guild_id = $1 AND user_id = $2 AND access_level <> 'owner'",
    [guildId, userId],
  );
}

export interface ServiceConfig {
  configuredBy: string;
  modelId: string;
  userDailyLimit: number;
  guildMonthlyLimit: number;
  maxOutputTokens: number;
}

export interface EncryptedKey {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export async function getServiceConfig(): Promise<ServiceConfig | null> {
  const result = await pool.query<{
    configured_by: string;
    model_id: string;
    user_daily_limit: number;
    guild_monthly_limit: number;
    max_output_tokens: number;
  }>('SELECT configured_by, model_id, user_daily_limit, guild_monthly_limit, max_output_tokens FROM service_config WHERE id = 1');
  const row = result.rows[0];
  return row ? {
    configuredBy: row.configured_by,
    modelId: row.model_id,
    userDailyLimit: row.user_daily_limit,
    guildMonthlyLimit: row.guild_monthly_limit,
    maxOutputTokens: row.max_output_tokens,
  } : null;
}

export async function saveServiceConfig(config: ServiceConfig): Promise<void> {
  await pool.query(
    `INSERT INTO service_config (id, configured_by, model_id, user_daily_limit, guild_monthly_limit, max_output_tokens)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET configured_by = EXCLUDED.configured_by,
       model_id = EXCLUDED.model_id, user_daily_limit = EXCLUDED.user_daily_limit,
       guild_monthly_limit = EXCLUDED.guild_monthly_limit,
       max_output_tokens = EXCLUDED.max_output_tokens, configured_at = NOW()`,
    [config.configuredBy, config.modelId, config.userDailyLimit, config.guildMonthlyLimit, config.maxOutputTokens],
  );
}

export async function updateServiceModel(modelId: string): Promise<void> {
  await pool.query('UPDATE service_config SET model_id = $1, configured_at = NOW() WHERE id = 1', [modelId]);
}

export async function storeUserKey(userId: string, key: EncryptedKey): Promise<void> {
  await pool.query(
    `INSERT INTO user_ai_keys (user_id, ciphertext, iv, auth_tag) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
       auth_tag = EXCLUDED.auth_tag, updated_at = NOW()`,
    [userId, key.ciphertext, key.iv, key.authTag],
  );
}

export async function getUserKey(userId: string): Promise<EncryptedKey | null> {
  const result = await pool.query<{ ciphertext: string; iv: string; auth_tag: string }>(
    'SELECT ciphertext, iv, auth_tag FROM user_ai_keys WHERE user_id = $1', [userId],
  );
  const row = result.rows[0];
  return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag } : null;
}

export async function deleteUserKey(userId: string): Promise<void> {
  await pool.query('DELETE FROM user_ai_keys WHERE user_id = $1', [userId]);
}

export async function reserveUsage(
  guildId: string,
  userId: string,
  source: 'central' | 'personal',
  modelId: string,
  limits: Pick<ServiceConfig, 'userDailyLimit' | 'guildMonthlyLimit'>,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user:${userId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`guild:${guildId}`]);
    if (source === 'central') {
      const userUsage = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM usage_events
         WHERE user_id = $1 AND source = 'central'
           AND created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [userId],
      );
      const guildUsage = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM usage_events
         WHERE guild_id = $1 AND source = 'central'
           AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [guildId],
      );
      if (Number(userUsage.rows[0]?.count ?? 0) >= limits.userDailyLimit) {
        throw new Error('USER_DAILY_LIMIT');
      }
      if (Number(guildUsage.rows[0]?.count ?? 0) >= limits.guildMonthlyLimit) {
        throw new Error('GUILD_MONTHLY_LIMIT');
      }
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO usage_events (guild_id, user_id, source, model_id)
       VALUES ($1, $2, $3, $4) RETURNING id::text`, [guildId, userId, source, modelId],
    );
    await client.query('COMMIT');
    return inserted.rows[0]!.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordUsageTokens(id: string, inputTokens: number, outputTokens: number, modelId: string): Promise<void> {
  await pool.query('UPDATE usage_events SET input_tokens = $2, output_tokens = $3, model_id = $4 WHERE id = $1', [id, inputTokens, outputTokens, modelId]);
}

export async function getGuildMonthlyCentralUsage(guildId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM usage_events
     WHERE guild_id = $1 AND source = 'central'
       AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [guildId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function createPendingChange(input: {
  id: string;
  guildId: string;
  channelId: string;
  requestedBy: string;
  summary: string;
  actions: unknown;
  expiresAt: Date;
}): Promise<void> {
  await pool.query("DELETE FROM pending_changes WHERE created_at < NOW() - INTERVAL '14 days'");
  await pool.query(
    `INSERT INTO pending_changes (id, guild_id, channel_id, requested_by, summary, actions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.id, input.guildId, input.channelId, input.requestedBy, input.summary, JSON.stringify(input.actions), input.expiresAt],
  );
}

export async function claimPendingChange(id: string, guildId: string): Promise<{
  guildId: string;
  channelId: string;
  requestedBy: string;
  summary: string;
  actions: unknown;
} | null> {
  await pool.query("UPDATE pending_changes SET status = 'expired' WHERE expires_at <= NOW() AND status = 'pending'");
  const result = await pool.query<{
    guild_id: string;
    channel_id: string;
    requested_by: string;
    summary: string;
    actions: unknown;
  }>(
    `UPDATE pending_changes SET status = 'applying'
     WHERE id = $1 AND guild_id = $2 AND status = 'pending' AND expires_at > NOW()
     RETURNING guild_id, channel_id, requested_by, summary, actions`, [id, guildId],
  );
  const row = result.rows[0];
  return row ? { guildId: row.guild_id, channelId: row.channel_id, requestedBy: row.requested_by, summary: row.summary, actions: row.actions } : null;
}

export async function setPendingChangeStatus(id: string, status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
  await pool.query('UPDATE pending_changes SET status = $2 WHERE id = $1', [id, status]);
}

export async function cancelPendingChange(id: string, guildId: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE pending_changes SET status = 'cancelled'
     WHERE id = $1 AND guild_id = $2 AND requested_by = $3 AND status = 'pending'`, [id, guildId, userId],
  );
  return result.rowCount === 1;
}
