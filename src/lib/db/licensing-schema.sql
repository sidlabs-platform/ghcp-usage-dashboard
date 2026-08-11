-- Historical licensing / AI-Credit reconciliation schema.
-- Uses SQLite via Node's built-in node:sqlite module.
--
-- Backward compatibility rules (see the "Backward Compatibility (Hard Rule)"
-- section of the project's Copilot instructions):
--   * Every table uses CREATE TABLE IF NOT EXISTS.
--   * No table here is ever dropped, renamed, or recreated by application code.
--   * These tables are purely additive: they never require dropping or
--     re-syncing `copilot_seats`, `billing_usage_records`, or
--     `billing_premium_requests`.
--   * Raw payloads (`raw_json` columns) are retained only for auditability;
--     callers must never place credentials/tokens into them.

-- ============================================================================
-- Audit Events (append-only source-of-truth for seat assignment history)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_audit_events (
  enterprise_slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  org_login TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  github_user_id INTEGER,
  observed_login TEXT,
  external_identity TEXT,
  assigned_via TEXT,
  source TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (enterprise_slug, event_id)
);

CREATE INDEX IF NOT EXISTS idx_license_audit_events_period
  ON license_audit_events(enterprise_slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_license_audit_events_user
  ON license_audit_events(enterprise_slug, github_user_id);

-- ============================================================================
-- Identity Records (resolved login / external identity per identity_key)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_identity_records (
  enterprise_slug TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  github_user_id INTEGER,
  resolved_login TEXT,
  external_identity TEXT,
  account_state TEXT NOT NULL DEFAULT 'unknown',
  resolution_source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (enterprise_slug, identity_key, resolution_source)
);

CREATE INDEX IF NOT EXISTS idx_license_identity_records_user
  ON license_identity_records(enterprise_slug, github_user_id);
CREATE INDEX IF NOT EXISTS idx_license_identity_records_external
  ON license_identity_records(enterprise_slug, external_identity);

-- ============================================================================
-- Seat Snapshots (per-period, per-org, per-holder authoritative seat state)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_seat_snapshots (
  enterprise_slug TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  org_login TEXT NOT NULL DEFAULT '',
  holder_key TEXT NOT NULL,
  github_user_id INTEGER,
  observed_login TEXT,
  plan_type TEXT NOT NULL DEFAULT 'unknown',
  assigned_via TEXT NOT NULL DEFAULT 'direct',
  last_activity_at TEXT,
  pending_cancellation_date TEXT,
  snapshot_at TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (enterprise_slug, billing_period, org_login, holder_key)
);

CREATE INDEX IF NOT EXISTS idx_license_seat_snapshots_period
  ON license_seat_snapshots(enterprise_slug, billing_period);
CREATE INDEX IF NOT EXISTS idx_license_seat_snapshots_user
  ON license_seat_snapshots(enterprise_slug, github_user_id);

-- ============================================================================
-- Org Billing Snapshots (per-period, per-org seat totals)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_org_billing_snapshots (
  enterprise_slug TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  org_login TEXT NOT NULL,
  plan_type TEXT,
  total_seats INTEGER NOT NULL DEFAULT 0,
  pending_cancellation INTEGER NOT NULL DEFAULT 0,
  observed_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (enterprise_slug, billing_period, org_login)
);

CREATE INDEX IF NOT EXISTS idx_license_org_billing_snapshots_period
  ON license_org_billing_snapshots(enterprise_slug, billing_period);

-- ============================================================================
-- AI-Credit Consumption (per-period, per-org, per-holder, per-source)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_aic_consumption (
  enterprise_slug TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  org_login TEXT NOT NULL DEFAULT '',
  holder_key TEXT NOT NULL,
  username TEXT,
  credits REAL NOT NULL DEFAULT 0,
  gross_usd REAL NOT NULL DEFAULT 0,
  net_usd REAL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (enterprise_slug, billing_period, org_login, holder_key, source)
);

CREATE INDEX IF NOT EXISTS idx_license_aic_consumption_period
  ON license_aic_consumption(enterprise_slug, billing_period);
CREATE INDEX IF NOT EXISTS idx_license_aic_consumption_holder
  ON license_aic_consumption(enterprise_slug, billing_period, holder_key);

-- ============================================================================
-- Materialized Period Rows (canonical, query-ready reconciliation grain)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_period_rows (
  enterprise_slug TEXT NOT NULL,
  billing_period TEXT NOT NULL,
  -- Canonical sentinel for "no attributed org" (see normalizeOrgLogin() in
  -- license-history-repo.ts): never the empty string, so GROUP_CONCAT/COUNT
  -- DISTINCT in the rollup query always agree on unattributed holders.
  org_login TEXT NOT NULL DEFAULT '(unattributed)',
  holder_key TEXT NOT NULL,
  github_user_id INTEGER,
  user_login TEXT,
  resolved_user_login TEXT,
  external_identity TEXT,
  identity_resolution_source TEXT NOT NULL,
  account_state TEXT NOT NULL DEFAULT 'unknown',
  license_assigned_date TEXT,
  user_revoked_date TEXT,
  plan_type TEXT NOT NULL DEFAULT 'unknown',
  seat_status TEXT NOT NULL,
  assigned_via TEXT NOT NULL,
  last_activity_at TEXT,
  license_cost REAL NOT NULL DEFAULT 0,
  default_aic_credits REAL NOT NULL DEFAULT 0,
  default_aic_usd REAL NOT NULL DEFAULT 0,
  aic_assigned_usd REAL NOT NULL DEFAULT 0,
  aic_assigned_rule TEXT NOT NULL,
  aic_consumed_credits REAL NOT NULL DEFAULT 0,
  aic_consumed_usd REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  row_source TEXT NOT NULL,
  consumption_source TEXT,
  history_confidence TEXT NOT NULL,
  data_quality_notes TEXT NOT NULL DEFAULT '[]',
  as_of_utc TEXT NOT NULL,
  generated_at_utc TEXT NOT NULL,
  PRIMARY KEY (enterprise_slug, billing_period, org_login, holder_key)
);

CREATE INDEX IF NOT EXISTS idx_license_period_rows_period
  ON license_period_rows(enterprise_slug, billing_period);
CREATE INDEX IF NOT EXISTS idx_license_period_rows_login
  ON license_period_rows(enterprise_slug, resolved_user_login);
CREATE INDEX IF NOT EXISTS idx_license_period_rows_user
  ON license_period_rows(enterprise_slug, github_user_id);
CREATE INDEX IF NOT EXISTS idx_license_period_rows_org
  ON license_period_rows(enterprise_slug, billing_period, org_login);
CREATE INDEX IF NOT EXISTS idx_license_period_rows_confidence
  ON license_period_rows(enterprise_slug, history_confidence);
-- Expression index matching the rollup query's exact GROUP BY key
-- (COALESCE(NULLIF(resolved_user_login, ''), holder_key)) so the query
-- planner can use it instead of a full scan+sort for the rollup view.
CREATE INDEX IF NOT EXISTS idx_license_period_rows_rollup_group
  ON license_period_rows(enterprise_slug, (COALESCE(NULLIF(resolved_user_login, ''), holder_key)));

-- ============================================================================
-- Reconciliation Runs (durable diagnostics for each sync/reconciliation pass)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_reconciliation_runs (
  id TEXT PRIMARY KEY,
  enterprise_slug TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  requested_periods TEXT NOT NULL DEFAULT '[]',
  source_stats TEXT NOT NULL DEFAULT '{}',
  unresolved_identities TEXT NOT NULL DEFAULT '[]',
  warnings TEXT NOT NULL DEFAULT '[]',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_license_reconciliation_runs_started
  ON license_reconciliation_runs(enterprise_slug, started_at);
CREATE INDEX IF NOT EXISTS idx_license_reconciliation_runs_status
  ON license_reconciliation_runs(enterprise_slug, status);

-- ============================================================================
-- Reconciliation Checks (per-run validation results)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_reconciliation_checks (
  run_id TEXT NOT NULL,
  check_name TEXT NOT NULL,
  billing_period TEXT NOT NULL DEFAULT '',
  org_login TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  expected_value REAL,
  actual_value REAL,
  message TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, check_name, billing_period, org_login),
  FOREIGN KEY (run_id) REFERENCES license_reconciliation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_license_reconciliation_checks_status
  ON license_reconciliation_checks(run_id, status);

-- ============================================================================
-- Source Sync State (per-enterprise, per-source, per-period sync tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS license_source_sync_state (
  enterprise_slug TEXT NOT NULL,
  source TEXT NOT NULL,
  billing_period TEXT NOT NULL DEFAULT '',
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  coverage_start TEXT,
  coverage_end TEXT,
  error_message TEXT,
  PRIMARY KEY (enterprise_slug, source, billing_period)
);

CREATE INDEX IF NOT EXISTS idx_license_source_sync_state_status
  ON license_source_sync_state(enterprise_slug, status);
