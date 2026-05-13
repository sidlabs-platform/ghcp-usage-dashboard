// Summary table refresh logic — populates pre-aggregated tables after sync

import { getDb } from "./database";

/**
 * Refresh user_period_summary for a given date range.
 * Aggregates user_daily_metrics into per-user rollups.
 */
export function refreshUserSummary(periodStart: string, periodEnd: string, enterpriseSlug?: string): number {
  const db = getDb();
  const now = new Date().toISOString();

  // Delete existing entries for this period
  if (enterpriseSlug !== undefined) {
    db.prepare(`DELETE FROM user_period_summary WHERE period_start = ? AND period_end = ? AND enterprise_slug = ?`).run(periodStart, periodEnd, enterpriseSlug);
  } else {
    db.prepare(`DELETE FROM user_period_summary WHERE period_start = ? AND period_end = ?`).run(periodStart, periodEnd);
  }

  const enterpriseFilter = enterpriseSlug !== undefined ? `AND enterprise_slug = ?` : "";
  const extraParams = enterpriseSlug !== undefined ? [enterpriseSlug] : [];

  // Insert aggregated data directly from SQL
  const result = db.prepare(`
    INSERT INTO user_period_summary (
      enterprise_slug, user_login, period_start, period_end,
      active_days, loc_added, loc_deleted, interactions,
      code_gen, code_accept, acceptance_rate,
      used_agent, used_chat, used_cli,
      used_code_review_active, used_code_review_passive, used_coding_agent,
      computed_at
    )
    SELECT
      enterprise_slug,
      user_login,
      ? as period_start,
      ? as period_end,
      COUNT(DISTINCT day) as active_days,
      COALESCE(SUM(loc_added_sum), 0) as loc_added,
      COALESCE(SUM(loc_deleted_sum), 0) as loc_deleted,
      COALESCE(SUM(user_initiated_interaction_count), 0) as interactions,
      COALESCE(SUM(code_generation_activity_count), 0) as code_gen,
      COALESCE(SUM(code_acceptance_activity_count), 0) as code_accept,
      CASE
        WHEN COALESCE(SUM(code_generation_activity_count), 0) > 0
        THEN ROUND(CAST(SUM(code_acceptance_activity_count) AS REAL) / SUM(code_generation_activity_count) * 100, 1)
        ELSE 0
      END as acceptance_rate,
      MAX(used_agent) as used_agent,
      MAX(used_chat) as used_chat,
      MAX(used_cli) as used_cli,
      MAX(used_copilot_code_review_active) as used_code_review_active,
      MAX(used_copilot_code_review_passive) as used_code_review_passive,
      MAX(used_copilot_coding_agent) as used_coding_agent,
      ? as computed_at
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${enterpriseFilter}
    GROUP BY enterprise_slug, user_login
  `).run(periodStart, periodEnd, now, periodStart, periodEnd, ...extraParams);

  // Override acceptance_rate with completion-only rate (excludes agent_edit which
  // has code_generation_activity_count > 0 but code_acceptance_activity_count = 0,
  // deflating the top-level rate).
  db.prepare(`
    UPDATE user_period_summary SET acceptance_rate = COALESCE(f.rate, 0)
    FROM (
      SELECT u.enterprise_slug, u.user_login,
        CASE WHEN SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
            THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) > 0
          THEN ROUND(
            CAST(SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
              THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END) AS REAL) /
            SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
              THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END) * 100, 1)
          ELSE 0 END as rate
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day >= ? AND u.day <= ?
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'${enterpriseFilter}
      GROUP BY u.enterprise_slug, u.user_login
    ) f
    WHERE user_period_summary.enterprise_slug = f.enterprise_slug
      AND user_period_summary.user_login = f.user_login
      AND user_period_summary.period_start = ?
      AND user_period_summary.period_end = ?
  `).run(periodStart, periodEnd, ...extraParams, periodStart, periodEnd);

  return result.changes;
}

/**
 * Refresh daily_aggregate_cache for a single day.
 * Aggregates all user records for that day into a single row.
 */
