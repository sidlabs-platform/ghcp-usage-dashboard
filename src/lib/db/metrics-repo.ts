// Metrics repository — CRUD for enterprise/org/user daily metrics in SQLite

import { getDb } from "./database";
import type { DayTotal, UserDayRecord } from "@/lib/types/metrics";

// ── Row-mapping helpers (structured columns → TypeScript objects) ─────

const DAY_TOTAL_COLUMNS = `
  day, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users,
  monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users,
  code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
  loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
  totals_by_ide, totals_by_feature, totals_by_language_feature,
  totals_by_model_feature, totals_by_language_model, totals_by_cli, pull_requests`;

function mapDayTotalRow(row: Record<string, unknown>): DayTotal {
  return {
    day: row.day as string,
    enterprise_id: row.enterprise_id as string,
    daily_active_users: row.daily_active_users as number,
    weekly_active_users: row.weekly_active_users as number,
    monthly_active_users: row.monthly_active_users as number,
    monthly_active_agent_users: row.monthly_active_agent_users as number,
    monthly_active_chat_users: row.monthly_active_chat_users as number,
    daily_active_cli_users: (row.daily_active_cli_users as number) || 0,
    code_generation_activity_count: row.code_generation_activity_count as number,
    code_acceptance_activity_count: row.code_acceptance_activity_count as number,
    user_initiated_interaction_count: row.user_initiated_interaction_count as number,
    loc_suggested_to_add_sum: row.loc_suggested_to_add_sum as number,
    loc_suggested_to_delete_sum: row.loc_suggested_to_delete_sum as number,
    loc_added_sum: row.loc_added_sum as number,
    loc_deleted_sum: row.loc_deleted_sum as number,
    totals_by_ide: JSON.parse((row.totals_by_ide as string) || "[]"),
    totals_by_feature: JSON.parse((row.totals_by_feature as string) || "[]"),
    totals_by_language_feature: JSON.parse((row.totals_by_language_feature as string) || "[]"),
    totals_by_model_feature: JSON.parse((row.totals_by_model_feature as string) || "[]"),
    totals_by_language_model: JSON.parse((row.totals_by_language_model as string) || "[]"),
    totals_by_cli: row.totals_by_cli ? JSON.parse(row.totals_by_cli as string) : undefined,
    pull_requests: row.pull_requests ? JSON.parse(row.pull_requests as string) : undefined,
  };
}

const USER_COLUMNS = `
  day, enterprise_id, user_id, user_login,
  code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
  loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
  chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
  chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
  used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive,
  used_copilot_coding_agent,
  totals_by_ide, totals_by_feature, totals_by_language_feature,
  totals_by_model_feature, totals_by_language_model, totals_by_cli, agent_edit`;

function mapUserRow(row: Record<string, unknown>): UserDayRecord {
  return {
    day: row.day as string,
    enterprise_id: row.enterprise_id as string,
    user_id: row.user_id as number,
    user_login: row.user_login as string,
    code_generation_activity_count: row.code_generation_activity_count as number,
    code_acceptance_activity_count: row.code_acceptance_activity_count as number,
    user_initiated_interaction_count: row.user_initiated_interaction_count as number,
    loc_suggested_to_add_sum: row.loc_suggested_to_add_sum as number,
    loc_suggested_to_delete_sum: row.loc_suggested_to_delete_sum as number,
    loc_added_sum: row.loc_added_sum as number,
    loc_deleted_sum: row.loc_deleted_sum as number,
    chat_panel_agent_mode: (row.chat_panel_agent_mode as number) || 0,
    chat_panel_ask_mode: (row.chat_panel_ask_mode as number) || 0,
    chat_panel_custom_mode: (row.chat_panel_custom_mode as number) || 0,
    chat_panel_edit_mode: (row.chat_panel_edit_mode as number) || 0,
    chat_panel_plan_mode: (row.chat_panel_plan_mode as number) || 0,
    chat_panel_unknown_mode: (row.chat_panel_unknown_mode as number) || 0,
    used_agent: !!(row.used_agent as number),
    used_chat: !!(row.used_chat as number),
    used_cli: !!(row.used_cli as number),
    used_copilot_code_review_active: !!(row.used_copilot_code_review_active as number),
    used_copilot_code_review_passive: !!(row.used_copilot_code_review_passive as number),
    used_copilot_coding_agent: !!(row.used_copilot_coding_agent as number),
    totals_by_ide: JSON.parse((row.totals_by_ide as string) || "[]"),
    totals_by_feature: JSON.parse((row.totals_by_feature as string) || "[]"),
    totals_by_language_feature: JSON.parse((row.totals_by_language_feature as string) || "[]"),
    totals_by_model_feature: JSON.parse((row.totals_by_model_feature as string) || "[]"),
    totals_by_language_model: JSON.parse((row.totals_by_language_model as string) || "[]"),
    totals_by_cli: row.totals_by_cli ? JSON.parse(row.totals_by_cli as string) : undefined,
    agent_edit: row.agent_edit ? JSON.parse(row.agent_edit as string) : undefined,
  };
}

