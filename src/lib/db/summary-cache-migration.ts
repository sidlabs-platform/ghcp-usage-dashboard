// One-time, idempotent startup migration that recomputes classification-
// dependent summary/cache fields in place, using the exact current
// IS_COMPLETION_SQL semantics.
//
// Background: user_period_summary.acceptance_rate, daily_aggregate_cache's
// completion_loc_suggested/completion_loc_accepted, and
// team_summary_cache.overall_acceptance_rate are pre-aggregated by
// summary-tables.ts (see refreshUserSummary/refreshDailyAggregate/
// refreshTeamSummary). Rows persisted before the completion allowlist was
// tightened to exclude copilot_app/chat_inline/unknown features were computed
// under the old, looser `feature != 'agent_edit'` semantics. This migration
// recomputes ONLY those specific columns from the still-present
// user_daily_metrics/totals_by_feature source data — it never touches any
// other cached column, never requires a remote fetch or full re-sync, and
// never drops/recreates any synced table.
//
// Imports IS_COMPLETION_SQL directly from ./feature-classification (NOT from
// ./aggregation-queries) so this module can be required by database.ts
// without creating a circular import: database.ts -> summary-cache-migration.ts
// -> aggregation-queries.ts -> database.ts would otherwise be a cycle.
import { IS_COMPLETION_SQL } from "./feature-classification";
import type { SqliteDatabase } from "./sqlite-database";

/** Ledger name recorded once this migration has successfully applied. */
const MIGRATION_NAME = "summary-cache-completion-classification-v1";

function tableExists(db: SqliteDatabase, table: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return !!row;
}

function alreadyApplied(db: SqliteDatabase): boolean {
  if (!tableExists(db, "summary_cache_migrations")) return false;
  const row = db
    .prepare(`SELECT name FROM summary_cache_migrations WHERE name = ?`)
    .get(MIGRATION_NAME);
  return !!row;
}