export function refreshDailyAggregate(day: string, enterpriseSlug?: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  const enterpriseFilter = enterpriseSlug !== undefined ? `AND enterprise_slug = ?` : "";
  const extraParams = enterpriseSlug !== undefined ? [enterpriseSlug] : [];

  // Delete existing entries for this day (scoped by enterprise when provided)
  if (enterpriseSlug !== undefined) {
    db.prepare(`DELETE FROM daily_aggregate_cache WHERE day = ? AND enterprise_slug = ?`).run(day, enterpriseSlug);
  } else {
    db.prepare(`DELETE FROM daily_aggregate_cache WHERE day = ?`).run(day);
  }

  db.prepare(`
    INSERT INTO daily_aggregate_cache (
      enterprise_slug, day, total_users, active_users,
      loc_added, loc_deleted, code_gen, code_accept, interactions,
      agent_users, chat_users, cli_users, coding_agent_users, code_review_users,
      completion_loc_suggested, completion_loc_accepted, agent_loc_added,
      computed_at
    )
    SELECT
      enterprise_slug,
      ? as day,
      -- total_users and active_users are identical at daily granularity
      -- (every row in user_daily_metrics is an active user for that day)
      COUNT(DISTINCT user_login) as total_users,
      COUNT(DISTINCT user_login) as active_users,
      COALESCE(SUM(loc_added_sum), 0),
      COALESCE(SUM(loc_deleted_sum), 0),
      COALESCE(SUM(code_generation_activity_count), 0),
      COALESCE(SUM(code_acceptance_activity_count), 0),
      COALESCE(SUM(user_initiated_interaction_count), 0),
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END),
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END),
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END),
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END),
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END),
      -- placeholder LOC columns; updated below with json_each for accuracy
      0, 0, 0,
      ? as computed_at
    FROM user_daily_metrics
    WHERE day = ? ${enterpriseFilter}
    GROUP BY enterprise_slug
  `).run(day, now, day, ...extraParams);

  // Update completion/agent LOC from json_each(totals_by_feature) for accuracy.
  // Top-level loc_added_sum includes agent_edit writes; these subqueries separate them.
  db.prepare(`
    UPDATE daily_aggregate_cache SET
      completion_loc_suggested = COALESCE(f.cs, 0),
      completion_loc_accepted = COALESCE(f.ca, 0),
      agent_loc_added = COALESCE(f.aa, 0)
    FROM (
      SELECT u.enterprise_slug,
        SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
          THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END) as cs,
        SUM(CASE WHEN json_extract(j.value, '$.feature') != 'agent_edit'
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END) as ca,
        SUM(CASE WHEN json_extract(j.value, '$.feature') = 'agent_edit'
          THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END) as aa
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day = ? AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'${enterpriseFilter}
      GROUP BY u.enterprise_slug
    ) f
    WHERE daily_aggregate_cache.day = ?
      AND daily_aggregate_cache.enterprise_slug = f.enterprise_slug
  `).run(day, ...extraParams, day);
}

/**
 * Refresh daily_aggregate_cache for all days in a range.
 */
export function refreshDailyAggregateRange(startDay: string, endDay: string, enterpriseSlug?: string): number {
  const db = getDb();
  const enterpriseFilter = enterpriseSlug !== undefined ? ` AND enterprise_slug = ?` : "";
  const extraParams = enterpriseSlug !== undefined ? [enterpriseSlug] : [];
  const days = db.prepare(`
    SELECT DISTINCT day FROM user_daily_metrics WHERE day >= ? AND day <= ?${enterpriseFilter} ORDER BY day
  `).all(startDay, endDay, ...extraParams) as { day: string }[];

  for (const { day } of days) {
    refreshDailyAggregate(day, enterpriseSlug);
  }
  return days.length;
}

/**
 * Refresh team_summary_cache for all teams in a given date range.
 * Uses SQL aggregation with JOINs instead of loading all user records into memory.
 */
