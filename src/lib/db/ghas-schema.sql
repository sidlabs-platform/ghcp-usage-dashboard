-- GitHub Advanced Security (GHAS) Metrics - Database Schema
-- Uses SQLite via better-sqlite3
-- Stores alert caches for incremental sync and daily aggregates for UI queries

-- ============================================================================
-- Alert Cache Tables (lightweight, for incremental sync tracking)
-- ============================================================================

-- Code scanning alert cache
CREATE TABLE IF NOT EXISTS ghas_code_scanning_alerts (
  scope TEXT NOT NULL,            -- 'enterprise' or 'org'
  scope_id TEXT NOT NULL,         -- enterprise slug or org slug
  enterprise_slug TEXT NOT NULL DEFAULT '',
  alert_number INTEGER NOT NULL,
  repo_full_name TEXT,            -- e.g. 'org/repo'
  state TEXT NOT NULL,            -- 'open', 'dismissed', 'fixed'
  severity TEXT,                  -- 'critical', 'high', 'medium', 'low'
  rule_id TEXT,
  tool_name TEXT,                 -- e.g. 'CodeQL'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fixed_at TEXT,
  dismissed_at TEXT,
  dismissed_reason TEXT,
  autofix_status TEXT DEFAULT 'none',  -- 'none', 'available', 'committed'
  PRIMARY KEY (scope, scope_id, alert_number, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_code_scanning_updated
  ON ghas_code_scanning_alerts(scope, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_code_scanning_state
  ON ghas_code_scanning_alerts(scope, scope_id, state);

-- Dependabot alert cache
CREATE TABLE IF NOT EXISTS ghas_dependabot_alerts (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  alert_number INTEGER NOT NULL,
  repo_full_name TEXT,
  state TEXT NOT NULL,            -- 'open', 'dismissed', 'fixed', 'auto_dismissed'
  severity TEXT,                  -- 'critical', 'high', 'medium', 'low'
  ecosystem TEXT,                 -- 'npm', 'pip', 'maven', etc.
  package_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  fixed_at TEXT,
  dismissed_at TEXT,
  dismissed_reason TEXT,
  auto_dismissed_at TEXT,
  PRIMARY KEY (scope, scope_id, alert_number, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_dependabot_updated
  ON ghas_dependabot_alerts(scope, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_dependabot_state
  ON ghas_dependabot_alerts(scope, scope_id, state);

-- Secret scanning alert cache
CREATE TABLE IF NOT EXISTS ghas_secret_scanning_alerts (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  alert_number INTEGER NOT NULL,
  repo_full_name TEXT,
  state TEXT NOT NULL,            -- 'open', 'resolved'
  secret_type TEXT,
  secret_type_display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,                -- 'false_positive', 'revoked', etc.
  PRIMARY KEY (scope, scope_id, alert_number, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_secret_scanning_updated
  ON ghas_secret_scanning_alerts(scope, scope_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_secret_scanning_state
  ON ghas_secret_scanning_alerts(scope, scope_id, state);

-- ============================================================================
-- Daily Aggregate Tables (materialized, queried by UI)
-- ============================================================================

-- Code scanning daily aggregates
CREATE TABLE IF NOT EXISTS ghas_code_scanning_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  opened INTEGER DEFAULT 0,
  fixed INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  reopened INTEGER DEFAULT 0,
  total_open INTEGER DEFAULT 0,
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  autofix_available INTEGER DEFAULT 0,
  autofix_committed INTEGER DEFAULT 0,
  PRIMARY KEY (enterprise_slug, day, scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_code_scanning_daily_day
  ON ghas_code_scanning_daily(day);

-- Dependabot daily aggregates
CREATE TABLE IF NOT EXISTS ghas_dependabot_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  opened INTEGER DEFAULT 0,
  fixed INTEGER DEFAULT 0,
  dismissed INTEGER DEFAULT 0,
  auto_dismissed INTEGER DEFAULT 0,
  total_open INTEGER DEFAULT 0,
  severity_critical INTEGER DEFAULT 0,
  severity_high INTEGER DEFAULT 0,
  severity_medium INTEGER DEFAULT 0,
  severity_low INTEGER DEFAULT 0,
  ecosystem_counts TEXT DEFAULT '{}',
  PRIMARY KEY (enterprise_slug, day, scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_dependabot_daily_day
  ON ghas_dependabot_daily(day);

-- Secret scanning daily aggregates
CREATE TABLE IF NOT EXISTS ghas_secret_scanning_daily (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  opened INTEGER DEFAULT 0,
  resolved INTEGER DEFAULT 0,
  total_open INTEGER DEFAULT 0,
  resolution_counts TEXT DEFAULT '{}',  -- JSON: {"revoked":3,"false_positive":1}
  PRIMARY KEY (enterprise_slug, day, scope, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_secret_scanning_daily_day
  ON ghas_secret_scanning_daily(day);

-- ============================================================================
-- Sync State Table (for incremental sync)
-- ============================================================================

-- GHAS sync state tracking
CREATE TABLE IF NOT EXISTS ghas_sync_state (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  metric_type TEXT NOT NULL,      -- 'code_scanning', 'dependabot', 'secret_scanning'
  last_synced_at TEXT NOT NULL,
  last_alert_updated_at TEXT,     -- latest alert updated_at seen during sync
  total_alerts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',       -- 'ok', 'error', 'syncing'
  error_message TEXT,
  PRIMARY KEY (enterprise_slug, scope, scope_id, metric_type)
);

-- Indexes for enterprise_slug filtering
CREATE INDEX IF NOT EXISTS idx_ghas_code_scanning_alerts_slug ON ghas_code_scanning_alerts(enterprise_slug);
CREATE INDEX IF NOT EXISTS idx_ghas_dependabot_alerts_slug ON ghas_dependabot_alerts(enterprise_slug);
CREATE INDEX IF NOT EXISTS idx_ghas_secret_scanning_alerts_slug ON ghas_secret_scanning_alerts(enterprise_slug);
CREATE INDEX IF NOT EXISTS idx_ghas_code_scanning_daily_slug ON ghas_code_scanning_daily(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_ghas_dependabot_daily_slug ON ghas_dependabot_daily(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_ghas_secret_scanning_daily_slug ON ghas_secret_scanning_daily(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_ghas_sync_state_slug ON ghas_sync_state(enterprise_slug);
