CREATE TABLE IF NOT EXISTS service_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  configured_by TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  model_id TEXT NOT NULL DEFAULT 'openrouter/free',
  user_daily_limit INTEGER NOT NULL CHECK (user_daily_limit > 0),
  guild_monthly_limit INTEGER NOT NULL CHECK (guild_monthly_limit > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_ai_keys (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('central', 'personal')),
  model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_events_guild_created_idx ON usage_events (guild_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events (user_id, created_at);

CREATE TABLE IF NOT EXISTS pending_changes (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  summary TEXT NOT NULL,
  actions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'completed', 'failed', 'cancelled', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_changes_expiry_idx ON pending_changes (expires_at) WHERE status = 'pending';