export function refreshTeamSummary(periodStart: string, periodEnd: string, enterpriseSlug?: string): number {
  const db = getDb();
  const now = new Date().toISOString();

  const enterpriseFilter = enterpriseSlug !== undefined ? ` AND enterprise_slug = ?` : "";
  const extraParams = enterpriseSlug !== undefined ? [enterpriseSlug] : [];

  // Delete existing entries for this period
  if (enterpriseSlug !== undefined) {
    db.prepare(`DELETE FROM team_summary_cache WHERE period_start = ? AND period_end = ? AND enterprise_slug = ?`).run(periodStart, periodEnd, enterpriseSlug);
  } else {
    db.prepare(`DELETE FROM team_summary_cache WHERE period_start = ? AND period_end = ?`).run(periodStart, periodEnd);
  }

  // Count total days in the period for avg calculation
  const dayCountRow = db.prepare(`
    SELECT COUNT(DISTINCT day) as cnt FROM user_daily_metrics WHERE day >= ? AND day <= ?${enterpriseFilter}
  `).get(periodStart, periodEnd, ...extraParams) as { cnt: number };
  const totalDays = dayCountRow?.cnt || 1;

  // Insert team summaries using a single SQL query with JOIN
  const result = db.prepare(`
    INSERT INTO team_summary_cache (
      enterprise_slug, team_slug, source, org_slug, team_name,
      period_start, period_end,
      total_members, active_members, avg_daily_active_users,
      total_loc_added, total_interactions, overall_acceptance_rate,
      agent_adoption_rate, chat_adoption_rate, cli_adoption_rate, code_review_adoption_rate,
      computed_at
    )
    SELECT
      t.enterprise_slug,
      t.team_slug,
      t.source,
      t.org_slug,
      t.team_name,
      ? as period_start,
      ? as period_end,
      t.member_count,
      COALESCE(m.active_members, 0),
      COALESCE(ROUND(CAST(m.total_active_days AS REAL) / ?, 1), 0),
      COALESCE(m.total_loc_added, 0),
      COALESCE(m.total_interactions, 0),
      CASE
        WHEN COALESCE(m.total_code_gen, 0) > 0
        THEN ROUND(CAST(m.total_code_accept AS REAL) / m.total_code_gen * 100, 1)
        ELSE 0
      END,
      CASE WHEN COALESCE(t.member_count, 0) > 0 THEN ROUND(CAST(m.agent_users AS REAL) / t.member_count * 100, 1) ELSE 0 END,
      CASE WHEN COALESCE(t.member_count, 0) > 0 THEN ROUND(CAST(m.chat_users AS REAL) / t.member_count * 100, 1) ELSE 0 END,
      CASE WHEN COALESCE(t.member_count, 0) > 0 THEN ROUND(CAST(m.cli_users AS REAL) / t.member_count * 100, 1) ELSE 0 END,
      CASE WHEN COALESCE(t.member_count, 0) > 0 THEN ROUND(CAST(m.code_review_users AS REAL) / t.member_count * 100, 1) ELSE 0 END,
      ? as computed_at
    FROM (
      SELECT enterprise_slug, team_slug, team_name, MAX(source) as source, org_slug, COUNT(DISTINCT user_login) as member_count
      FROM team_memberships
      WHERE 1=1${enterpriseFilter}
      GROUP BY enterprise_slug, team_slug, source, org_slug, team_name
    ) t
    LEFT JOIN (
      SELECT
        tm.enterprise_slug,
        tm.team_slug,
        tm.source,
        COUNT(DISTINCT u.user_login) as active_members,
        COUNT(DISTINCT u.day || ':' || u.user_login) as total_active_days,
        COALESCE(SUM(u.loc_added_sum), 0) as total_loc_added,
        COALESCE(SUM(u.user_initiated_interaction_count), 0) as total_interactions,
        COALESCE(SUM(u.code_generation_activity_count), 0) as total_code_gen,
        COALESCE(SUM(u.code_acceptance_activity_count), 0) as total_code_accept,
        COUNT(DISTINCT CASE WHEN u.used_agent = 1 THEN u.user_login END) as agent_users,
        COUNT(DISTINCT CASE WHEN u.used_chat = 1 THEN u.user_login END) as chat_users,
        COUNT(DISTINCT CASE WHEN u.used_cli = 1 THEN u.user_login END) as cli_users,
        COUNT(DISTINCT CASE WHEN u.used_copilot_code_review_active = 1 THEN u.user_login END) as code_review_users
      FROM team_memberships tm
      INNER JOIN user_daily_metrics u ON tm.user_login = u.user_login AND tm.enterprise_slug = u.enterprise_slug AND u.day >= ? AND u.day <= ?${enterpriseFilter.replace('enterprise_slug', 'u.enterprise_slug')}
      GROUP BY tm.enterprise_slug, tm.team_slug, tm.source
    ) m ON t.enterprise_slug = m.enterprise_slug AND t.team_slug = m.team_slug AND t.source = m.source
  `).run(periodStart, periodEnd, totalDays, now, ...extraParams, periodStart, periodEnd, ...extraParams);

  return result.changes;
}

/**
 * Refresh all summary tables after a sync completes.
 * Called from sync-service.ts at the end of fullSync().
 */
export function refreshAllSummaries(startDay: string, endDay: string, enterpriseSlug?: string): void {
  console.log(`[Summary] Refreshing summary tables for ${startDay} to ${endDay}...`);

  const userCount = refreshUserSummary(startDay, endDay, enterpriseSlug);
  console.log(`[Summary] Refreshed ${userCount} user summaries`);

  const dayCount = refreshDailyAggregateRange(startDay, endDay, enterpriseSlug);
  console.log(`[Summary] Refreshed ${dayCount} daily aggregates`);

  const teamCount = refreshTeamSummary(startDay, endDay, enterpriseSlug);
  console.log(`[Summary] Refreshed ${teamCount} team summaries`);
}
