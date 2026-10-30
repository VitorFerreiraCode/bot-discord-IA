CREATE TABLE IF NOT EXISTS change_audit (
  pending_change_id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  action_metadata JSONB NOT NULL,
  undo_data JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome TEXT NOT NULL CHECK (outcome IN ('applying', 'applied', 'partial_failed', 'failed', 'undoing', 'undone', 'undo_failed')),
  undo_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS change_audit_guild_created_idx ON change_audit (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS change_audit_undo_expiry_idx ON change_audit (undo_expires_at) WHERE outcome = 'applied';
