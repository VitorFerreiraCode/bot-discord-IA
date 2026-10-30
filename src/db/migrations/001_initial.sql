CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  control_channel_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS authorized_users (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'member' CHECK (access_level IN ('owner', 'member')),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);