function markApplied(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO summary_cache_migrations (name, applied_at) VALUES (?, ?)
     ON CONFLICT(name) DO NOTHING`
  ).run(MIGRATION_NAME, new Date().toISOString());
}

/**
 * Recompute user_period_summary.acceptance_rate in place for every already
 * cached (enterprise_slug, user_login, period_start, period_end) row, using
 * the row's own period bounds to re-join user_daily_metrics. Rows whose
 * period has no matching totals_by_feature data are left untouched (mirrors
 * refreshUserSummary's existing COALESCE(..., 0) behavior, which only ever
 * overrides rows for which a group actually exists). Source rows with
 * malformed totals_by_feature JSON are excluded via json_valid(...) so a
 * single corrupt legacy row can never throw and abort the whole migration.
 */
function migrateUserPeriodSummary(db: SqliteDatabase): void {
  if (!tableExists(db, "user_period_summary") || !tableExists(db, "user_daily_metrics")) return;

  db.exec(`
    UPDATE user_period_summary SET acceptance_rate = COALESCE(f.rate, 0)
    FROM (
      SELECT u.enterprise_slug, u.user_login, s.period_start, s.period_end,
        CASE WHEN SUM(CASE WHEN ${IS_COMPLETION_SQL}
            THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) > 0
          THEN ROUND(
            CAST(SUM(CASE WHEN ${IS_COMPLETION_SQL}
              THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END) AS REAL) /
            SUM(CASE WHEN ${IS_COMPLETION_SQL}
              THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) * 100, 1)
          ELSE 0 END as rate
      FROM user_period_summary s
      INNER JOIN user_daily_metrics u
        ON u.enterprise_slug = s.enterprise_slug
        AND u.user_login = s.user_login
        AND u.day >= s.period_start
        AND u.day <= s.period_end,
        json_each(u.totals_by_feature) j
      WHERE u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND json_valid(u.totals_by_feature)
      GROUP BY u.enterprise_slug, u.user_login, s.period_start, s.period_end
    ) f
    WHERE user_period_summary.enterprise_slug = f.enterprise_slug
      AND user_period_summary.user_login = f.user_login
      AND user_period_summary.period_start = f.period_start
      AND user_period_summary.period_end = f.period_end
  `);
}

/**
 * Recompute daily_aggregate_cache.completion_loc_suggested/
 * completion_loc_accepted in place for every already cached
 * (enterprise_slug, day) row. agent_loc_added is intentionally untouched:
 * IS_AGENT_SQL (`feature = 'agent_edit'`) was never ambiguous, unlike the
 * completion allowlist.
 */
function migrateDailyAggregateCache(db: SqliteDatabase): void {
  if (!tableExists(db, "daily_aggregate_cache") || !tableExists(db, "user_daily_metrics")) return;

  db.exec(`
    UPDATE daily_aggregate_cache SET
      completion_loc_suggested = COALESCE(f.cs, 0),
      completion_loc_accepted = COALESCE(f.ca, 0)
    FROM (
      SELECT u.enterprise_slug, u.day,
        SUM(CASE WHEN ${IS_COMPLETION_SQL}
          THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END) as cs,
        SUM(CASE WHEN ${IS_COMPLETION_SQL}
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END) as ca
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND json_valid(u.totals_by_feature)
      GROUP BY u.enterprise_slug, u.day
    ) f
    WHERE daily_aggregate_cache.enterprise_slug = f.enterprise_slug
      AND daily_aggregate_cache.day = f.day
  `);
}

/**
 * Recompute team_summary_cache.overall_acceptance_rate in place for every
 * already cached (enterprise_slug, team_slug, source, period_start,
 * period_end) row, joining through team_memberships to reach the same
 * user_daily_metrics rows refreshTeamSummary would use for that period.
 */
function migrateTeamSummaryCache(db: SqliteDatabase): void {
  if (
    !tableExists(db, "team_summary_cache") ||
    !tableExists(db, "team_memberships") ||
    !tableExists(db, "user_daily_metrics")
  ) {
    return;
  }

  db.exec(`
    UPDATE team_summary_cache SET overall_acceptance_rate = COALESCE(f.rate, 0)
    FROM (
      SELECT tm.enterprise_slug, tm.team_slug, tm.source, s.period_start, s.period_end,
        CASE WHEN SUM(CASE WHEN ${IS_COMPLETION_SQL}
            THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) > 0
          THEN ROUND(
            CAST(SUM(CASE WHEN ${IS_COMPLETION_SQL}
              THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END) AS REAL) /
            SUM(CASE WHEN ${IS_COMPLETION_SQL}
              THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) * 100, 1)
          ELSE 0 END as rate
      FROM team_summary_cache s
      INNER JOIN team_memberships tm
        ON tm.enterprise_slug = s.enterprise_slug
        AND tm.team_slug = s.team_slug
        AND tm.source = s.source
      INNER JOIN user_daily_metrics u
        ON u.enterprise_slug = tm.enterprise_slug
        AND u.user_login = tm.user_login
        AND u.day >= s.period_start
        AND u.day <= s.period_end,
        json_each(u.totals_by_feature) j
      WHERE u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND json_valid(u.totals_by_feature)
      GROUP BY tm.enterprise_slug, tm.team_slug, tm.source, s.period_start, s.period_end
    ) f
    WHERE team_summary_cache.enterprise_slug = f.enterprise_slug
      AND team_summary_cache.team_slug = f.team_slug
      AND team_summary_cache.source = f.source
      AND team_summary_cache.period_start = f.period_start
      AND team_summary_cache.period_end = f.period_end
  `);
}

/**
 * Run the one-time summary/cache classification migration, if it has not
 * already been recorded in the summary_cache_migrations ledger. Safe to call
 * on every getDb() invocation: it is a cheap no-op after the first successful
 * run. Runs transactionally — either every targeted table is recomputed and
 * the ledger marker is written, or (on any error) nothing is committed, so a
 * partial recompute can never be left un-recorded-yet-partially-applied.
 *
 * If none of the target tables/rows exist yet (e.g. a fresh database, or one
 * that has never synced), this safely records completion without doing any
 * work: future summary refreshes already use the current IS_COMPLETION_SQL
 * semantics, so there is nothing legacy left to fix.
 */
export function migrateSummaryCacheClassification(db: SqliteDatabase): void {
  if (!tableExists(db, "summary_cache_migrations")) return;
  if (alreadyApplied(db)) return;

  const tx = db.transaction(() => {
    migrateUserPeriodSummary(db);
    migrateDailyAggregateCache(db);
    migrateTeamSummaryCache(db);
    markApplied(db);
  });
  tx();
}
