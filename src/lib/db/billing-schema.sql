-- GitHub Enterprise Billing Reports — Database Schema
-- Uses SQLite via better-sqlite3
-- Stores metered usage records, premium request records, daily aggregates, and sync state

-- ============================================================================
-- Metered Usage Records (from detailed + summarized billing reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- Deduplication index (upsert key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_dedup
  ON billing_usage_records(date, sku, organization, repository, username, workflow_path, cost_center_name);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_billing_usage_date ON billing_usage_records(date);
CREATE INDEX IF NOT EXISTS idx_billing_usage_product ON billing_usage_records(product);
CREATE INDEX IF NOT EXISTS idx_billing_usage_org ON billing_usage_records(organization);
CREATE INDEX IF NOT EXISTS idx_billing_usage_user ON billing_usage_records(username);
CREATE INDEX IF NOT EXISTS idx_billing_usage_scope ON billing_usage_records(charge_scope);
CREATE INDEX IF NOT EXISTS idx_billing_usage_date_product ON billing_usage_records(date, product);

-- ============================================================================
-- Premium Request Records (from premium_request billing reports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_premium_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  model TEXT DEFAULT '',
  exceeds_quota TEXT DEFAULT 'FALSE',
  total_monthly_quota REAL DEFAULT 0,
  charge_scope TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Deduplication index
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_premium_dedup
  ON billing_premium_requests(date, sku, username, organization, model);

-- Query indexes
CREATE INDEX IF NOT EXISTS idx_billing_premium_date ON billing_premium_requests(date);
CREATE INDEX IF NOT EXISTS idx_billing_premium_user ON billing_premium_requests(username);
CREATE INDEX IF NOT EXISTS idx_billing_premium_model ON billing_premium_requests(model);
CREATE INDEX IF NOT EXISTS idx_billing_premium_quota ON billing_premium_requests(exceeds_quota);
CREATE INDEX IF NOT EXISTS idx_billing_premium_org ON billing_premium_requests(organization);

-- ============================================================================
-- Daily Aggregate Cache (rebuilt after sync for fast chart queries)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_daily_aggregate (
  day TEXT NOT NULL,
  product TEXT NOT NULL,
  charge_scope TEXT NOT NULL DEFAULT 'org',
  total_quantity REAL DEFAULT 0,
  total_gross REAL DEFAULT 0,
  total_discount REAL DEFAULT 0,
  total_net REAL DEFAULT 0,
  record_count INTEGER DEFAULT 0,
  PRIMARY KEY (day, product, charge_scope)
);

CREATE INDEX IF NOT EXISTS idx_billing_daily_agg_day ON billing_daily_aggregate(day);

-- ============================================================================
-- Sync State Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_sync_state (
  report_type TEXT PRIMARY KEY,    -- 'detailed', 'summarized', 'premium_request'
  last_synced_at TEXT,
  last_report_start TEXT,
  last_report_end TEXT,
  status TEXT DEFAULT 'pending',   -- 'pending', 'syncing', 'ok', 'error'
  error_message TEXT
);
