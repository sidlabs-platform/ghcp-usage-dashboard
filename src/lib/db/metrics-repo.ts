// Metrics repository — CRUD for enterprise/org/user daily metrics in SQLite

import { getDb } from "./database";
import type { DayTotal, UserDayRecord } from "@/lib/types/metrics";

// ── Enterprise ID resolution ──────────────────────────────────────────

/** Resolve the numeric enterprise_id from any stored data (user metrics store it) */
export function resolveEnterpriseId(): string | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT DISTINCT enterprise_id FROM user_daily_metrics LIMIT 1`
  ).get() as { enterprise_id: string } | undefined;
  return row?.enterprise_id || null;
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
    SELECT raw_json FROM enterprise_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(enterpriseId, startDay, endDay) as { raw_json: string }[];

  return rows.map((r) => JSON.parse(r.raw_json));
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
    SELECT raw_json FROM org_daily_metrics
    WHERE org_slug = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(orgSlug, startDay, endDay) as { raw_json: string }[];

  return rows.map((r) => JSON.parse(r.raw_json));
}

export function getAllOrgSlugs(): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT DISTINCT org_slug FROM org_daily_metrics`).all() as { org_slug: string }[];
  return rows.map((r) => r.org_slug);
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
    SELECT raw_json FROM user_daily_metrics
    WHERE enterprise_id = ? AND day >= ? AND day <= ?
    ORDER BY day ASC, user_login ASC
  `).all(enterpriseId, startDay, endDay) as { raw_json: string }[];

  return rows.map((r) => JSON.parse(r.raw_json));
}

export function getUserMetricsByLogin(userLogin: string, startDay: string, endDay: string): UserDayRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT raw_json FROM user_daily_metrics
    WHERE user_login = ? AND day >= ? AND day <= ?
    ORDER BY day ASC
  `).all(userLogin, startDay, endDay) as { raw_json: string }[];

  return rows.map((r) => JSON.parse(r.raw_json));
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
    SELECT raw_json FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
    ORDER BY day ASC, user_login ASC
  `).all(startDay, endDay) as { raw_json: string }[];

  return rows.map((r) => JSON.parse(r.raw_json));
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
