// Metrics repository — CRUD for enterprise/org/user daily metrics in SQLite

import { getDb } from "./database";
import type { DayTotal, UserDayRecord, TotalsByFeature } from "@/lib/types/metrics";

/** Build optional enterprise_slug IN (...) clause for multi-enterprise filtering */
function buildEnterpriseFilter(slugs?: string[], alias?: string): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  const col = alias ? `${alias}.enterprise_slug` : "enterprise_slug";
  return { clause: ` AND ${col} IN (${placeholders})`, params: slugs };
}

// Chat mode feature names as they appear in totals_by_feature
const CHAT_MODE_FEATURES: Record<string, keyof ReturnType<typeof extractChatModeCounts>> = {
  chat_panel_ask_mode: "ask",
  chat_panel_edit_mode: "edit",
  chat_panel_plan_mode: "plan",
  chat_panel_agent_mode: "agent",
  chat_panel_custom_mode: "custom",
  chat_panel_unknown_mode: "unknown",
};

/** Extract chat mode interaction counts from totals_by_feature entries */
export function extractChatModeCounts(features: TotalsByFeature[]): {
  ask: number; edit: number; plan: number; agent: number; custom: number; unknown: number;
} {
  const counts = { ask: 0, edit: 0, plan: 0, agent: 0, custom: 0, unknown: 0 };
  for (const f of features) {
    const mode = CHAT_MODE_FEATURES[f.feature];
    if (mode) {
      counts[mode] += f.user_initiated_interaction_count || 0;
    }
  }
  return counts;
}

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

/**
 * Count distinct enterprises in the effective scope.
 * Used to decide whether enterprise-level aggregate data can be used directly
 * (only valid for single-enterprise) or user-level aggregation is needed
 * (required for multi-enterprise to correctly deduplicate users).
 */
export function countEffectiveEnterprises(enterpriseSlugs?: string[]): number {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const row = db.prepare(
    `SELECT COUNT(DISTINCT enterprise_slug) as cnt FROM enterprise_daily_metrics WHERE 1=1${ef.clause}`
  ).get(...ef.params) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/** Resolve the numeric enterprise_id from any stored data */
export function resolveEnterpriseId(enterpriseSlugs?: string[]): string | null {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  // Check user metrics first (most common), then enterprise aggregate as fallback
  const row = db.prepare(
    `SELECT enterprise_id FROM user_daily_metrics WHERE 1=1${ef.clause} LIMIT 1`
  ).get(...ef.params) as { enterprise_id: string } | undefined;
  if (row?.enterprise_id) return row.enterprise_id;

  const entRow = db.prepare(
    `SELECT enterprise_id FROM enterprise_daily_metrics WHERE 1=1${ef.clause} LIMIT 1`
  ).get(...ef.params) as { enterprise_id: string } | undefined;
  return entRow?.enterprise_id || null;
}

// ── Enterprise metrics ────────────────────────────────────────────────

export function upsertEnterpriseDayMetrics(enterpriseSlug: string, record: DayTotal): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO enterprise_daily_metrics (
      enterprise_slug, day, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users,
      monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, pull_requests, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    enterpriseSlug, record.day, record.enterprise_id,
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

export function getEnterpriseMetrics(startDay: string, endDay: string, enterpriseSlugs?: string[]): DayTotal[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM enterprise_daily_metrics
    WHERE day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC
  `).all(startDay, endDay, ...ef.params) as Record<string, unknown>[];

  return rows.map(mapDayTotalRow);
}

/** Check whether enterprise_daily_metrics has any rows for a date range */
export function hasEnterpriseDataForRange(enterpriseId: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): boolean {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const row = db.prepare(`
    SELECT 1 FROM enterprise_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?${ef.clause}
    LIMIT 1
  `).get(enterpriseId, startDay, endDay, ...ef.params);
  return !!row;
}

/** Check whether org_daily_metrics has any rows for a given org and date range */
export function hasOrgDataForRange(orgSlug: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): boolean {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const row = db.prepare(`
    SELECT 1 FROM org_daily_metrics
    WHERE org_slug = ? AND day >= ? AND day <= ?${ef.clause}
    LIMIT 1
  `).get(orgSlug, startDay, endDay, ...ef.params);
  return !!row;
}

// ── Organization metrics ──────────────────────────────────────────────

export function upsertOrgDayMetrics(enterpriseSlug: string, orgSlug: string, record: DayTotal): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO org_daily_metrics (
      enterprise_slug, day, org_slug, enterprise_id, daily_active_users, weekly_active_users, monthly_active_users,
      monthly_active_agent_users, monthly_active_chat_users, daily_active_cli_users,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, pull_requests, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    enterpriseSlug, record.day, orgSlug, record.enterprise_id,
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

export function getOrgMetrics(orgSlug: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): DayTotal[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE org_slug = ? AND day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC
  `).all(orgSlug, startDay, endDay, ...ef.params) as Record<string, unknown>[];

  return rows.map(mapDayTotalRow);
}

export function getAllOrgSlugs(enterpriseSlugs?: string[]): string[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`SELECT DISTINCT org_slug FROM org_daily_metrics WHERE 1=1${ef.clause}`).all(...ef.params) as { org_slug: string }[];
  return rows.map((r) => r.org_slug);
}

