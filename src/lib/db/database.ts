// SQLite database setup using Node's built-in node:sqlite module.

import path from "path";
import fs from "fs";
import { migrateCopilotAppMetrics } from "./copilot-app-migration";
import { migrateSummaryCacheClassification } from "./summary-cache-migration";
import { SqliteDatabase } from "./sqlite-database";

const DB_PATH = path.join(process.cwd(), "data", "copilot-metrics.db");
const SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
const GHAS_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "ghas-schema.sql");
const SUMMARY_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
const BILLING_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "billing-schema.sql");
const LICENSING_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "licensing-schema.sql");

let _db: SqliteDatabase | null = null;

export function getDb(): SqliteDatabase {
  if (_db) return _db;

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new SqliteDatabase(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const ghasSchema = fs.readFileSync(GHAS_SCHEMA_PATH, "utf-8");
  const summarySchema = fs.readFileSync(SUMMARY_SCHEMA_PATH, "utf-8");
  const billingSchema = fs.readFileSync(BILLING_SCHEMA_PATH, "utf-8");
  const licensingSchema = fs.readFileSync(LICENSING_SCHEMA_PATH, "utf-8");

  // Add columns introduced after initial schema (safe if already present).
  // MUST run BEFORE schema exec: the schema files include CREATE INDEX statements
  // that reference enterprise_slug. On pre-multi-enterprise DBs, running schema
  // first would fail ("no such column: enterprise_slug") before these ALTERs
  // can add the columns. On fresh DBs, the ALTERs fail silently (tables don't
  // exist yet) and the subsequent schema exec creates them with the column.
  const migrations = [
    "ALTER TABLE user_daily_metrics ADD COLUMN used_copilot_coding_agent INTEGER DEFAULT 0",
    // Multi-enterprise support: add enterprise_slug to all tables
    "ALTER TABLE enterprise_daily_metrics ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE org_daily_metrics ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE user_daily_metrics ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE copilot_seats ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE team_memberships ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE sync_log ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    // GHAS tables
    "ALTER TABLE ghas_code_scanning_alerts ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_dependabot_alerts ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_secret_scanning_alerts ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_code_scanning_daily ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_dependabot_daily ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_secret_scanning_daily ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE ghas_sync_state ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    // Billing tables
    "ALTER TABLE billing_usage_records ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE billing_premium_requests ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE billing_daily_aggregate ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE billing_sync_state ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    // Token usage fields for premium requests
    "ALTER TABLE billing_premium_requests ADD COLUMN input_tokens REAL NOT NULL DEFAULT 0",
    "ALTER TABLE billing_premium_requests ADD COLUMN output_tokens REAL NOT NULL DEFAULT 0",
    "ALTER TABLE billing_premium_requests ADD COLUMN cached_tokens REAL NOT NULL DEFAULT 0",
    // AI Credits migration: new columns on premium_requests table
    "ALTER TABLE billing_premium_requests ADD COLUMN cost_center_name TEXT DEFAULT ''",
    "ALTER TABLE billing_premium_requests ADD COLUMN aic_quantity REAL NOT NULL DEFAULT 0",
    "ALTER TABLE billing_premium_requests ADD COLUMN aic_gross_amount REAL NOT NULL DEFAULT 0",
    // Per-model token breakdown (AI usage report, 2026-08-11) + the `repository`
    // column that report emits. `repository` must participate in the dedup key,
    // so the old narrower unique index is dropped here and billing-schema.sql
    // recreates it as `idx_billing_premium_dedup_v2`.
    "ALTER TABLE billing_premium_requests ADD COLUMN repository TEXT DEFAULT ''",
    "ALTER TABLE billing_premium_requests ADD COLUMN cache_read_tokens REAL NOT NULL DEFAULT 0",
    "ALTER TABLE billing_premium_requests ADD COLUMN cache_write_tokens REAL NOT NULL DEFAULT 0",
    "DROP INDEX IF EXISTS idx_billing_premium_dedup",
    // A SKU can be billed in more than one unit on the same day
    // (`copilot_ai_credit` emits both `ai-credits` and `token-units`), so
    // `product`/`unit_type` must participate in the usage dedup key. The old
    // narrower index is dropped here and billing-schema.sql recreates it as
    // `idx_billing_usage_dedup_v2`.
    "DROP INDEX IF EXISTS idx_billing_usage_dedup",
    // Summary tables
    "ALTER TABLE user_period_summary ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE daily_aggregate_cache ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE team_summary_cache ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    // AI adoption cohorts
    "ALTER TABLE enterprise_daily_metrics ADD COLUMN totals_by_ai_adoption_phase TEXT DEFAULT '[]'",
    "ALTER TABLE org_daily_metrics ADD COLUMN totals_by_ai_adoption_phase TEXT DEFAULT '[]'",
    "ALTER TABLE user_daily_metrics ADD COLUMN ai_adoption_phase TEXT",
    // Usage Metrics API user-level AI Credits
    "ALTER TABLE user_daily_metrics ADD COLUMN ai_credits_used REAL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { _db.exec(sql); } catch { /* column already exists or table not yet created */ }
  }

  // Now safe to run schema files (CREATE TABLE IF NOT EXISTS + CREATE INDEX).
  _db.exec(schema);
  _db.exec(ghasSchema);
  _db.exec(summarySchema);
  _db.exec(billingSchema);

  // Historical licensing/AI-Credit reconciliation tables. New, additive, and
  // independent of the legacy PK migration below: they are created here for
  // the first time with their final schema (no pre-multi-enterprise rows
  // exist for them), so they never need to be part of `tablesToRecreate` or
  // the enterprise_slug legacy backfill.
  _db.exec(licensingSchema);

  // Additive, idempotent Copilot App usage metrics migration (adds columns +
  // backfills from raw_json on already-synced tables). Kept separate from the
  // broad try/catch migrations list above since it has its own internal
  // idempotency and column-existence checks.
  //
  // If this throws, `_db` must NOT be left cached: a later getDb() call would
  // otherwise hand back a handle whose schema migration never completed. Close
  // the handle, reset the module-level cache, and rethrow the original error
  // so callers see the real failure instead of silently continuing with a
  // partially-migrated database.
  try {
    migrateCopilotAppMetrics(_db);
  } catch (err) {
    try {
      _db.close();
    } catch {
      /* best-effort close; the original migration error is what matters */
    }
    _db = null;
    throw err;
  }

  const userMetricColumns = _db.prepare("PRAGMA table_info(user_daily_metrics)").all() as { name: string }[];
  const hasAiCreditsColumn = userMetricColumns.some((col) => col.name === "ai_credits_used");
  const hasRawJsonColumn = userMetricColumns.some((col) => col.name === "raw_json");
  if (hasAiCreditsColumn && hasRawJsonColumn) {
    _db.exec(`
      UPDATE user_daily_metrics
      SET ai_credits_used = CAST(json_extract(raw_json, '$.ai_credits_used') AS REAL)
      WHERE COALESCE(ai_credits_used, 0) = 0
        AND raw_json IS NOT NULL
        AND json_valid(raw_json)
        AND json_extract(raw_json, '$.ai_credits_used') IS NOT NULL
        AND COALESCE(CAST(json_extract(raw_json, '$.ai_credits_used') AS REAL), 0) <> 0
    `);
  }
  // Note: Run ANALYZE after bulk inserts (e.g. after sync) to update query planner stats

  // Migration: recreate tables that need enterprise_slug in PRIMARY KEY.
  // All affected tables contain derived/cacheable data rebuilt during sync.
  // Check if migration is needed by examining billing_sync_state PK definition.
  const needsPKMigration = (() => {
    try {
      const row = _db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='billing_sync_state'`
      ).get() as { sql: string } | undefined;
      // Old schema has `report_type TEXT PRIMARY KEY` (single column)
      // New schema has `PRIMARY KEY (enterprise_slug, report_type)`
      return row && !row.sql.includes("PRIMARY KEY (enterprise_slug");
    } catch { return false; }
  })();

  if (needsPKMigration) {
    console.log("[DB Migration] Recreating tables to add enterprise_slug to primary keys...");
    const tablesToRecreate = [
      // Billing tables
      "billing_sync_state",
      "billing_daily_aggregate",
      "billing_usage_records",
      "billing_premium_requests",
      // Summary tables
      "daily_aggregate_cache",
      "user_period_summary",
      "team_summary_cache",
      // Main schema tables
      "copilot_seats",
      "team_memberships",
      "sync_log",
      // GHAS tables
      "ghas_code_scanning_daily",
      "ghas_dependabot_daily",
      "ghas_secret_scanning_daily",
      "ghas_sync_state",
    ];
    // Drop old dedup indexes that need enterprise_slug
    _db.exec(`DROP INDEX IF EXISTS idx_billing_usage_dedup`);
    _db.exec(`DROP INDEX IF EXISTS idx_billing_premium_dedup`);
    // Validate table names against whitelist before interpolation (security best practice).
    // NOTE: Never allow user-controlled values into tablesToRecreate.
    const ALLOWED_MIGRATION_TABLES = new Set([
      "ghas_code_scanning_alerts", "ghas_dependabot_alerts", "ghas_secret_scanning_alerts",
      "billing_sync_state", "billing_daily_aggregate", "billing_usage_records", "billing_premium_requests",
      "daily_aggregate_cache", "user_period_summary", "team_summary_cache",
      "copilot_seats", "team_memberships", "sync_log",
      "ghas_code_scanning_daily", "ghas_dependabot_daily", "ghas_secret_scanning_daily", "ghas_sync_state",
    ]);
    for (const table of tablesToRecreate) {
      if (!ALLOWED_MIGRATION_TABLES.has(table)) {
        throw new Error(`[DB Migration] Refusing to drop unknown table: ${table}`);
      }
      _db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    // Re-run all schema files to recreate with correct PKs
    _db.exec(schema);
    _db.exec(ghasSchema);
    _db.exec(summarySchema);
    _db.exec(billingSchema);
    console.log("[DB Migration] Tables recreated. Please run a full sync to repopulate data.");
  }

  // One-time, idempotent recompute of classification-dependent summary/cache
  // columns (user_period_summary.acceptance_rate, daily_aggregate_cache's
  // completion_loc_suggested/completion_loc_accepted, and
  // team_summary_cache.overall_acceptance_rate) that may have been persisted
  // under the old, looser completion-allowlist semantics. Runs transactionally
  // and records its own ledger entry in summary_cache_migrations — see
  // summary-cache-migration.ts. Uses the exact same fail-closed handling as
  // migrateCopilotAppMetrics above: on error, do not leave a cached `_db`
  // whose migration never completed.
  //
  // MUST run AFTER the needsPKMigration block above: that block can DROP
  // TABLE and recreate daily_aggregate_cache/user_period_summary/
  // team_summary_cache (see tablesToRecreate). Running the classification
  // recompute before that point would (a) waste the work, since the tables
  // it just wrote get dropped immediately afterward, and (b) still record
  // the migration as "applied" in the summary_cache_migrations ledger table
  // — which is NOT among the dropped/recreated tables — so it would never
  // re-run against the freshly recreated (empty) tables. Running it here
  // ensures it always operates on the final, post-migration schema/data.
  try {
    migrateSummaryCacheClassification(_db);
  } catch (err) {
    try {
      _db.close();
    } catch {
      /* best-effort close; the original migration error is what matters */
    }
    _db = null;
    throw err;
  }

  // Backfill enterprise_slug on legacy rows (created before multi-enterprise support).
  // Only safe when the user has exactly one enterprise configured — otherwise we cannot
  // know which enterprise the legacy row belonged to.
  try {
    const legacySlug = process.env.GITHUB_ENTERPRISE;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = require("@/lib/config/enterprise-config") as typeof import("@/lib/config/enterprise-config");
    const configured = cfg.getConfiguredEnterprises();
    const targetSlug = configured.length === 1 ? configured[0].slug : (legacySlug || null);

    if (targetSlug) {
      const tablesWithSlug = [
        "enterprise_daily_metrics",
        "org_daily_metrics",
        "user_daily_metrics",
        "copilot_seats",
        "team_memberships",
        "sync_log",
        "ghas_code_scanning_alerts",
        "ghas_dependabot_alerts",
        "ghas_secret_scanning_alerts",
        "ghas_code_scanning_daily",
        "ghas_dependabot_daily",
        "ghas_secret_scanning_daily",
        "ghas_sync_state",
        "billing_usage_records",
        "billing_premium_requests",
        "billing_daily_aggregate",
        "billing_sync_state",
        "user_period_summary",
        "daily_aggregate_cache",
        "team_summary_cache",
      ];
      // Validate table names against whitelist before interpolation (security best practice)
      const ALLOWED_BACKFILL_TABLES = new Set([
        "enterprise_daily_metrics", "org_daily_metrics", "user_daily_metrics",
        "copilot_seats", "team_memberships", "sync_log",
        "ghas_code_scanning_alerts", "ghas_dependabot_alerts", "ghas_secret_scanning_alerts",
        "ghas_code_scanning_daily", "ghas_dependabot_daily", "ghas_secret_scanning_daily", "ghas_sync_state",
        "billing_usage_records", "billing_premium_requests", "billing_daily_aggregate", "billing_sync_state",
        "user_period_summary", "daily_aggregate_cache", "team_summary_cache",
      ]);
      let totalUpdated = 0;
      const backfillTx = _db.transaction(() => {
        for (const table of tablesWithSlug) {
          if (!ALLOWED_BACKFILL_TABLES.has(table)) {
            throw new Error(`[DB Migration] Refusing to update unknown table: ${table}`);
          }
          try {
            const result = _db!.prepare(
              `UPDATE ${table} SET enterprise_slug = ? WHERE enterprise_slug = '' OR enterprise_slug IS NULL`
            ).run(targetSlug);
            totalUpdated += result.changes;
          } catch { /* table may not exist yet */ }
        }
      });
      backfillTx();
      if (totalUpdated > 0) {
        console.log(`[DB Migration] Backfilled enterprise_slug='${targetSlug}' on ${totalUpdated} legacy rows`);
      }

      // Also seed enterprise_registry for the configured enterprise so UI shows display name
      try {
        const displayName = configured[0]?.displayName || targetSlug;
        _db.prepare(
          `INSERT INTO enterprise_registry (slug, display_name) VALUES (?, ?)
           ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name`
        ).run(targetSlug, displayName);
      } catch { /* registry may not exist */ }
    }
  } catch (err) {
    console.warn("[DB] Enterprise slug backfill skipped:", err instanceof Error ? err.message : err);
  }

  // Backfill chat_panel_*_mode columns from totals_by_feature JSON for already-synced data.
  // The original sync code assumed these were top-level API fields, but they come from
  // totals_by_feature entries (e.g. feature="chat_panel_ask_mode").
  try {
    const CHAT_MODE_FEATURES = [
      { feature: "chat_panel_ask_mode", column: "chat_panel_ask_mode" },
      { feature: "chat_panel_edit_mode", column: "chat_panel_edit_mode" },
      { feature: "chat_panel_plan_mode", column: "chat_panel_plan_mode" },
      { feature: "chat_panel_agent_mode", column: "chat_panel_agent_mode" },
      { feature: "chat_panel_custom_mode", column: "chat_panel_custom_mode" },
      { feature: "chat_panel_unknown_mode", column: "chat_panel_unknown_mode" },
    ];

    // Only backfill if there are rows with zero chat modes but non-empty totals_by_feature
    const needsBackfill = _db.prepare(`
      SELECT COUNT(*) as cnt FROM user_daily_metrics
      WHERE chat_panel_ask_mode = 0 AND chat_panel_edit_mode = 0
        AND chat_panel_plan_mode = 0 AND chat_panel_agent_mode = 0
        AND chat_panel_custom_mode = 0 AND chat_panel_unknown_mode = 0
        AND totals_by_feature IS NOT NULL AND totals_by_feature != '[]'
    `).get() as { cnt: number };

    if (needsBackfill.cnt > 0) {
      const rows = _db.prepare(`
        SELECT rowid, totals_by_feature FROM user_daily_metrics
        WHERE chat_panel_ask_mode = 0 AND chat_panel_edit_mode = 0
          AND chat_panel_plan_mode = 0 AND chat_panel_agent_mode = 0
          AND chat_panel_custom_mode = 0 AND chat_panel_unknown_mode = 0
          AND totals_by_feature IS NOT NULL AND totals_by_feature != '[]'
      `).all() as { rowid: number; totals_by_feature: string }[];

      const updateStmt = _db.prepare(`
        UPDATE user_daily_metrics SET
          chat_panel_ask_mode = ?, chat_panel_edit_mode = ?,
          chat_panel_plan_mode = ?, chat_panel_agent_mode = ?,
          chat_panel_custom_mode = ?, chat_panel_unknown_mode = ?
        WHERE rowid = ?
      `);

      const backfillTx = _db.transaction(() => {
        let updated = 0;
        for (const row of rows) {
          try {
            const features = JSON.parse(row.totals_by_feature) as { feature: string; user_initiated_interaction_count?: number }[];
            const counts: Record<string, number> = {};
            for (const f of features) {
              const match = CHAT_MODE_FEATURES.find(m => m.feature === f.feature);
              if (match) {
                counts[match.column] = (counts[match.column] || 0) + (f.user_initiated_interaction_count || 0);
              }
            }
            const hasData = Object.values(counts).some(v => v > 0);
            if (hasData) {
              updateStmt.run(
                counts.chat_panel_ask_mode || 0,
                counts.chat_panel_edit_mode || 0,
                counts.chat_panel_plan_mode || 0,
                counts.chat_panel_agent_mode || 0,
                counts.chat_panel_custom_mode || 0,
                counts.chat_panel_unknown_mode || 0,
                row.rowid
              );
              updated++;
            }
          } catch { /* skip malformed JSON rows */ }
        }
        if (updated > 0) {
          console.log(`[DB] Backfilled chat mode columns for ${updated} user_daily_metrics rows`);
        }
      });
      backfillTx();
    }
  } catch (err) {
    console.warn("[DB] Chat mode backfill skipped:", err instanceof Error ? err.message : err);
  }

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
