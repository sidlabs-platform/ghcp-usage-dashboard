-- GitHub Copilot Usage Metrics Dashboard - Database Schema
-- Uses SQLite via better-sqlite3

-- Enterprise-level daily aggregate metrics
CREATE TABLE IF NOT EXISTS enterprise_daily_metrics (
  day TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  daily_active_users INTEGER DEFAULT 0,
  weekly_active_users INTEGER DEFAULT 0,
  monthly_active_users INTEGER DEFAULT 0,
  monthly_active_agent_users INTEGER DEFAULT 0,
  monthly_active_chat_users INTEGER DEFAULT 0,
  daily_active_cli_users INTEGER DEFAULT 0,
  daily_active_copilot_app_users INTEGER DEFAULT NULL,
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
  totals_by_copilot_app TEXT DEFAULT NULL,
  totals_by_ai_adoption_phase TEXT DEFAULT '[]',
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
  enterprise_slug TEXT NOT NULL DEFAULT '',
  daily_active_users INTEGER DEFAULT 0,
  weekly_active_users INTEGER DEFAULT 0,
  monthly_active_users INTEGER DEFAULT 0,
  monthly_active_agent_users INTEGER DEFAULT 0,
  monthly_active_chat_users INTEGER DEFAULT 0,
  daily_active_cli_users INTEGER DEFAULT 0,
  daily_active_copilot_app_users INTEGER DEFAULT NULL,
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
  totals_by_copilot_app TEXT DEFAULT NULL,
  totals_by_ai_adoption_phase TEXT DEFAULT '[]',
  pull_requests TEXT,
  raw_json TEXT,
  PRIMARY KEY (day, org_slug)
);

CREATE INDEX IF NOT EXISTS idx_org_metrics_day ON org_daily_metrics(day);

