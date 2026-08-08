// SQL-aggregated query layer for GitHub Copilot App analytics.
//
// Mirrors the conventions in `aggregation-queries.ts`: every aggregation is
// pushed into SQL (COALESCE(SUM(...), 0), json_each for JSON array columns),
// nothing loads full user-day rows into JS to aggregate, and all values are
// bound as parameters. Column/table names embedded in SQL strings are always
// fixed internal literals — never derived from request input.
//
// Copilot App data can appear in three independent places on a user-day row:
//   1. `used_copilot_app` — a boolean flag (true/false/NULL for legacy data).
//   2. `totals_by_copilot_app` — a dedicated JSON object with session/request/
//      prompt counts and token usage (NULL when App tracking isn't present).
//   3. `totals_by_feature` — the general feature-breakdown JSON array, which
//      may contain an entry with `feature = 'copilot_app'` carrying
//      generation/acceptance/LOC activity.
// The same user/day can appear once per enterprise (multi-enterprise
// membership); every query here deduplicates by (day, user_login) using
// MAX(...) before summing, since duplicate enterprise rows for the same
// user/day carry identical values.

import { getDb } from "./database";
import { buildLoginFilter, buildEnterpriseFilter } from "./aggregation-queries";
import type {
  CopilotAppKpis,
  CopilotAppAdoptionTrendPoint,
  CopilotAppCodeImpactPoint,
  CopilotAppBreakdown,
  CopilotAppAdopter,
  CopilotAppAggregateDay,
} from "@/lib/types/metrics";

/** SQL fragment: true when a user-day row carries any Copilot App signal at all
 * (used for "supported" / availability — including explicit zero activity). */
const HAS_APP_EVIDENCE_ANY = `(
  used_copilot_app IS NOT NULL
  OR totals_by_copilot_app IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM json_each(totals_by_feature) f
    WHERE json_extract(f.value, '$.feature') = 'copilot_app'
  )
)`;

/** SQL fragment: true when a user-day row shows *real* App activity (used for
 * the true "active adopter" count, as opposed to merely "supported"). */
const HAS_APP_ACTIVITY = `(
  used_copilot_app = 1
  OR (
    totals_by_copilot_app IS NOT NULL
    AND (
      COALESCE(json_extract(totals_by_copilot_app, '$.session_count'), 0) > 0
      OR COALESCE(json_extract(totals_by_copilot_app, '$.request_count'), 0) > 0
      OR COALESCE(json_extract(totals_by_copilot_app, '$.prompt_count'), 0) > 0
    )
  )
  OR EXISTS (
    SELECT 1 FROM json_each(totals_by_feature) f
    WHERE json_extract(f.value, '$.feature') = 'copilot_app'
      AND (
        COALESCE(json_extract(f.value, '$.user_initiated_interaction_count'), 0) > 0
        OR COALESCE(json_extract(f.value, '$.code_generation_activity_count'), 0) > 0
        OR COALESCE(json_extract(f.value, '$.code_acceptance_activity_count'), 0) > 0
        OR COALESCE(json_extract(f.value, '$.loc_added_sum'), 0) > 0
        OR COALESCE(json_extract(f.value, '$.loc_deleted_sum'), 0) > 0
      )
  )
)`;

/** SQL fragment: adopter-list inclusion rule — a true flag, non-null dedicated
 * App totals (even if all-zero), or the presence of an App feature row. */
const IS_APP_ADOPTER_ROW = `(
  used_copilot_app = 1
  OR totals_by_copilot_app IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM json_each(totals_by_feature) f
    WHERE json_extract(f.value, '$.feature') = 'copilot_app'
  )
)`;

/** Resolve the day/login/enterprise filter clauses shared by every query in
 * this module. `allowedLogins === undefined` means unfiltered; an explicit
 * empty array means "no rows" (never silently falls back to unfiltered). */