/** Get aggregated org metrics across all orgs for a date range (one row per day).
 *  Sums numeric fields across orgs; medians are weighted by PR count. */
export function getAllOrgMetrics(startDay: string, endDay: string, enterpriseSlugs?: string[]): DayTotal[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC
  `).all(startDay, endDay, ...ef.params) as Record<string, unknown>[];

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
export function getFilteredOrgMetrics(orgSlugs: string[], startDay: string, endDay: string, enterpriseSlugs?: string[]): DayTotal[] {
  if (orgSlugs.length === 0) return getAllOrgMetrics(startDay, endDay, enterpriseSlugs);
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const placeholders = orgSlugs.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ${DAY_TOTAL_COLUMNS}
    FROM org_daily_metrics
    WHERE day >= ? AND day <= ? AND org_slug IN (${placeholders})${ef.clause}
    ORDER BY day ASC
  `).all(startDay, endDay, ...orgSlugs, ...ef.params) as Record<string, unknown>[];

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

export function upsertUserDayMetrics(enterpriseSlug: string, record: UserDayRecord): void {
  const db = getDb();
  const chatModes = extractChatModeCounts(record.totals_by_feature || []);
  db.prepare(`
    INSERT OR REPLACE INTO user_daily_metrics (
      enterprise_slug, day, enterprise_id, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
      chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive,
      used_copilot_coding_agent,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, agent_edit, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    enterpriseSlug, record.day, record.enterprise_id || enterpriseSlug, record.user_id, record.user_login,
    record.code_generation_activity_count, record.code_acceptance_activity_count,
    record.user_initiated_interaction_count,
    record.loc_suggested_to_add_sum, record.loc_suggested_to_delete_sum,
    record.loc_added_sum, record.loc_deleted_sum,
    chatModes.agent || record.chat_panel_agent_mode || 0,
    chatModes.ask || record.chat_panel_ask_mode || 0,
    chatModes.custom || record.chat_panel_custom_mode || 0,
    chatModes.edit || record.chat_panel_edit_mode || 0,
    chatModes.plan || record.chat_panel_plan_mode || 0,
    chatModes.unknown || record.chat_panel_unknown_mode || 0,
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

/** Batch-insert user day metrics in a single transaction (much faster than individual inserts) */
export function batchUpsertUserDayMetrics(enterpriseSlug: string, records: UserDayRecord[]): number {
  if (records.length === 0) return 0;
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO user_daily_metrics (
      enterprise_slug, day, enterprise_id, user_id, user_login,
      code_generation_activity_count, code_acceptance_activity_count, user_initiated_interaction_count,
      loc_suggested_to_add_sum, loc_suggested_to_delete_sum, loc_added_sum, loc_deleted_sum,
      chat_panel_agent_mode, chat_panel_ask_mode, chat_panel_custom_mode,
      chat_panel_edit_mode, chat_panel_plan_mode, chat_panel_unknown_mode,
      used_agent, used_chat, used_cli, used_copilot_code_review_active, used_copilot_code_review_passive,
      used_copilot_coding_agent,
      totals_by_ide, totals_by_feature, totals_by_language_feature,
      totals_by_model_feature, totals_by_language_model, totals_by_cli, agent_edit, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const r of records) {
      const cm = extractChatModeCounts(r.totals_by_feature || []);
      stmt.run(
        enterpriseSlug, r.day, r.enterprise_id || enterpriseSlug, r.user_id, r.user_login,
        r.code_generation_activity_count, r.code_acceptance_activity_count,
        r.user_initiated_interaction_count,
        r.loc_suggested_to_add_sum, r.loc_suggested_to_delete_sum,
        r.loc_added_sum, r.loc_deleted_sum,
        cm.agent || r.chat_panel_agent_mode || 0,
        cm.ask || r.chat_panel_ask_mode || 0,
        cm.custom || r.chat_panel_custom_mode || 0,
        cm.edit || r.chat_panel_edit_mode || 0,
        cm.plan || r.chat_panel_plan_mode || 0,
        cm.unknown || r.chat_panel_unknown_mode || 0,
        r.used_agent ? 1 : 0, r.used_chat ? 1 : 0, r.used_cli ? 1 : 0,
        r.used_copilot_code_review_active ? 1 : 0, r.used_copilot_code_review_passive ? 1 : 0,
        r.used_copilot_coding_agent ? 1 : 0,
        JSON.stringify(r.totals_by_ide || []),
        JSON.stringify(r.totals_by_feature || []),
        JSON.stringify(r.totals_by_language_feature || []),
        JSON.stringify(r.totals_by_model_feature || []),
        JSON.stringify(r.totals_by_language_model || []),
        r.totals_by_cli ? JSON.stringify(r.totals_by_cli) : null,
        r.agent_edit ? JSON.stringify(r.agent_edit) : null,
        JSON.stringify(r)
      );
    }
  });

  tx();
  return records.length;
}

export function getUserMetrics(enterpriseId: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): UserDayRecord[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC, user_login ASC
  `).all(enterpriseId, startDay, endDay, ...ef.params) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

export function getUserMetricsByLogin(userLogin: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): UserDayRecord[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE user_login = ? AND day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC
  `).all(userLogin, startDay, endDay, ...ef.params) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

export function getDistinctUsers(enterpriseId: string, startDay: string, endDay: string, enterpriseSlugs?: string[]): string[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM user_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?${ef.clause}
    ORDER BY user_login ASC
  `).all(enterpriseId, startDay, endDay, ...ef.params) as { user_login: string }[];

  return rows.map((r) => r.user_login);
}