// ── Enterprise ID resolution ──────────────────────────────────────────

/** Resolve the numeric enterprise_id from any stored data */
export function resolveEnterpriseId(): string | null {
  const db = getDb();
  // Check user metrics first (most common), then enterprise aggregate as fallback
  const row = db.prepare(
    `SELECT enterprise_id FROM user_daily_metrics LIMIT 1`
  ).get() as { enterprise_id: string } | undefined;
  if (row?.enterprise_id) return row.enterprise_id;

  const entRow = db.prepare(
    `SELECT enterprise_id FROM enterprise_daily_metrics LIMIT 1`
  ).get() as { enterprise_id: string } | undefined;
  return entRow?.enterprise_id || null;
}

// ── Enterprise metrics ────────────────────────────────────────────────

export function upsertEnterpriseDayMetrics(record: DayTotal): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO enterprise_daily_metrics (
      day, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users,
      monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, pull_requests, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.day, record.enterprise_id,
    record.daily_active_users, record.weekly_active_users, record.monthly_active_users,
    record.monthly_active_agent_users, record.monthly_active_chat_users,
    record.daily_active_cli_users || 0,
    record.code_generation_activity_count, record.code_acceptance_activity_count,
    record.user_initiated_interaction_count,
    record.loc_suggested_to_add_sum, record.loc_suggested_to_delete_sum,
    record.loc_added_sum, record.loc_deleted_sum,
    JSON.stringify(record.totals_by_ide || []),
    JSON.stringify(record.totals_by_feature || []),
    JSON.stringify(record.totals_by_language_feature || []),
    JSON.stringify(record.totals_by_model_feature || []),
    JSON.stringify(record.totals_by_language_model || []),
    record.totals_by_cli ? JSON.stringify(record.totals_by_cli) : null,
    record.pull_requests ? JSON.stringify(record.pull_requests) : null,
    JSON.stringify(record)
  );
}

export function getEnterpriseMetrics(enterpriseId: string, startDay: string, endDay: string): DayTotal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM enterprise_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(enterpriseId, startDay, endDay) as Record<string, unknown>[];

  return rows.map(mapDayTotalRow);
}

/** Check whether enterprise_daily_metrics has any rows for a date range */
export function hasEnterpriseDataForRange(enterpriseId: string, startDay: string, endDay: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM enterprise_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    LIMIT 1
  `).get(enterpriseId, startDay, endDay);
  return !!row;
}

/** Check whether org_daily_metrics has any rows for a given org and date range */
export function hasOrgDataForRange(orgSlug: string, startDay: string, endDay: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM org_daily_metrics
    WHERE org_slug = ? AND day >= ? AND day <= ?
    LIMIT 1
  `).get(orgSlug, startDay, endDay);
  return !!row;
}

// ── Organization metrics ──────────────────────────────────────────────