function resolveFilters(
  allowedLogins: string[] | undefined,
  enterpriseSlugs: string[] | undefined,
  loginColumn: string = "user_login",
  enterpriseColumn: string = "enterprise_slug",
): { login: { clause: string; params: string[] }; enterprise: { clause: string; params: string[] } } {
  const login =
    allowedLogins === undefined
      ? { clause: "", params: [] as string[] }
      : buildLoginFilter(allowedLogins, loginColumn, true);
  const enterprise = buildEnterpriseFilter(enterpriseSlugs, enterpriseColumn);
  return { login, enterprise };
}

// ── Period KPI summary ─────────────────────────────────────────────────

export interface CopilotAppUserSummaryResult extends CopilotAppKpis {
  /** Row count with any Copilot App evidence (flag, dedicated totals, or an
   * App feature row) — used by callers to decide whether App data exists. */
  supportedRows: number;
}

/**
 * Aggregate period-level Copilot App KPIs from `user_daily_metrics`.
 *
 * All aggregation happens in SQL via three independent queries (scalar
 * counts, dedicated-totals sums, App-feature sums) to avoid a JSON
 * cross-product between `totals_by_copilot_app` (a single object) and
 * `totals_by_feature` (an array). Same-login/same-day rows across multiple
 * enterprises are deduplicated with MAX before the final SUM.
 */
