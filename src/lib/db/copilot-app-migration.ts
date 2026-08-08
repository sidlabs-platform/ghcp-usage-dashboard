// Additive, idempotent migration for Copilot App usage columns.
//
// Adds `daily_active_copilot_app_users` / `totals_by_copilot_app` to the
// enterprise/org aggregate tables and `used_copilot_app` / `totals_by_copilot_app`
// to the user-level table, then backfills each column independently from any
// previously stored `raw_json` snapshot. Never drops or recreates tables, never
// requires a re-sync, and is safe to invoke on every `getDb()` call.

import type Database from "better-sqlite3";

/** Tables this migration ever touches. Never derived from user input. */
const TARGET_TABLES = ["enterprise_daily_metrics", "org_daily_metrics", "user_daily_metrics"] as const;
type TargetTable = (typeof TARGET_TABLES)[number];

interface ColumnMigration {
  readonly table: TargetTable;
  readonly column: string;
  readonly addColumnSql: string;
}

// Fixed allowlist of columns to add. Every table/column/DDL fragment here is a
// hard-coded literal — no part of this list is ever built from user input.
const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  {
    table: "enterprise_daily_metrics",
    column: "daily_active_copilot_app_users",
    addColumnSql: "ALTER TABLE enterprise_daily_metrics ADD COLUMN daily_active_copilot_app_users INTEGER DEFAULT NULL",
  },
  {
    table: "enterprise_daily_metrics",
    column: "totals_by_copilot_app",
    addColumnSql: "ALTER TABLE enterprise_daily_metrics ADD COLUMN totals_by_copilot_app TEXT DEFAULT NULL",
  },
  {
    table: "org_daily_metrics",
    column: "daily_active_copilot_app_users",
    addColumnSql: "ALTER TABLE org_daily_metrics ADD COLUMN daily_active_copilot_app_users INTEGER DEFAULT NULL",
  },
  {
    table: "org_daily_metrics",
    column: "totals_by_copilot_app",
    addColumnSql: "ALTER TABLE org_daily_metrics ADD COLUMN totals_by_copilot_app TEXT DEFAULT NULL",
  },
  {
    table: "user_daily_metrics",
    column: "used_copilot_app",
    addColumnSql: "ALTER TABLE user_daily_metrics ADD COLUMN used_copilot_app INTEGER DEFAULT NULL",
  },
  {
    table: "user_daily_metrics",
    column: "totals_by_copilot_app",
    addColumnSql: "ALTER TABLE user_daily_metrics ADD COLUMN totals_by_copilot_app TEXT DEFAULT NULL",
  },
];

type BackfillValueKind = "integer" | "raw";

interface BackfillMigration {
  readonly table: TargetTable;
  readonly column: string;
  readonly jsonPath: string;
  readonly valueKind: BackfillValueKind;
}

// Each backfill is independent: it only reads its own JSON path and only
// writes when its own target column is still NULL. A column that is present
// in raw_json backfills even when a sibling column (e.g. the boolean/active
// user flag) is absent from that same raw_json, and vice versa.
const BACKFILL_MIGRATIONS: readonly BackfillMigration[] = [
  {
    table: "enterprise_daily_metrics",
    column: "daily_active_copilot_app_users",
    jsonPath: "$.daily_active_copilot_app_users",
    valueKind: "integer",
  },
  {
    table: "enterprise_daily_metrics",
    column: "totals_by_copilot_app",
    jsonPath: "$.totals_by_copilot_app",
    valueKind: "raw",
  },
  {
    table: "org_daily_metrics",
    column: "daily_active_copilot_app_users",
    jsonPath: "$.daily_active_copilot_app_users",
    valueKind: "integer",
  },
  {
    table: "org_daily_metrics",
    column: "totals_by_copilot_app",
    jsonPath: "$.totals_by_copilot_app",
    valueKind: "raw",
  },
  {
    // json_extract of a JSON boolean already yields SQLite 0/1, so "raw" is
    // sufficient here and preserves `false` (0) distinctly from absent (NULL).
    table: "user_daily_metrics",
    column: "used_copilot_app",
    jsonPath: "$.used_copilot_app",
    valueKind: "raw",
  },
  {
    table: "user_daily_metrics",
    column: "totals_by_copilot_app",
    jsonPath: "$.totals_by_copilot_app",
    valueKind: "raw",
  },
];

function tableExists(db: Database.Database, table: TargetTable): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return !!row;
}

function columnExists(db: Database.Database, table: TargetTable, column: string): boolean {
  // PRAGMA does not support bound parameters; `table` is only ever one of the
  // fixed TARGET_TABLES literals above, never a value derived from user input.
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((c) => c.name === column);
}

/**
 * Add the Copilot App usage columns to already-synced metrics tables (if
 * missing) and backfill them from any stored `raw_json` snapshots. Safe to
 * call repeatedly: column additions are skipped once present, and backfills
 * only ever update rows where the target column is still NULL.
 */
export function migrateCopilotAppMetrics(db: Database.Database): void {
  const existingTables = new Map<TargetTable, boolean>();
  for (const table of TARGET_TABLES) {
    existingTables.set(table, tableExists(db, table));
  }

  for (const migration of COLUMN_MIGRATIONS) {
    if (!existingTables.get(migration.table)) continue;
    if (columnExists(db, migration.table, migration.column)) continue;
    db.exec(migration.addColumnSql);
  }

  for (const backfill of BACKFILL_MIGRATIONS) {
    if (!existingTables.get(backfill.table)) continue;
    if (!columnExists(db, backfill.table, "raw_json")) continue;
    if (!columnExists(db, backfill.table, backfill.column)) continue;

    const valueExpr =
      backfill.valueKind === "integer"
        ? `CAST(json_extract(raw_json, '${backfill.jsonPath}') AS INTEGER)`
        : `json_extract(raw_json, '${backfill.jsonPath}')`;

    db.exec(`
      UPDATE ${backfill.table}
      SET ${backfill.column} = ${valueExpr}
      WHERE ${backfill.column} IS NULL
        AND raw_json IS NOT NULL
        AND json_valid(raw_json)
        AND json_extract(raw_json, '${backfill.jsonPath}') IS NOT NULL
    `);
  }
}