export function upsertOrgDayMetrics(orgSlug: string, record: DayTotal): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO org_daily_metrics (
      day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users,
      monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, pull_requests, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.day, orgSlug, record.enterprise_id,
    record.daily_active_users, record.weekly_active_users, record.monthly_active_users,
    record.monthly_active_agent_users, record.monthly_active_chat_users,
    record.daily_active_cli_users || 0,
    record.code_generation_activity_count, record.code_acceptance_activity_count,
    record.user_initiated_interaction_count,
    record.loc_suggested_to_add_sum, record.loc_suggested_to_delete_sum,
    record.loc_added_sum, record.loc_deleted_sum,
    JSON.stringify(record.totals_by_ide || []),
    JSON.stringify(record.totals_by_feature || []),
    JSON.stringify(record.totals_by_language_feature || []),
    JSON.stringify(record.totals_by_model_feature || []),
    JSON.stringify(record.totals_by_language_model || []),
    record.totals_by_cli ? JSON.stringify(record.totals_by_cli) : null,
    record.pull_requests ? JSON.stringify(record.pull_requests) : null,
    JSON.stringify(record)
  );
}

export function getOrgMetrics(orgSlug: string, startDay: string, endDay: string): DayTotal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE org_slug = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(orgSlug, startDay, endDay) as Record<string, unknown>[];

  return rows.map(mapDayTotalRow);
}