export function getCopilotAppUserSummary(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppUserSummaryResult {
  const db = getDb();
  const { login, enterprise } = resolveFilters(allowedLogins, enterpriseSlugs);

  const scalarSql = `
    SELECT
      COUNT(DISTINCT user_login) as periodActiveUsers,
      COUNT(DISTINCT CASE WHEN ${HAS_APP_ACTIVITY} THEN user_login END) as appActiveUsers,
      COUNT(CASE WHEN ${HAS_APP_EVIDENCE_ANY} THEN 1 END) as supportedRows
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${login.clause}${enterprise.clause}
  `;
  const scalarRow = db
    .prepare(scalarSql)
    .get(startDay, endDay, ...login.params, ...enterprise.params) as {
    periodActiveUsers: number;
    appActiveUsers: number;
    supportedRows: number;
  };

  const dedicatedSql = `
    WITH per_user_day AS (
      SELECT
        day,
        user_login,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.session_count'), 0)) as sessions,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.request_count'), 0)) as requests,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.prompt_count'), 0)) as prompts,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.token_usage.prompt_tokens_sum'), 0)) as promptTokens,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.token_usage.output_tokens_sum'), 0)) as outputTokens
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${login.clause}${enterprise.clause}
      GROUP BY day, user_login
    )
    SELECT
      COALESCE(SUM(sessions), 0) as sessions,
      COALESCE(SUM(requests), 0) as requests,
      COALESCE(SUM(prompts), 0) as prompts,
      COALESCE(SUM(promptTokens), 0) as promptTokens,
      COALESCE(SUM(outputTokens), 0) as outputTokens
    FROM per_user_day
  `;
  const dedicatedRow = db
    .prepare(dedicatedSql)
    .get(startDay, endDay, ...login.params, ...enterprise.params) as {
    sessions: number;
    requests: number;
    prompts: number;
    promptTokens: number;
    outputTokens: number;
  };

  const featureLogin = allowedLogins === undefined ? { clause: "", params: [] as string[] } : buildLoginFilter(allowedLogins, "u.user_login", true);
  const featureEnterprise = buildEnterpriseFilter(enterpriseSlugs, "u.enterprise_slug");
  const featureSql = `
    WITH app_feature AS (
      SELECT
        u.day,
        u.user_login,
        json_extract(j.value, '$.code_generation_activity_count') as generations,
        json_extract(j.value, '$.code_acceptance_activity_count') as acceptances,
        json_extract(j.value, '$.loc_added_sum') as locAdded,
        json_extract(j.value, '$.loc_deleted_sum') as locDeleted
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day >= ? AND u.day <= ? ${featureLogin.clause}${featureEnterprise.clause}
        AND json_extract(j.value, '$.feature') = 'copilot_app'
    ),
    per_user_day AS (
      SELECT
        day,
        user_login,
        MAX(COALESCE(generations, 0)) as generations,
        MAX(COALESCE(acceptances, 0)) as acceptances,
        MAX(COALESCE(locAdded, 0)) as locAdded,
        MAX(COALESCE(locDeleted, 0)) as locDeleted
      FROM app_feature
      GROUP BY day, user_login
    )
    SELECT
      COALESCE(SUM(generations), 0) as codeGenerations,
      COALESCE(SUM(acceptances), 0) as codeAcceptances,
      COALESCE(SUM(locAdded), 0) as locAdded,
      COALESCE(SUM(locDeleted), 0) as locDeleted
    FROM per_user_day
  `;
  const featureRow = db
    .prepare(featureSql)
    .get(startDay, endDay, ...featureLogin.params, ...featureEnterprise.params) as {
    codeGenerations: number;
    codeAcceptances: number;
    locAdded: number;
    locDeleted: number;
  };

  const adoptionRate =
    scalarRow.periodActiveUsers > 0 ? (scalarRow.appActiveUsers / scalarRow.periodActiveUsers) * 100 : 0;
  const avgTokensPerRequest =
    dedicatedRow.requests > 0
      ? Math.round(((dedicatedRow.promptTokens + dedicatedRow.outputTokens) / dedicatedRow.requests) * 10) / 10
      : 0;

  return {
    periodActiveUsers: scalarRow.periodActiveUsers,
    appActiveUsers: scalarRow.appActiveUsers,
    adoptionRate,
    sessions: dedicatedRow.sessions,
    requests: dedicatedRow.requests,
    prompts: dedicatedRow.prompts,
    promptTokens: dedicatedRow.promptTokens,
    outputTokens: dedicatedRow.outputTokens,
    avgTokensPerRequest,
    codeGenerations: featureRow.codeGenerations,
    codeAcceptances: featureRow.codeAcceptances,
    locAdded: featureRow.locAdded,
    locDeleted: featureRow.locDeleted,
    locChanged: featureRow.locAdded + featureRow.locDeleted,
    supportedRows: scalarRow.supportedRows,
  };
}

// ── Daily trends ────────────────────────────────────────────────────────

/**
 * Daily Copilot App adoption/usage trend (active users, sessions, requests,
 * prompts), deduplicated per (day, user_login) across enterprises and
 * sorted by day ascending.
 */
export function getCopilotAppDailyUsage(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppAdoptionTrendPoint[] {
  const db = getDb();
  const { login, enterprise } = resolveFilters(allowedLogins, enterpriseSlugs);

  const sql = `
    WITH per_user_day AS (
      SELECT
        day,
        user_login,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.session_count'), 0)) as sessions,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.request_count'), 0)) as requests,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.prompt_count'), 0)) as prompts,
        MAX(CASE WHEN ${HAS_APP_ACTIVITY} THEN 1 ELSE 0 END) as isActive
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${login.clause}${enterprise.clause}
      GROUP BY day, user_login
    )
    SELECT
      day,
      COUNT(DISTINCT CASE WHEN isActive = 1 THEN user_login END) as activeUsers,
      COALESCE(SUM(sessions), 0) as sessions,
      COALESCE(SUM(requests), 0) as requests,
      COALESCE(SUM(prompts), 0) as prompts
    FROM per_user_day
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...login.params, ...enterprise.params) as CopilotAppAdoptionTrendPoint[];
}

/**
 * Daily Copilot App code-impact trend (generations, acceptances, LOC added
 * and deleted) sourced exclusively from `totals_by_feature` rows where
 * `feature = 'copilot_app'`, deduplicated per (day, user_login) and sorted
 * by day ascending.
 */
export function getCopilotAppDailyCodeImpact(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppCodeImpactPoint[] {
  const db = getDb();
  const login = allowedLogins === undefined ? { clause: "", params: [] as string[] } : buildLoginFilter(allowedLogins, "u.user_login", true);
  const enterprise = buildEnterpriseFilter(enterpriseSlugs, "u.enterprise_slug");

  const sql = `
    WITH app_feature AS (
      SELECT
        u.day,
        u.user_login,
        json_extract(j.value, '$.code_generation_activity_count') as generations,
        json_extract(j.value, '$.code_acceptance_activity_count') as acceptances,
        json_extract(j.value, '$.loc_added_sum') as locAdded,
        json_extract(j.value, '$.loc_deleted_sum') as locDeleted
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.day >= ? AND u.day <= ? ${login.clause}${enterprise.clause}
        AND json_extract(j.value, '$.feature') = 'copilot_app'
    ),
    per_user_day AS (
      SELECT
        day,
        user_login,
        MAX(COALESCE(generations, 0)) as generations,
        MAX(COALESCE(acceptances, 0)) as acceptances,
        MAX(COALESCE(locAdded, 0)) as locAdded,
        MAX(COALESCE(locDeleted, 0)) as locDeleted
      FROM app_feature
      GROUP BY day, user_login
    )
    SELECT
      day,
      COALESCE(SUM(generations), 0) as generations,
      COALESCE(SUM(acceptances), 0) as acceptances,
      COALESCE(SUM(locAdded), 0) as locAdded,
      COALESCE(SUM(locDeleted), 0) as locDeleted
    FROM per_user_day
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...login.params, ...enterprise.params) as CopilotAppCodeImpactPoint[];
}

// ── Model / language breakdown ──────────────────────────────────────────

/**
 * Copilot App model usage breakdown from `totals_by_model_feature`, filtered
 * to `feature = 'copilot_app'`, deduplicated per (day, user_login, model)
 * across enterprises, and sorted by interactions descending.
 */
export function getCopilotAppModelBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppBreakdown[] {
  const db = getDb();
  const login = allowedLogins === undefined ? { clause: "", params: [] as string[] } : buildLoginFilter(allowedLogins, "u.user_login", true);
  const enterprise = buildEnterpriseFilter(enterpriseSlugs, "u.enterprise_slug");

  const sql = `
    WITH raw AS (
      SELECT
        u.day,
        u.user_login,
        json_extract(j.value, '$.model') as model,
        json_extract(j.value, '$.user_initiated_interaction_count') as interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.day >= ? AND u.day <= ? ${login.clause}${enterprise.clause}
        AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
        AND json_extract(j.value, '$.feature') = 'copilot_app'
    ),
    deduped AS (
      SELECT day, user_login, model, MAX(COALESCE(interactions, 0)) as interactions
      FROM raw
      GROUP BY day, user_login, model
    )
    SELECT model as name, COALESCE(SUM(interactions), 0) as interactions
    FROM deduped
    GROUP BY model
    ORDER BY interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...login.params, ...enterprise.params) as CopilotAppBreakdown[];
}

/**
 * Copilot App language usage breakdown from `totals_by_language_feature`,
 * filtered to `feature = 'copilot_app'`, deduplicated per
 * (day, user_login, language) across enterprises, and sorted by LOC added
 * descending. `totals_by_language_feature` has no interaction-count field,
 * so `interactions` here is the summed `code_generation_activity_count`.
 */
export function getCopilotAppLanguageBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppBreakdown[] {
  const db = getDb();
  const login = allowedLogins === undefined ? { clause: "", params: [] as string[] } : buildLoginFilter(allowedLogins, "u.user_login", true);
  const enterprise = buildEnterpriseFilter(enterpriseSlugs, "u.enterprise_slug");

  const sql = `
    WITH raw AS (
      SELECT
        u.day,
        u.user_login,
        json_extract(j.value, '$.language') as language,
        json_extract(j.value, '$.code_generation_activity_count') as generations,
        json_extract(j.value, '$.loc_added_sum') as locAdded,
        json_extract(j.value, '$.loc_deleted_sum') as locDeleted
      FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
      WHERE u.day >= ? AND u.day <= ? ${login.clause}${enterprise.clause}
        AND u.totals_by_language_feature IS NOT NULL AND u.totals_by_language_feature != '[]'
        AND json_extract(j.value, '$.feature') = 'copilot_app'
    ),
    deduped AS (
      SELECT
        day, user_login, language,
        MAX(COALESCE(generations, 0)) as generations,
        MAX(COALESCE(locAdded, 0)) as locAdded,
        MAX(COALESCE(locDeleted, 0)) as locDeleted
      FROM raw
      GROUP BY day, user_login, language
    )
    SELECT
      language as name,
      COALESCE(SUM(generations), 0) as interactions,
      COALESCE(SUM(locAdded), 0) as locAdded,
      COALESCE(SUM(locDeleted), 0) as locDeleted
    FROM deduped
    GROUP BY language
    ORDER BY locAdded DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...login.params, ...enterprise.params) as CopilotAppBreakdown[];
}

