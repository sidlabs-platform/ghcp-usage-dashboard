-- Pre-aggregated summary tables for scalable dashboard queries
-- Populated by summary-tables.ts after each sync

-- Per-user rollup for a given date range
CREATE TABLE IF NOT EXISTS user_period_summary (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL,
  user_login TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  active_days INTEGER DEFAULT 0,
  loc_added INTEGER DEFAULT 0,
  loc_deleted INTEGER DEFAULT 0,
  interactions INTEGER DEFAULT 0,
  code_gen INTEGER DEFAULT 0,
  code_accept INTEGER DEFAULT 0,
  acceptance_rate REAL DEFAULT 0,
  used_agent INTEGER DEFAULT 0,
  used_chat INTEGER DEFAULT 0,
  used_cli INTEGER DEFAULT 0,
  used_code_review_active INTEGER DEFAULT 0,
  used_code_review_passive INTEGER DEFAULT 0,
  used_coding_agent INTEGER DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, user_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_user_summary_period ON user_period_summary(period_start, period_end);

-- Daily aggregate cache (enterprise-wide totals per day)
CREATE TABLE IF NOT EXISTS daily_aggregate_cache (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  total_users INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  loc_added INTEGER DEFAULT 0,
  loc_deleted INTEGER DEFAULT 0,
  code_gen INTEGER DEFAULT 0,
  code_accept INTEGER DEFAULT 0,
  interactions INTEGER DEFAULT 0,
  agent_users INTEGER DEFAULT 0,
  chat_users INTEGER DEFAULT 0,
  cli_users INTEGER DEFAULT 0,
  coding_agent_users INTEGER DEFAULT 0,
  code_review_users INTEGER DEFAULT 0,
  completion_loc_suggested INTEGER DEFAULT 0,
  completion_loc_accepted INTEGER DEFAULT 0,
  agent_loc_added INTEGER DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, day)
);

-- Per-team summary cache
CREATE TABLE IF NOT EXISTS team_summary_cache (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  team_slug TEXT NOT NULL,
  source TEXT NOT NULL,
  org_slug TEXT,
  team_name TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total_members INTEGER DEFAULT 0,
  active_members INTEGER DEFAULT 0,
  avg_daily_active_users REAL DEFAULT 0,
  total_loc_added INTEGER DEFAULT 0,
  total_interactions INTEGER DEFAULT 0,
  overall_acceptance_rate REAL DEFAULT 0,
  agent_adoption_rate REAL DEFAULT 0,
  chat_adoption_rate REAL DEFAULT 0,
  cli_adoption_rate REAL DEFAULT 0,
  code_review_adoption_rate REAL DEFAULT 0,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, team_slug, source, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_team_summary_period ON team_summary_cache(period_start, period_end);

-- One-time migration ledger for summary/cache migrations (e.g. the
-- classification-dependent recompute in summary-cache-migration.ts). Each row
-- records that a named migration has been applied so it never re-runs.
-- Intentionally NOT tied to any specific cache table's data so it stays valid
-- even if those tables are empty.
CREATE TABLE IF NOT EXISTS summary_cache_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- Indexes for enterprise_slug filtering
CREATE INDEX IF NOT EXISTS idx_user_summary_slug ON user_period_summary(enterprise_slug, user_login);
CREATE INDEX IF NOT EXISTS idx_daily_agg_cache_slug ON daily_aggregate_cache(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_team_summary_slug ON team_summary_cache(enterprise_slug, team_slug);