export function getAllOrgSlugs(): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT DISTINCT org_slug FROM org_daily_metrics`).all() as { org_slug: string }[];
  return rows.map((r) => r.org_slug);
}

/** Get aggregated org metrics across all orgs for a date range (one row per day).
 *  Sums numeric fields across orgs; medians are weighted by PR count. */
export function getAllOrgMetrics(startDay: string, endDay: string): DayTotal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(startDay, endDay) as Record<string, unknown>[];

  const byDay = new Map<string, DayTotal>();
  for (const row of rows) {
    const record = mapDayTotalRow(row);
    const existing = byDay.get(record.day);
    if (!existing) {
      byDay.set(record.day, record);
      continue;
    }

    // Sum core numeric fields across orgs
    existing.daily_active_users += record.daily_active_users ?? 0;
    existing.weekly_active_users += record.weekly_active_users ?? 0;
    existing.monthly_active_users += record.monthly_active_users ?? 0;
    existing.monthly_active_agent_users += record.monthly_active_agent_users ?? 0;
    existing.monthly_active_chat_users += record.monthly_active_chat_users ?? 0;
    existing.daily_active_cli_users = (existing.daily_active_cli_users ?? 0) + (record.daily_active_cli_users ?? 0);
    existing.code_generation_activity_count += record.code_generation_activity_count ?? 0;
    existing.code_acceptance_activity_count += record.code_acceptance_activity_count ?? 0;
    existing.user_initiated_interaction_count += record.user_initiated_interaction_count ?? 0;
    existing.loc_suggested_to_add_sum += record.loc_suggested_to_add_sum ?? 0;
    existing.loc_suggested_to_delete_sum += record.loc_suggested_to_delete_sum ?? 0;
    existing.loc_added_sum += record.loc_added_sum ?? 0;
    existing.loc_deleted_sum += record.loc_deleted_sum ?? 0;

    // Aggregate PR metrics
    const rp = record.pull_requests;
    if (!rp) continue;

    if (!existing.pull_requests) {
      existing.pull_requests = { ...rp };
      continue;
    }

    const ep = existing.pull_requests;
    ep.total_created += rp.total_created ?? 0;
    ep.total_reviewed += rp.total_reviewed ?? 0;
    ep.total_merged += rp.total_merged ?? 0;
    ep.total_suggestions += rp.total_suggestions ?? 0;
    ep.total_applied_suggestions += rp.total_applied_suggestions ?? 0;
    ep.total_created_by_copilot += rp.total_created_by_copilot ?? 0;
    ep.total_reviewed_by_copilot += rp.total_reviewed_by_copilot ?? 0;
    ep.total_merged_created_by_copilot += rp.total_merged_created_by_copilot ?? 0;
    ep.total_merged_reviewed_by_copilot += rp.total_merged_reviewed_by_copilot ?? 0;
    ep.total_copilot_suggestions += rp.total_copilot_suggestions ?? 0;
    ep.total_copilot_applied_suggestions += rp.total_copilot_applied_suggestions ?? 0;

    // Weighted-average medians by merged PR count (best approximation
    // without access to the underlying distribution)
    ep.median_minutes_to_merge = weightedMedian(
      ep.median_minutes_to_merge, ep.total_merged - (rp.total_merged ?? 0),
      rp.median_minutes_to_merge, rp.total_merged ?? 0
    );
    ep.median_minutes_to_merge_copilot_authored = weightedMedian(
      ep.median_minutes_to_merge_copilot_authored, ep.total_merged_created_by_copilot - (rp.total_merged_created_by_copilot ?? 0),
      rp.median_minutes_to_merge_copilot_authored, rp.total_merged_created_by_copilot ?? 0
    );
    ep.median_minutes_to_merge_copilot_reviewed = weightedMedian(
      ep.median_minutes_to_merge_copilot_reviewed, ep.total_merged_reviewed_by_copilot - (rp.total_merged_reviewed_by_copilot ?? 0),
      rp.median_minutes_to_merge_copilot_reviewed, rp.total_merged_reviewed_by_copilot ?? 0
    );
  }

  return Array.from(byDay.values());
}

/** Get aggregated org metrics for specific orgs for a date range (one row per day).
 *  Same aggregation logic as getAllOrgMetrics but filtered to given org slugs. */
export function getFilteredOrgMetrics(orgSlugs: string[], startDay: string, endDay: string): DayTotal[] {
  if (orgSlugs.length === 0) return getAllOrgMetrics(startDay, endDay);
  const db = getDb();
  const placeholders = orgSlugs.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE day >= ? AND day <= ? AND org_slug IN (${placeholders})
    ORDER BY day ASC
  `).all(startDay, endDay, ...orgSlugs) as Record<string, unknown>[];

  const byDay = new Map<string, DayTotal>();
  for (const row of rows) {
    const record = mapDayTotalRow(row);
    const existing = byDay.get(record.day);
    if (!existing) {
      byDay.set(record.day, record);
      continue;
    }

    existing.daily_active_users += record.daily_active_users ?? 0;
    existing.weekly_active_users += record.weekly_active_users ?? 0;
    existing.monthly_active_users += record.monthly_active_users ?? 0;
    existing.monthly_active_agent_users += record.monthly_active_agent_users ?? 0;
    existing.monthly_active_chat_users += record.monthly_active_chat_users ?? 0;
    existing.daily_active_cli_users = (existing.daily_active_cli_users ?? 0) + (record.daily_active_cli_users ?? 0);
    existing.code_generation_activity_count += record.code_generation_activity_count ?? 0;
    existing.code_acceptance_activity_count += record.code_acceptance_activity_count ?? 0;
    existing.user_initiated_interaction_count += record.user_initiated_interaction_count ?? 0;
    existing.loc_suggested_to_add_sum += record.loc_suggested_to_add_sum ?? 0;
    existing.loc_suggested_to_delete_sum += record.loc_suggested_to_delete_sum ?? 0;
    existing.loc_added_sum += record.loc_added_sum ?? 0;
    existing.loc_deleted_sum += record.loc_deleted_sum ?? 0;

    const rp = record.pull_requests;
    if (!rp) continue;
    if (!existing.pull_requests) { existing.pull_requests = { ...rp }; continue; }
    const ep = existing.pull_requests;
    ep.total_created += rp.total_created ?? 0;
    ep.total_reviewed += rp.total_reviewed ?? 0;
    ep.total_merged += rp.total_merged ?? 0;
    ep.total_suggestions += rp.total_suggestions ?? 0;
    ep.total_applied_suggestions += rp.total_applied_suggestions ?? 0;
    ep.total_created_by_copilot += rp.total_created_by_copilot ?? 0;
    ep.total_reviewed_by_copilot += rp.total_reviewed_by_copilot ?? 0;
    ep.total_merged_created_by_copilot += rp.total_merged_created_by_copilot ?? 0;
    ep.total_merged_reviewed_by_copilot += rp.total_merged_reviewed_by_copilot ?? 0;
    ep.total_copilot_suggestions += rp.total_copilot_suggestions ?? 0;
    ep.total_copilot_applied_suggestions += rp.total_copilot_applied_suggestions ?? 0;
    ep.median_minutes_to_merge = weightedMedian(ep.median_minutes_to_merge, ep.total_merged - (rp.total_merged ?? 0), rp.median_minutes_to_merge, rp.total_merged ?? 0);
    ep.median_minutes_to_merge_copilot_authored = weightedMedian(ep.median_minutes_to_merge_copilot_authored, ep.total_merged_created_by_copilot - (rp.total_merged_created_by_copilot ?? 0), rp.median_minutes_to_merge_copilot_authored, rp.total_merged_created_by_copilot ?? 0);
    ep.median_minutes_to_merge_copilot_reviewed = weightedMedian(ep.median_minutes_to_merge_copilot_reviewed, ep.total_merged_reviewed_by_copilot - (rp.total_merged_reviewed_by_copilot ?? 0), rp.median_minutes_to_merge_copilot_reviewed, rp.total_merged_reviewed_by_copilot ?? 0);
  }

  return Array.from(byDay.values());
}