// ── Row-count guard ──────────────────────────────────────────────────────

const COPILOT_APP_ROW_COUNT_THRESHOLD = 500_000;

/**
 * Estimate the number of `user_daily_metrics` rows in scope for Copilot App
 * queries. Uses the App-aware login-filter semantics: `allowedLogins`
 * explicitly set to an empty array yields a zero count (never falls back to
 * unfiltered), while `undefined` means unfiltered.
 */
export function estimateCopilotAppRowCount(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): { count: number; exceeds: boolean } {
  const db = getDb();
  const { login, enterprise } = resolveFilters(allowedLogins, enterpriseSlugs);
  const sql = `
    SELECT COUNT(*) as cnt FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${login.clause}${enterprise.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...login.params, ...enterprise.params) as { cnt: number };
  return { count: row.cnt, exceeds: row.cnt > COPILOT_APP_ROW_COUNT_THRESHOLD };
}

// ── Enterprise / organization aggregate fallback ────────────────────────

interface RawAggregateDayRow {
  day: string;
  sourceActiveUsers: number;
  activeUsers: number;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  isSupportedFlag: number;
}

function mapAggregateDayRow(r: RawAggregateDayRow): CopilotAppAggregateDay {
  return {
    day: r.day,
    sourceActiveUsers: r.sourceActiveUsers,
    activeUsers: r.activeUsers,
    sessions: r.sessions,
    requests: r.requests,
    prompts: r.prompts,
    promptTokens: r.promptTokens,
    outputTokens: r.outputTokens,
    generations: r.generations,
    acceptances: r.acceptances,
    locAdded: r.locAdded,
    locDeleted: r.locDeleted,
    isSupported: r.isSupportedFlag === 1,
  };
}

/** Shared CTE body for the enterprise/org aggregate fallback queries. Always
 * reads from a single fixed table name supplied internally (never from
 * caller/request input) and never cross-joins the dedicated-totals fields
 * with the `totals_by_feature` array in the same GROUP BY. */
function aggregateDailySql(table: "enterprise_daily_metrics" | "org_daily_metrics", extraWhere: string): string {
  return `
    WITH base AS (
      SELECT day, daily_active_users, daily_active_copilot_app_users, totals_by_copilot_app, totals_by_feature
      FROM ${table}
      WHERE day >= ? AND day <= ? ${extraWhere}
    ),
    dedicated AS (
      SELECT
        day,
        COALESCE(SUM(daily_active_users), 0) as sourceActiveUsers,
        COALESCE(SUM(daily_active_copilot_app_users), 0) as activeUsers,
        COALESCE(SUM(json_extract(totals_by_copilot_app, '$.session_count')), 0) as sessions,
        COALESCE(SUM(json_extract(totals_by_copilot_app, '$.request_count')), 0) as requests,
        COALESCE(SUM(json_extract(totals_by_copilot_app, '$.prompt_count')), 0) as prompts,
        COALESCE(SUM(json_extract(totals_by_copilot_app, '$.token_usage.prompt_tokens_sum')), 0) as promptTokens,
        COALESCE(SUM(json_extract(totals_by_copilot_app, '$.token_usage.output_tokens_sum')), 0) as outputTokens,
        MAX(CASE WHEN daily_active_copilot_app_users IS NOT NULL OR totals_by_copilot_app IS NOT NULL THEN 1 ELSE 0 END) as flagSupported
      FROM base
      GROUP BY day
    ),
    feature_totals AS (
      SELECT
        b.day,
        COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) as generations,
        COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) as acceptances,
        COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
        COALESCE(SUM(json_extract(j.value, '$.loc_deleted_sum')), 0) as locDeleted
      FROM base b, json_each(b.totals_by_feature) j
      WHERE json_extract(j.value, '$.feature') = 'copilot_app'
      GROUP BY b.day
    )
    SELECT
      d.day as day,
      d.sourceActiveUsers as sourceActiveUsers,
      d.activeUsers as activeUsers,
      d.sessions as sessions,
      d.requests as requests,
      d.prompts as prompts,
      d.promptTokens as promptTokens,
      d.outputTokens as outputTokens,
      COALESCE(ft.generations, 0) as generations,
      COALESCE(ft.acceptances, 0) as acceptances,
      COALESCE(ft.locAdded, 0) as locAdded,
      COALESCE(ft.locDeleted, 0) as locDeleted,
      CASE WHEN d.flagSupported = 1 OR ft.day IS NOT NULL THEN 1 ELSE 0 END as isSupportedFlag
    FROM dedicated d
    LEFT JOIN feature_totals ft ON ft.day = d.day
    WHERE d.flagSupported = 1 OR ft.day IS NOT NULL
    ORDER BY d.day ASC
  `;
}

/**
 * Enterprise-level Copilot App daily activity, aggregated from the fixed
 * `enterprise_daily_metrics` table only (never a caller-provided table name).
 * A day is included when App tracking is supported (a non-null active-user
 * field, non-null dedicated totals, or an App feature row) — even when all
 * activity values are zero — and excluded only when no App evidence exists
 * for any included enterprise on that day.
 */
export function getEnterpriseCopilotAppDaily(
  startDay: string,
  endDay: string,
  enterpriseSlugs?: string[],
): CopilotAppAggregateDay[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs, "enterprise_slug");
  const sql = aggregateDailySql("enterprise_daily_metrics", ef.clause);
  const rows = db.prepare(sql).all(startDay, endDay, ...ef.params) as RawAggregateDayRow[];
  return rows.map(mapAggregateDayRow);
}

/**
 * Organization-level Copilot App daily activity, aggregated from the fixed
 * `org_daily_metrics` table only (never a caller-provided table name).
 * Same availability semantics as {@link getEnterpriseCopilotAppDaily}.
 */
export function getOrganizationCopilotAppDaily(
  orgSlug: string,
  startDay: string,
  endDay: string,
  enterpriseSlugs?: string[],
): CopilotAppAggregateDay[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs, "enterprise_slug");
  const sql = aggregateDailySql("org_daily_metrics", `AND org_slug = ? ${ef.clause}`);
  const rows = db.prepare(sql).all(startDay, endDay, orgSlug, ...ef.params) as RawAggregateDayRow[];
  return rows.map(mapAggregateDayRow);
}

// ── Adopters (paginated) ─────────────────────────────────────────────────

const ADOPTER_SORT_COLUMNS: Record<string, string> = {
  login: "login",
  activeDays: "activeDays",
  sessions: "sessions",
  requests: "requests",
  prompts: "prompts",
  promptTokens: "promptTokens",
  outputTokens: "outputTokens",
  locAdded: "locAdded",
  locDeleted: "locDeleted",
};

export interface CopilotAppAdoptersResult {
  adopters: CopilotAppAdopter[];
  total: number;
}

/**
 * Paginated Copilot App adopter roster. A login is included when it has a
 * true `used_copilot_app` flag, non-null dedicated App totals (even if
 * all-zero), or an App feature row — deduplicated per (day, user_login)
 * across enterprises before summing period totals. Sorting is restricted to
 * a fixed column allowlist; an unrecognized `sortField` falls back to
 * `sessions` and a non-"asc" `sortDir` is treated as `desc`.
 */
export function getCopilotAppAdopters(
  startDay: string,
  endDay: string,
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  search?: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CopilotAppAdoptersResult {
  const db = getDb();
  const { login, enterprise } = resolveFilters(allowedLogins, enterpriseSlugs);
  const searchClause = search ? "AND user_login LIKE ?" : "";
  const searchParams = search ? [`%${search}%`] : [];
  const sqlSort = ADOPTER_SORT_COLUMNS[sortField] ?? "sessions";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";

  const cteSql = `
    WITH app_rows AS (
      SELECT day, user_login, totals_by_copilot_app, totals_by_feature
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ? ${login.clause}${enterprise.clause} ${searchClause}
        AND ${IS_APP_ADOPTER_ROW}
    ),
    dedicated_per_day AS (
      SELECT
        day,
        user_login,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.session_count'), 0)) as sessions,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.request_count'), 0)) as requests,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.prompt_count'), 0)) as prompts,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.token_usage.prompt_tokens_sum'), 0)) as promptTokens,
        MAX(COALESCE(json_extract(totals_by_copilot_app, '$.token_usage.output_tokens_sum'), 0)) as outputTokens
      FROM app_rows
      GROUP BY day, user_login
    ),
    feature_per_day AS (
      SELECT
        ar.day,
        ar.user_login,
        MAX(COALESCE(json_extract(j.value, '$.loc_added_sum'), 0)) as locAdded,
        MAX(COALESCE(json_extract(j.value, '$.loc_deleted_sum'), 0)) as locDeleted
      FROM app_rows ar, json_each(ar.totals_by_feature) j
      WHERE json_extract(j.value, '$.feature') = 'copilot_app'
      GROUP BY ar.day, ar.user_login
    ),
    per_day AS (
      SELECT
        d.day as day,
        d.user_login as user_login,
        d.sessions as sessions,
        d.requests as requests,
        d.prompts as prompts,
        d.promptTokens as promptTokens,
        d.outputTokens as outputTokens,
        COALESCE(f.locAdded, 0) as locAdded,
        COALESCE(f.locDeleted, 0) as locDeleted
      FROM dedicated_per_day d
      LEFT JOIN feature_per_day f ON f.day = d.day AND f.user_login = d.user_login
    ),
    totals AS (
      SELECT
        user_login as login,
        COUNT(DISTINCT day) as activeDays,
        COALESCE(SUM(sessions), 0) as sessions,
        COALESCE(SUM(requests), 0) as requests,
        COALESCE(SUM(prompts), 0) as prompts,
        COALESCE(SUM(promptTokens), 0) as promptTokens,
        COALESCE(SUM(outputTokens), 0) as outputTokens,
        COALESCE(SUM(locAdded), 0) as locAdded,
        COALESCE(SUM(locDeleted), 0) as locDeleted
      FROM per_day
      GROUP BY user_login
    )
  `;
  const cteParams = [startDay, endDay, ...login.params, ...enterprise.params, ...searchParams];

  const countSql = `${cteSql} SELECT COUNT(*) as total FROM totals`;
  const countRow = db.prepare(countSql).get(...cteParams) as { total: number };

  const offset = (page - 1) * pageSize;
  const dataSql = `${cteSql} SELECT * FROM totals ORDER BY ${sqlSort} ${sqlDir}, login ASC LIMIT ? OFFSET ?`;
  const rows = db.prepare(dataSql).all(...cteParams, pageSize, offset) as CopilotAppAdopter[];

  return { adopters: rows, total: countRow.total };
}
