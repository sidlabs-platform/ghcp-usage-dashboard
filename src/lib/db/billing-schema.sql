-- GitHub Enterprise Billing Reports — Database Schema
-- Uses SQLite via Node's built-in node:sqlite module
-- Stores metered usage records, premium request records, daily aggregates, and sync state

-- ============================================================================
-- Metered Usage Records (from detailed + summarized billing reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  product TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_type TEXT DEFAULT '',
  applied_cost_per_quantity REAL DEFAULT 0,
  gross_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  organization TEXT DEFAULT '',
  repository TEXT DEFAULT '',
  username TEXT DEFAULT '',
  workflow_path TEXT DEFAULT '',
  cost_center_name TEXT DEFAULT '',
  charge_scope TEXT NOT NULL DEFAULT 'org',   -- 'user' or 'org'
  created_at TEXT DEFAULT (datetime('now'))
);

-- Deduplication index (upsert key) — includes enterprise_slug for multi-enterprise
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_dedup
  ON billing_usage_records(enterprise_slug, date, sku, organization, repository, username, workflow_path, cost_center_name);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_billing_usage_date ON billing_usage_records(date);
CREATE INDEX IF NOT EXISTS idx_billing_usage_product ON billing_usage_records(product);
CREATE INDEX IF NOT EXISTS idx_billing_usage_org ON billing_usage_records(organization);
CREATE INDEX IF NOT EXISTS idx_billing_usage_user ON billing_usage_records(username);
CREATE INDEX IF NOT EXISTS idx_billing_usage_scope ON billing_usage_records(charge_scope);
CREATE INDEX IF NOT EXISTS idx_billing_usage_date_product ON billing_usage_records(date, product);

-- ============================================================================
-- Premium Request / AI Credit Records (from premium_request and ai_credit billing reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_premium_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enterprise_slug TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  product TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_type TEXT DEFAULT '',
  applied_cost_per_quantity REAL DEFAULT 0,
  gross_amount REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  username TEXT DEFAULT '',
  organization TEXT DEFAULT '',
  repository TEXT DEFAULT '',
  model TEXT DEFAULT '',
  exceeds_quota TEXT DEFAULT 'FALSE',
  total_monthly_quota REAL DEFAULT 0,
  charge_scope TEXT NOT NULL DEFAULT 'user',
  input_tokens REAL NOT NULL DEFAULT 0,
  output_tokens REAL NOT NULL DEFAULT 0,
  cached_tokens REAL NOT NULL DEFAULT 0,
  cache_read_tokens REAL NOT NULL DEFAULT 0,
  cache_write_tokens REAL NOT NULL DEFAULT 0,
  cost_center_name TEXT DEFAULT '',
  aic_quantity REAL NOT NULL DEFAULT 0,
  aic_gross_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Deduplication index — includes enterprise_slug for multi-enterprise.
--
-- `repository` is part of the key: the AI usage report emits separate rows per
-- repository for repo-scoped SKUs (code_quality_ai_credit, coding_agent_ai_credit).
-- Without it, a live octodemo export collapsed 1174 rows into 448 via
-- INSERT OR REPLACE, silently discarding ~14% of AI credits. The older
-- `idx_billing_premium_dedup` index is dropped in database.ts migrations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_premium_dedup_v2
  ON billing_premium_requests(enterprise_slug, date, sku, username, organization, repository, model);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_billing_premium_date ON billing_premium_requests(date);
CREATE INDEX IF NOT EXISTS idx_billing_premium_user ON billing_premium_requests(username);
CREATE INDEX IF NOT EXISTS idx_billing_premium_model ON billing_premium_requests(model);
CREATE INDEX IF NOT EXISTS idx_billing_premium_quota ON billing_premium_requests(exceeds_quota);
CREATE INDEX IF NOT EXISTS idx_billing_premium_org ON billing_premium_requests(organization);
-- Supports the per-model token rollups on the Token Usage page
CREATE INDEX IF NOT EXISTS idx_billing_premium_slug_date_model
  ON billing_premium_requests(enterprise_slug, date, model);

-- ============================================================================
-- Daily Aggregate Cache (rebuilt after sync for fast chart queries)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_daily_aggregate (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  product TEXT NOT NULL,
  charge_scope TEXT NOT NULL DEFAULT 'org',
  total_quantity REAL DEFAULT 0,
  total_gross REAL DEFAULT 0,
  total_discount REAL DEFAULT 0,
  total_net REAL DEFAULT 0,
  record_count INTEGER DEFAULT 0,
  PRIMARY KEY (enterprise_slug, day, product, charge_scope)
);

CREATE INDEX IF NOT EXISTS idx_billing_daily_agg_day ON billing_daily_aggregate(day);

-- ============================================================================
-- Sync State Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_sync_state (
  enterprise_slug TEXT NOT NULL DEFAULT '',
  report_type TEXT NOT NULL,    -- 'detailed', 'summarized', 'premium_request'
  last_synced_at TEXT,
  last_report_start TEXT,
  last_report_end TEXT,
  status TEXT DEFAULT 'pending',   -- 'pending', 'syncing', 'ok', 'error'
  error_message TEXT,
  PRIMARY KEY (enterprise_slug, report_type)
);

-- Indexes for enterprise_slug filtering
CREATE INDEX IF NOT EXISTS idx_billing_usage_slug ON billing_usage_records(enterprise_slug, date);
CREATE INDEX IF NOT EXISTS idx_billing_premium_slug ON billing_premium_requests(enterprise_slug, date);
CREATE INDEX IF NOT EXISTS idx_billing_daily_agg_slug ON billing_daily_aggregate(enterprise_slug, day);
CREATE INDEX IF NOT EXISTS idx_billing_sync_state_slug ON billing_sync_state(enterprise_slug);
