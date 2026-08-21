-- GitHub Copilot Usage Metrics Dashboard - Database Schema
-- Uses SQLite via Node's built-in node:sqlite module

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

-- ============================================================================
-- Copilot seat lifecycle ledger (onboarding / offboarding)
-- ============================================================================
--
-- `copilot_seats` above is a CURRENT snapshot: replaceEnterpriseSeats() deletes
-- and re-inserts every row each sync, so a removed seat leaves no trace. This
-- append-only ledger is what makes "who was offboarded in this window?"
-- answerable. It is purely additive — it never requires dropping or re-syncing
-- `copilot_seats`.
--
-- Three sources feed it (see seat-lifecycle-repo.ts):
--   * 'seat_created_at' — onboarding derived from copilot_seats.created_at.
--     Retroactive; works on already-synced data with no re-sync.
--   * 'sync_diff'       — offboarding detected by diffing the live seat snapshot
--     against the stored one during seat sync. Available to every install, but
--     only from the first sync after this feature ships onward.
--   * 'audit_log'       — both directions, with exact GitHub-reported dates.
--     Fetched from the audit log API on every seat sync (seat-audit-sync.ts),
--     and additionally projected from license_audit_events when the optional
--     licensing-history sync is enabled.
--
-- `source` participates in the primary key so re-deriving one source is
-- idempotent (INSERT OR REPLACE) and never destroys another source's row.
CREATE TABLE IF NOT EXISTS copilot_seat_lifecycle_events (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  org_slug TEXT NOT NULL,
  user_login TEXT NOT NULL,
  user_id INTEGER,
  event_type TEXT NOT NULL,   -- 'onboarded' | 'offboarded'
  event_date TEXT NOT NULL,   -- 'YYYY-MM-DD' — the query grain
  occurred_at TEXT NOT NULL,  -- full ISO 8601 timestamp
  plan_type TEXT,
  assigning_team_slug TEXT,
  assigning_team_name TEXT,
  last_activity_at TEXT,
  source TEXT NOT NULL,       -- 'seat_created_at' | 'sync_diff' | 'audit_log'
  detected_at TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, org_slug, user_login, event_type, event_date, source)
);

CREATE INDEX IF NOT EXISTS idx_seat_lifecycle_window
  ON copilot_seat_lifecycle_events(enterprise_slug, event_date);
CREATE INDEX IF NOT EXISTS idx_seat_lifecycle_type_window
  ON copilot_seat_lifecycle_events(enterprise_slug, event_type, event_date);
CREATE INDEX IF NOT EXISTS idx_seat_lifecycle_login
  ON copilot_seat_lifecycle_events(enterprise_slug, user_login);
CREATE INDEX IF NOT EXISTS idx_seat_lifecycle_source
  ON copilot_seat_lifecycle_events(enterprise_slug, source);

-- When snapshot-diff offboard tracking first ran for an enterprise. The UI uses
-- this to say "offboards before <date> were not recorded" instead of silently
-- implying there were none.
CREATE TABLE IF NOT EXISTS copilot_seat_lifecycle_coverage (
  enterprise_slug TEXT PRIMARY KEY,
  tracking_started_at TEXT NOT NULL
);

-- Audit-log seat lifecycle sync state, one row per enterprise.
--
-- The audit log is the authoritative offboarding source (GitHub reports the
-- exact removal instant, rather than "sometime between the last two syncs"),
-- but it is an optional capability: an enterprise may not have audit log API
-- access, or the credential may lack `read:audit_log`. This row records BOTH
-- what was fetched and why it could not be, so the dashboard can name the
-- active source and its real coverage instead of implying completeness.
--
-- `covered_from`/`covered_through` bound the window the audit log has actually
-- been read for. seat-lifecycle-repo.ts uses them so `sync_diff` rows are only
-- suppressed inside that window — outside it, the snapshot diff is still the
-- only evidence there is.
CREATE TABLE IF NOT EXISTS copilot_seat_audit_sync_state (
  enterprise_slug TEXT PRIMARY KEY,
  status TEXT NOT NULL,           -- 'ok' | 'unavailable' | 'error'
  reason TEXT,                    -- human-readable explanation for the UI
  target TEXT,                    -- 'enterprise' | 'org' — which API answered
  covered_from TEXT,              -- earliest instant ever successfully fetched
  covered_through TEXT,           -- newest instant successfully fetched (watermark)
  last_event_at TEXT,             -- newest audit event observed
  last_synced_at TEXT NOT NULL,
  events_written INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0
);

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
