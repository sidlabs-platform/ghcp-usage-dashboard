-- GitHub Copilot Usage Metrics Dashboard - Database Schema
-- Uses SQLite via better-sqlite3

-- Enterprise-level daily aggregate metrics
CREATE TABLE IF NOT EXISTS enterprise_daily_metrics (
  day TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  daily_active_users INTEGER DEFAULT 0,
  weekly_active_users INTEGER DEFAULT 0,
  monthly_active_users INTEGER DEFAULT 0,
  monthly_active_agent_users INTEGER DEFAULT 0,
  monthly_active_chat_users INTEGER DEFAULT 0,
  daily_active_cli_users INTEGER DEFAULT 0,
  code_generation_activity_count INTEGER DEFAULT 0,
  code_acceptance_activity_count INTEGER DEFAULT 0,
  user_initiated_interaction_count INTEGER DEFAULT 0,
  loc_suggested_to_add_sum INTEGER DEFAULT 0,
  loc_suggested_to_delete_sum INTEGER DEFAULT 0,
  loc_added_sum INTEGER DEFAULT 0,
  loc_deleted_sum INTEGER DEFAULT 0,
  totals_by_ide TEXT DEFAULT '[]',
  totals_by_feature TEXT DEFAULT '[]',
  totals_by_language_feature TEXT DEFAULT '[]',
  totals_by_model_feature TEXT DEFAULT '[]',
  totals_by_language_model TEXT DEFAULT '[]',
  totals_by_cli TEXT,
  pull_requests TEXT,
  raw_json TEXT,
  PRIMARY KEY (day, enterprise_id)
);

CREATE INDEX IF NOT EXISTS idx_enterprise_metrics_day ON enterprise_daily_metrics(day);

-- Organization-level daily aggregate metrics
CREATE TABLE IF NOT EXISTS org_daily_metrics (
  day TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  enterprise_id TEXT,
  daily_active_users INTEGER DEFAULT 0,
  weekly_active_users INTEGER DEFAULT 0,
  monthly_active_users INTEGER DEFAULT 0,
  monthly_active_agent_users INTEGER DEFAULT 0,
  monthly_active_chat_users INTEGER DEFAULT 0,
  daily_active_cli_users INTEGER DEFAULT 0,
  code_generation_activity_count INTEGER DEFAULT 0,
  code_acceptance_activity_count INTEGER DEFAULT 0,
  user_initiated_interaction_count INTEGER DEFAULT 0,
  loc_suggested_to_add_sum INTEGER DEFAULT 0,
  loc_suggested_to_delete_sum INTEGER DEFAULT 0,
  loc_added_sum INTEGER DEFAULT 0,
  loc_deleted_sum INTEGER DEFAULT 0,
  totals_by_ide TEXT DEFAULT '[]',
  totals_by_feature TEXT DEFAULT '[]',
  totals_by_language_feature TEXT DEFAULT '[]',
  totals_by_model_feature TEXT DEFAULT '[]',
  totals_by_language_model TEXT DEFAULT '[]',
  totals_by_cli TEXT,
  pull_requests TEXT,
  raw_json TEXT,
  PRIMARY KEY (day, org_slug)
);

CREATE INDEX IF NOT EXISTS idx_org_metrics_day ON org_daily_metrics(day);

-- User-level daily metrics (fully denormalized for fast queries)
CREATE TABLE IF NOT EXISTS user_daily_metrics (
  day TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  user_login TEXT NOT NULL,
  code_generation_activity_count INTEGER DEFAULT 0,
  code_acceptance_activity_count INTEGER DEFAULT 0,
  user_initiated_interaction_count INTEGER DEFAULT 0,
  loc_suggested_to_add_sum INTEGER DEFAULT 0,
  loc_suggested_to_delete_sum INTEGER DEFAULT 0,
  loc_added_sum INTEGER DEFAULT 0,
  loc_deleted_sum INTEGER DEFAULT 0,
  chat_panel_agent_mode INTEGER DEFAULT 0,
  chat_panel_ask_mode INTEGER DEFAULT 0,
  chat_panel_custom_mode INTEGER DEFAULT 0,
  chat_panel_edit_mode INTEGER DEFAULT 0,
  chat_panel_plan_mode INTEGER DEFAULT 0,
  chat_panel_unknown_mode INTEGER DEFAULT 0,
  used_agent INTEGER DEFAULT 0,
  used_chat INTEGER DEFAULT 0,
  used_cli INTEGER DEFAULT 0,
  used_copilot_code_review_active INTEGER DEFAULT 0,
  used_copilot_code_review_passive INTEGER DEFAULT 0,
  used_copilot_coding_agent INTEGER DEFAULT 0,
  totals_by_ide TEXT DEFAULT '[]',
  totals_by_feature TEXT DEFAULT '[]',
  totals_by_language_feature TEXT DEFAULT '[]',
  totals_by_model_feature TEXT DEFAULT '[]',
  totals_by_language_model TEXT DEFAULT '[]',
  totals_by_cli TEXT,
  agent_edit TEXT,
  raw_json TEXT,
  PRIMARY KEY (day, enterprise_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_metrics_login ON user_daily_metrics(user_login);
CREATE INDEX IF NOT EXISTS idx_user_metrics_day ON user_daily_metrics(day);
CREATE INDEX IF NOT EXISTS idx_user_metrics_enterprise_day ON user_daily_metrics(enterprise_id, day);

-- Copilot seat assignments (current snapshot)
CREATE TABLE IF NOT EXISTS copilot_seats (
  org_slug TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  plan_type TEXT,
  last_activity_at TEXT,
  last_activity_editor TEXT,
  last_authenticated_at TEXT,
  assigning_team_slug TEXT,
  assigning_team_name TEXT,
  pending_cancellation_date TEXT,
  created_at TEXT,
  updated_at TEXT,
  avatar_url TEXT,
  PRIMARY KEY (org_slug, user_login)
);

CREATE INDEX IF NOT EXISTS idx_seats_team ON copilot_seats(assigning_team_slug);

-- Team membership cache
CREATE TABLE IF NOT EXISTS team_memberships (
  team_slug TEXT NOT NULL,
  team_name TEXT NOT NULL,
  source TEXT NOT NULL,  -- 'org' or 'enterprise'
  org_slug TEXT,
  user_login TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_slug, source, user_login)
);

CREATE INDEX IF NOT EXISTS idx_team_members_login ON team_memberships(user_login);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_memberships(team_slug);

-- Sync log to track what's been fetched
CREATE TABLE IF NOT EXISTS sync_log (
  scope TEXT NOT NULL,       -- 'enterprise', 'org', 'users', 'seats', 'teams'
  scope_id TEXT NOT NULL,    -- enterprise slug, org slug, etc.
  day TEXT,                  -- NULL for non-day-based syncs (seats, teams)
  synced_at TEXT NOT NULL,
  record_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',  -- 'success', 'error', 'partial'
  error_message TEXT,
  PRIMARY KEY (scope, scope_id, day)
);

-- Sync lock for preventing concurrent syncs (works across serverless instances)
CREATE TABLE IF NOT EXISTS sync_lock (
  lock_key TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_log_scope ON sync_log(scope, scope_id);