function weightedMedian(
  a: number | null | undefined, weightA: number,
  b: number | null | undefined, weightB: number
): number | null {
  if (a == null && b == null) return null;
  if (a == null) return b ?? null;
  if (b == null) return a ?? null;
  const total = weightA + weightB;
  return total > 0 ? (a * weightA + b * weightB) / total : (a + b) / 2;
}

// ── User metrics ──────────────────────────────────────────────────────

export function upsertUserDayMetrics(record: UserDayRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO user_daily_metrics (
      day, enterprise_id, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
      chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive,
      used_copilot_coding_agent,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, agent_edit, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.day, record.enterprise_id, record.user_id, record.user_login,
    record.code_generation_activity_count, record.code_acceptance_activity_count,
    record.user_initiated_interaction_count,
    record.loc_suggested_to_add_sum, record.loc_suggested_to_delete_sum,
    record.loc_added_sum, record.loc_deleted_sum,
    record.chat_panel_agent_mode || 0, record.chat_panel_ask_mode || 0,
    record.chat_panel_custom_mode || 0, record.chat_panel_edit_mode || 0,
    record.chat_panel_plan_mode || 0, record.chat_panel_unknown_mode || 0,
    record.used_agent ? 1 : 0, record.used_chat ? 1 : 0, record.used_cli ? 1 : 0,
    record.used_copilot_code_review_active ? 1 : 0, record.used_copilot_code_review_passive ? 1 : 0,
    record.used_copilot_coding_agent ? 1 : 0,
    JSON.stringify(record.totals_by_ide || []),
    JSON.stringify(record.totals_by_feature || []),
    JSON.stringify(record.totals_by_language_feature || []),
    JSON.stringify(record.totals_by_model_feature || []),
    JSON.stringify(record.totals_by_language_model || []),
    record.totals_by_cli ? JSON.stringify(record.totals_by_cli) : null,
    record.agent_edit ? JSON.stringify(record.agent_edit) : null,
    JSON.stringify(record)
  );
}

export function getUserMetrics(enterpriseId: string, startDay: string, endDay: string): UserDayRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC, user_login ASC
  `).all(enterpriseId, startDay, endDay) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

export function getUserMetricsByLogin(userLogin: string, startDay: string, endDay: string): UserDayRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE user_login = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(userLogin, startDay, endDay) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

export function getDistinctUsers(enterpriseId: string, startDay: string, endDay: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM user_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    ORDER BY user_login ASC
  `).all(enterpriseId, startDay, endDay) as { user_login: string }[];

  return rows.map((r) => r.user_login);
}