-- User-level daily metrics (fully denormalized for fast queries)
CREATE TABLE IF NOT EXISTS user_daily_metrics (
  day TEXT NOT NULL,
  enterprise_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL,
  user_login TEXT NOT NULL,
  code_generation_activity_count INTEGER DEFAULT 0,
  code_acceptance_activity_count INTEGER DEFAULT 0,
  user_initiated_interaction_count INTEGER DEFAULT 0,
  loc_suggested_to_add_sum INTEGER DEFAULT 0,
  loc_suggested_to_delete_sum INTEGER DEFAULT 0,
  loc_added_sum INTEGER DEFAULT 0,
  loc_deleted_sum INTEGER DEFAULT 0,
  ai_credits_used REAL DEFAULT 0,
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
  used_copilot_app INTEGER DEFAULT NULL,
  totals_by_ide TEXT DEFAULT '[]',
  totals_by_feature TEXT DEFAULT '[]',
  totals_by_language_feature TEXT DEFAULT '[]',
  totals_by_model_feature TEXT DEFAULT '[]',
  totals_by_language_model TEXT DEFAULT '[]',
  totals_by_cli TEXT,
  totals_by_copilot_app TEXT DEFAULT NULL,
  ai_adoption_phase TEXT,
  agent_edit TEXT,
  raw_json TEXT,
  PRIMARY KEY (day, enterprise_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_metrics_login ON user_daily_metrics(user_login);
CREATE INDEX IF NOT EXISTS idx_user_metrics_day ON user_daily_metrics(day);
CREATE INDEX IF NOT EXISTS idx_user_metrics_enterprise_day ON user_daily_metrics(enterprise_id, day);

-- Copilot seat assignments (current snapshot)
CREATE TABLE IF NOT EXISTS copilot_seats (
  enterprise_slug TEXT NOT NULL DEFAULT '',
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
  PRIMARY KEY (enterprise_slug, org_slug, user_login)
);

CREATE INDEX IF NOT EXISTS idx_seats_team ON copilot_seats(assigning_team_slug);

-- Team membership cache
CREATE TABLE IF NOT EXISTS team_memberships (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  team_slug TEXT NOT NULL,
  team_name TEXT NOT NULL,
  source TEXT NOT NULL,  -- 'org' or 'enterprise'
  org_slug TEXT,
  user_login TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, team_slug, source, user_login)
);

CREATE INDEX IF NOT EXISTS idx_team_members_login ON team_memberships(user_login);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_memberships(team_slug);

-- Sync log to track what's been fetched
CREATE TABLE IF NOT EXISTS sync_log (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,       -- 'enterprise', 'org', 'users', 'seats', 'teams'
  scope_id TEXT NOT NULL,    -- enterprise slug, org slug, etc.
  day TEXT,                  -- NULL for non-day-based syncs (seats, teams)
  synced_at TEXT NOT NULL,
  record_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',  -- 'success', 'error', 'partial'
  error_message TEXT,
  PRIMARY KEY (enterprise_slug, scope, scope_id, day)
);

-- Sync lock for preventing concurrent syncs (works across serverless instances)
CREATE TABLE IF NOT EXISTS sync_lock (
  lock_key TEXT PRIMARY KEY,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_log_scope ON sync_log(scope, scope_id);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_enterprise_metrics_eid_day ON enterprise_daily_metrics(enterprise_id, day);
CREATE INDEX IF NOT EXISTS idx_org_metrics_org_day ON org_daily_metrics(org_slug, day);
CREATE INDEX IF NOT EXISTS idx_sync_log_scope_day ON sync_log(scope, scope_id, day);
CREATE INDEX IF NOT EXISTS idx_team_members_org ON team_memberships(org_slug);
CREATE INDEX IF NOT EXISTS idx_seats_org ON copilot_seats(org_slug);

-- Scalability indexes for large-scale queries
CREATE INDEX IF NOT EXISTS idx_user_metrics_login_day ON user_daily_metrics(user_login, day);
CREATE INDEX IF NOT EXISTS idx_copilot_seats_user ON copilot_seats(user_login);

-- Enterprise registry for multi-enterprise support
CREATE TABLE IF NOT EXISTS enterprise_registry (
  slug TEXT PRIMARY KEY,
  enterprise_id TEXT,
  display_name TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for enterprise_slug filtering
CREATE INDEX IF NOT EXISTS idx_enterprise_daily_metrics_slug ON enterprise_daily_metrics(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_org_daily_metrics_slug ON org_daily_metrics(enterprise_slug, day, org_slug);
CREATE INDEX IF NOT EXISTS idx_user_daily_metrics_slug ON user_daily_metrics(enterprise_slug, day, user_login);
CREATE INDEX IF NOT EXISTS idx_copilot_seats_slug ON copilot_seats(enterprise_slug, org_slug, user_login);
CREATE INDEX IF NOT EXISTS idx_team_memberships_slug ON team_memberships(enterprise_slug, team_slug, user_login);
CREATE INDEX IF NOT EXISTS idx_sync_log_slug ON sync_log(enterprise_slug, scope, scope_id, day);

-- Auto-discovered (or configured) organization cache per enterprise
CREATE TABLE IF NOT EXISTS enterprise_orgs (
  enterprise_slug TEXT NOT NULL,
  org_slug TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'discovered',
  last_synced_at TEXT,
  PRIMARY KEY (enterprise_slug, org_slug)
);

-- Copilot user-team attribution (per-day, from user-teams-1-day API)
CREATE TABLE IF NOT EXISTS copilot_user_teams (
  day TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  org_slug TEXT NOT NULL DEFAULT '',
  team_slug TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  user_login TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, enterprise_slug, org_slug, team_slug, user_id)
);

CREATE INDEX IF NOT EXISTS idx_copilot_user_teams_day ON copilot_user_teams(day);
CREATE INDEX IF NOT EXISTS idx_copilot_user_teams_login ON copilot_user_teams(user_login, day);
CREATE INDEX IF NOT EXISTS idx_copilot_user_teams_team ON copilot_user_teams(team_slug, day);
CREATE INDEX IF NOT EXISTS idx_copilot_user_teams_slug ON copilot_user_teams(enterprise_slug, day);