/**
 * Aggregate user-level data into daily summaries (used when enterprise-level data is unavailable).
 *
 * WAU = rolling 7-day distinct user count (users active on day d through d-6).
 * MAU = rolling 30-day distinct user count (users active on day d through d-29).
 * These are computed via correlated subqueries against user_daily_metrics.
 */
export function getAggregatedDailySummary(startDay: string, endDay: string, enterpriseSlugs?: string[]): {
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
  // Build separate enterprise filters with table aliases for subqueries
  const efW = buildEnterpriseFilter(enterpriseSlugs, 'w');
  const efMo = buildEnterpriseFilter(enterpriseSlugs, 'mo');
  const efM = buildEnterpriseFilter(enterpriseSlugs, 'm');
  return db.prepare(`
    SELECT
      m.day,
      COUNT(DISTINCT m.user_id) as daily_active_users,
      -- Rolling 7-day distinct user count (WAU)
      (SELECT COUNT(DISTINCT w.user_id)
       FROM user_daily_metrics w
       WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day${efW.clause}
      ) as weekly_active_users,
      -- Rolling 30-day distinct user count (MAU)
      (SELECT COUNT(DISTINCT mo.user_id)
       FROM user_daily_metrics mo
       WHERE mo.day BETWEEN date(m.day, '-29 days') AND m.day${efMo.clause}
      ) as monthly_active_users,
      SUM(m.code_generation_activity_count) as code_generation_activity_count,
      SUM(m.code_acceptance_activity_count) as code_acceptance_activity_count,
      SUM(m.user_initiated_interaction_count) as user_initiated_interaction_count,
      SUM(m.loc_suggested_to_add_sum) as loc_suggested_to_add_sum,
      SUM(m.loc_added_sum) as loc_added_sum,
      SUM(m.loc_deleted_sum) as loc_deleted_sum,
      COUNT(DISTINCT CASE WHEN m.used_cli = 1 THEN m.user_id END) as daily_active_cli_users,
      COUNT(DISTINCT CASE WHEN m.used_agent = 1 THEN m.user_id END) as agent_users,
      COUNT(DISTINCT CASE WHEN m.used_chat = 1 THEN m.user_id END) as chat_users
    FROM user_daily_metrics m
    WHERE m.day >= ? AND m.day <= ?${efM.clause}
    GROUP BY m.day
    ORDER BY m.day ASC
  `).all(...efW.params, ...efMo.params, startDay, endDay, ...efM.params) as {
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
export function getAllUserMetrics(startDay: string, endDay: string, enterpriseSlugs?: string[]): UserDayRecord[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT ${USER_COLUMNS}
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?${ef.clause}
    ORDER BY day ASC, user_login ASC
  `).all(startDay, endDay, ...ef.params) as Record<string, unknown>[];

  return rows.map(mapUserRow);
}

// ── Sync log ──────────────────────────────────────────────────────────

export function recordSync(enterpriseSlug: string, scope: string, scopeId: string, day: string | null, count: number, status = "success", error?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO sync_log (enterprise_slug, scope, scope_id, day, synced_at, record_count, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(enterpriseSlug, scope, scopeId, day || "__none__", new Date().toISOString(), count, status, error || null);
}

export function isSynced(enterpriseSlug: string, scope: string, scopeId: string, day: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 FROM sync_log WHERE enterprise_slug = ? AND scope = ? AND scope_id = ? AND day = ? AND status = 'success'
  `).get(enterpriseSlug, scope, scopeId, day);
  return !!row;
}

export function getLatestSyncDay(enterpriseSlug: string, scope: string, scopeId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(day) as latest FROM sync_log WHERE enterprise_slug = ? AND scope = ? AND scope_id = ? AND status = 'success' AND day != '__none__'
  `).get(enterpriseSlug, scope, scopeId) as { latest: string | null } | undefined;
  return row?.latest || null;
}

export function getSyncStatus(enterpriseSlugs?: string[]): { scope: string; scope_id: string; days_synced: number; latest_day: string | null }[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  return db.prepare(`
    SELECT scope, scope_id, COUNT(*) as days_synced, MAX(day) as latest_day
    FROM sync_log WHERE status = 'success' AND day != '__none__'${ef.clause}
    GROUP BY scope, scope_id
    ORDER BY scope, scope_id
  `).all(...ef.params) as { scope: string; scope_id: string; days_synced: number; latest_day: string | null }[];
}

// ── Sync lock (database-backed, works across serverless instances) ────

/** Maximum absolute age for a lock before it is considered stale (30 minutes) */
const LOCK_STALENESS_MS = 30 * 60 * 1000;
/** Default lock TTL (15 minutes) */
const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Clean up expired or stale locks.
 * A lock is removed if its `expires_at` has passed OR if its `acquired_at` is
 * older than the staleness threshold (30 min), even if the TTL has been
 * heartbeated. This prevents a hanging sync from holding the lock forever.
 */
function cleanStaleLocks(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const stalenessThreshold = new Date(Date.now() - LOCK_STALENESS_MS).toISOString();
  db.prepare(
    `DELETE FROM sync_lock WHERE expires_at < ? OR acquired_at < ?`
  ).run(now, stalenessThreshold);
}

export function acquireSyncLock(): boolean {
  const db = getDb();
  // Clean up expired and stale locks first
  cleanStaleLocks();

  try {
    db.prepare(`
      INSERT INTO sync_lock (lock_key, acquired_at, expires_at)
      VALUES ('global', ?, ?)
    `).run(
      new Date().toISOString(),
      new Date(Date.now() + LOCK_TTL_MS).toISOString()
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

/**
 * Force-release the sync lock regardless of TTL or staleness.
 * Returns info about the cleared lock for diagnostics, or null if no lock existed.
 */
export function forceReleaseSyncLock(): { acquired_at: string; expires_at: string } | null {
  const db = getDb();
  const existing = db.prepare(
    `SELECT acquired_at, expires_at FROM sync_lock WHERE lock_key = 'global'`
  ).get() as { acquired_at: string; expires_at: string } | undefined;
  if (existing) {
    db.prepare(`DELETE FROM sync_lock WHERE lock_key = 'global'`).run();
    return existing;
  }
  return null;
}

/** Extend the sync lock TTL (call periodically during long syncs) */
export function heartbeatSyncLock(): void {
  const db = getDb();
  db.prepare(`
    UPDATE sync_lock SET expires_at = ? WHERE lock_key = 'global'
  `).run(
    new Date(Date.now() + LOCK_TTL_MS).toISOString()
  );
}

/**
 * Check whether the sync lock is currently held.
 * Also returns diagnostic info about the lock if it exists.
 */
export function isSyncLocked(): boolean {
  const db = getDb();
  cleanStaleLocks();
  const row = db.prepare(`SELECT 1 FROM sync_lock WHERE lock_key = 'global'`).get();
  return !!row;
}

/**
 * Get detailed information about the current sync lock state.
 * Useful for operators diagnosing stuck syncs.
 */
export function getSyncLockInfo(): { locked: boolean; acquired_at?: string; expires_at?: string; age_seconds?: number } {
  const db = getDb();
  // No cleanStaleLocks() here — callers (isSyncLocked, acquireSyncLock) already clean.
  // This avoids redundant DELETE queries when getSyncLockInfo is called alongside them.
  const row = db.prepare(
    `SELECT acquired_at, expires_at FROM sync_lock WHERE lock_key = 'global'`
  ).get() as { acquired_at: string; expires_at: string } | undefined;
  if (!row) {
    return { locked: false };
  }
  const ageSeconds = Math.round((Date.now() - new Date(row.acquired_at).getTime()) / 1000);
  return {
    locked: true,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    age_seconds: ageSeconds,
  };
}

/** Clear sync_log entries where enterprise/org data returned 0 records, allowing re-sync */
export function clearEmptySyncEntries(enterpriseSlugs?: string[]): number {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const result = db.prepare(`
    DELETE FROM sync_log
    WHERE record_count = 0
      AND status = 'success'
      AND scope IN ('enterprise', 'org')
      AND day != '__none__'${ef.clause}
  `).run(...ef.params);
  return result.changes;
}