/** Aggregate user-level data into daily summaries (used when enterprise-level data is unavailable) */
export function getAggregatedDailySummary(startDay: string, endDay: string): {
  day: string;
  daily_active_users: number;
  weekly_active_users: number;
  monthly_active_users: number;
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  user_initiated_interaction_count: number;
  loc_suggested_to_add_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
  daily_active_cli_users: number;
  agent_users: number;
  chat_users: number;
}[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      day,
      COUNT(DISTINCT user_id) as daily_active_users,
      COUNT(DISTINCT user_id) as weekly_active_users,
      COUNT(DISTINCT user_id) as monthly_active_users,
      SUM(code_generation_activity_count) as code_generation_activity_count,
      SUM(code_acceptance_activity_count) as code_acceptance_activity_count,
      SUM(user_initiated_interaction_count) as user_initiated_interaction_count,
      SUM(loc_suggested_to_add_sum) as loc_suggested_to_add_sum,
      SUM(loc_added_sum) as loc_added_sum,
      SUM(loc_deleted_sum) as loc_deleted_sum,
      SUM(used_cli) as daily_active_cli_users,
      SUM(used_agent) as agent_users,
      SUM(used_chat) as chat_users
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
    GROUP BY day
    ORDER BY day ASC
  `).all(startDay, endDay) as {
    day: string;
    daily_active_users: number;
    weekly_active_users: number;
    monthly_active_users: number;
    code_generation_activity_count: number;
    code_acceptance_activity_count: number;
    user_initiated_interaction_count: number;
    loc_suggested_to_add_sum: number;
    loc_added_sum: number;
    loc_deleted_sum: number;
    daily_active_cli_users: number;
    agent_users: number;
    chat_users: number;
  }[];
}

/** Get all user metrics without filtering by enterprise_id (since we know there's only one) */
export function getAllUserMetrics(startDay: string, endDay: string): UserDayRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
    ORDER BY day ASC, user_login ASC
  `).all(startDay, endDay) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

// ── Sync log ──────────────────────────────────────────────────────────

export function recordSync(scope: string, scopeId: string, day: string | null, count: number, status = "success", error?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO sync_log (scope, scope_id, day, synced_at, record_count, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(scope, scopeId, day || "__none__", new Date().toISOString(), count, status, error || null);
}

export function isSynced(scope: string, scopeId: string, day: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM sync_log WHERE scope = ? AND scope_id = ? AND day = ? AND status = 'success'
  `).get(scope, scopeId, day);
  return !!row;
}

export function getLatestSyncDay(scope: string, scopeId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(day) as latest FROM sync_log WHERE scope = ? AND scope_id = ? AND status = 'success' AND day != '__none__'
  `).get(scope, scopeId) as { latest: string | null } | undefined;
  return row?.latest || null;
}

export function getSyncStatus(): { scope: string; scope_id: string; days_synced: number; latest_day: string | null }[] {
  const db = getDb();
  return db.prepare(`
    SELECT scope, scope_id, COUNT(*) as days_synced, MAX(day) as latest_day
    FROM sync_log WHERE status = 'success' AND day != '__none__'
    GROUP BY scope, scope_id
    ORDER BY scope, scope_id
  `).all() as { scope: string; scope_id: string; days_synced: number; latest_day: string | null }[];
}

// ── Sync lock (database-backed, works across serverless instances) ────

export function acquireSyncLock(): boolean {
  const db = getDb();
  // Clean up expired locks first
  db.prepare(`DELETE FROM sync_lock WHERE expires_at < ?`).run(new Date().toISOString());

  try {
    db.prepare(`
      INSERT INTO sync_lock (lock_key, acquired_at, expires_at)
      VALUES ('global', ?, ?)
    `).run(
      new Date().toISOString(),
      new Date(Date.now() + 3600000).toISOString() // 1 hour expiry
    );
    return true;
  } catch {
    // UNIQUE constraint violation = lock already held
    return false;
  }
}

export function releaseSyncLock(): void {
  const db = getDb();
  db.prepare(`DELETE FROM sync_lock WHERE lock_key = 'global'`).run();
}

export function isSyncLocked(): boolean {
  const db = getDb();
  db.prepare(`DELETE FROM sync_lock WHERE expires_at < ?`).run(new Date().toISOString());
  const row = db.prepare(`SELECT 1 FROM sync_lock WHERE lock_key = 'global'`).get();
  return !!row;
}

/** Clear sync_log entries where enterprise/org data returned 0 records, allowing re-sync */
export function clearEmptySyncEntries(): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM sync_log
    WHERE record_count = 0
      AND status = 'success'
      AND scope IN ('enterprise', 'org')
      AND day != '__none__'
  `).run();
  return result.changes;
}
