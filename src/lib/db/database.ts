// SQLite database setup using better-sqlite3

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "data", "copilot-metrics.db");
const SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
const GHAS_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "ghas-schema.sql");
const SUMMARY_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "summary-schema.sql");
const BILLING_SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "db", "billing-schema.sql");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Run schema migrations
  const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
  _db.exec(schema);

  // GHAS schema
  const ghasSchema = fs.readFileSync(GHAS_SCHEMA_PATH, "utf-8");
  _db.exec(ghasSchema);

  // Summary tables schema
  const summarySchema = fs.readFileSync(SUMMARY_SCHEMA_PATH, "utf-8");
  _db.exec(summarySchema);

  // Billing schema
  const billingSchema = fs.readFileSync(BILLING_SCHEMA_PATH, "utf-8");
  _db.exec(billingSchema);

  // Note: Run ANALYZE after bulk inserts (e.g. after sync) to update query planner stats

  // Add columns introduced after initial schema (safe if already present)
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
    // Summary tables
    "ALTER TABLE user_period_summary ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE daily_aggregate_cache ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE team_summary_cache ADD COLUMN enterprise_slug TEXT NOT NULL DEFAULT ''",
  ];
  for (const sql of migrations) {
    try { _db.exec(sql); } catch { /* column already exists */ }
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
