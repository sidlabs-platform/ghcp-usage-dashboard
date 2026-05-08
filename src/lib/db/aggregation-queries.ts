import { getDb } from "./database";

export interface ChatModeSums {
  ask: number;
  edit: number;
  plan: number;
  agent: number;
  custom: number;
  unknown: number;
}

export interface AdoptionStats {
  totalUsers: number;
  agentUsers: number;
  codingAgentUsers: number;
  codeReviewUsers: number;
  cliUsers: number;
  chatUsers: number;
}

export interface UserSummary {
  login: string;
  activeDays: number;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  codeGen: number;
  codeAccept: number;
  acceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReviewActive: boolean;
  usedCodeReviewPassive: boolean;
  usedCodingAgent: boolean;
}

// ── SQL-aggregated breakdown types ────────────────────────────────────

export interface ModelBreakdownRow {
  model: string;
  interactions: number;
}

export interface ModelByFeatureRow {
  model: string;
  feature: string;
  interactions: number;
}

export interface ModelByLanguageRow {
  model: string;
  language: string;
  interactions: number;
}

export interface ModelTrendRow {
  day: string;
  model: string;
  interactions: number;
}

export interface LanguageBreakdownRow {
  language: string;
  locAdded: number;
  locSuggested: number;
}

export interface FeatureBreakdownRow {
  feature: string;
  locAdded: number;
  interactions: number;
  acceptances: number;
}

export interface FeatureDailyRow {
  day: string;
  feature: string;
  interactions: number;
}

export interface IdeBreakdownRow {
  ide: string;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  generations: number;
  acceptances: number;
}

export interface IdeTrendRow {
  day: string;
  ide: string;
  interactions: number;
}

export interface LanguageByFeatureRow {
  language: string;
  locAdded: number;
  locDeleted: number;
  generations: number;
  acceptances: number;
}

export interface CompletionDailyRow {
  day: string;
  completionSuggested: number;
  completionAccepted: number;
  agentAdded: number;
  agentDeleted: number;
  compGenCount: number;
  compAcceptCount: number;
}

export interface CliUserRow {
  login: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  days: number;
}

function buildLoginFilter(allowedLogins: string[]): { clause: string; params: string[] } {
  if (allowedLogins.length === 0) return { clause: "", params: [] };
  const placeholders = allowedLogins.map(() => "?").join(",");
  return { clause: `AND user_login IN (${placeholders})`, params: allowedLogins };
}

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

export function getChatModeSums(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ChatModeSums {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      COALESCE(SUM(chat_panel_ask_mode), 0) as ask,
      COALESCE(SUM(chat_panel_edit_mode), 0) as edit,
      COALESCE(SUM(chat_panel_plan_mode), 0) as plan,
      COALESCE(SUM(chat_panel_agent_mode), 0) as agent,
      COALESCE(SUM(chat_panel_custom_mode), 0) as custom,
      COALESCE(SUM(chat_panel_unknown_mode), 0) as unknown
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as ChatModeSums | undefined;
  return row ?? { ask: 0, edit: 0, plan: 0, agent: 0, custom: 0, unknown: 0 };
}

export function getAdoptionStats(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): AdoptionStats {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      COUNT(DISTINCT user_login) as totalUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END) as codingAgentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END) as codeReviewUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers,
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as AdoptionStats;
  return row;
}

export function getUserSummaries(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): UserSummary[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      user_login as login,
      COUNT(DISTINCT day) as activeDays,
      COALESCE(SUM(loc_added_sum), 0) as locAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as locDeleted,
      COALESCE(SUM(user_initiated_interaction_count), 0) as interactions,
      COALESCE(SUM(code_generation_activity_count), 0) as codeGen,
      COALESCE(SUM(code_acceptance_activity_count), 0) as codeAccept,
      MAX(used_agent) as usedAgent,
      MAX(used_chat) as usedChat,
      MAX(used_cli) as usedCli,
      MAX(used_copilot_code_review_active) as usedCodeReviewActive,
      MAX(used_copilot_code_review_passive) as usedCodeReviewPassive,
      MAX(used_copilot_coding_agent) as usedCodingAgent
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY user_login
  `;
  const rows = db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as Array<{
    login: string;
    activeDays: number;
    locAdded: number;
    locDeleted: number;
    interactions: number;
    codeGen: number;
    codeAccept: number;
    usedAgent: number;
    usedChat: number;
    usedCli: number;
    usedCodeReviewActive: number;
    usedCodeReviewPassive: number;
    usedCodingAgent: number;
  }>;

  return rows.map((r) => ({
    login: r.login,
    activeDays: r.activeDays,
    locAdded: r.locAdded,
    locDeleted: r.locDeleted,
    interactions: r.interactions,
    codeGen: r.codeGen,
    codeAccept: r.codeAccept,
    acceptanceRate: r.codeGen > 0 ? Number(((r.codeAccept / r.codeGen) * 100).toFixed(1)) : 0,
    usedAgent: r.usedAgent === 1,
    usedChat: r.usedChat === 1,
    usedCli: r.usedCli === 1,
    usedCodeReviewActive: r.usedCodeReviewActive === 1,
    usedCodeReviewPassive: r.usedCodeReviewPassive === 1,
    usedCodingAgent: r.usedCodingAgent === 1,
  }));
}

export interface PaginatedUserSummaries {
  users: UserSummary[];
  total: number;
}

export function getUserSummariesPaginated(
  startDay: string,
  endDay: string,
  page: number,
  pageSize: number,
  sortField: string,
  sortDir: "asc" | "desc",
  search?: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): PaginatedUserSummaries {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const searchClause = search ? `AND user_login LIKE ?` : "";
  const searchParam = search ? [`%${search}%`] : [];

  // Allowed sort columns (prevent SQL injection)
  const sortColumns: Record<string, string> = {
    login: "user_login",
    activeDays: "activeDays",
    locAdded: "locAdded",
    interactions: "interactions",
    acceptanceRate: "acceptanceRate",
    codeGen: "codeGen",
  };
  const sqlSort = sortColumns[sortField] || "activeDays";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";

  const baseSql = `
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause} ${searchClause}${ef.clause}
  `;
  const baseParams = [startDay, endDay, ...filter.params, ...searchParam, ...ef.params];

  // Count total distinct users (subquery ensures count matches GROUP BY result set)
  const countSql = `
    SELECT COUNT(*) as total FROM (
      SELECT user_login ${baseSql} GROUP BY user_login
    )
  `;
  const countRow = db.prepare(countSql).get(...baseParams) as { total: number };

  // Paginated data
  const dataSql = `
    SELECT
      user_login as login,
      COUNT(DISTINCT day) as activeDays,
      COALESCE(SUM(loc_added_sum), 0) as locAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as locDeleted,
      COALESCE(SUM(user_initiated_interaction_count), 0) as interactions,
      COALESCE(SUM(code_generation_activity_count), 0) as codeGen,
      COALESCE(SUM(code_acceptance_activity_count), 0) as codeAccept,
      MAX(used_agent) as usedAgent,
      MAX(used_chat) as usedChat,
      MAX(used_cli) as usedCli,
      MAX(used_copilot_code_review_active) as usedCodeReviewActive,
      MAX(used_copilot_code_review_passive) as usedCodeReviewPassive,
      MAX(used_copilot_coding_agent) as usedCodingAgent
    ${baseSql}
    GROUP BY user_login
    ORDER BY ${sqlSort} ${sqlDir}
    LIMIT ? OFFSET ?
  `;
  const offset = (page - 1) * pageSize;
  const rows = db.prepare(dataSql).all(...baseParams, pageSize, offset) as Array<{
    login: string; activeDays: number; locAdded: number; locDeleted: number;
    interactions: number; codeGen: number; codeAccept: number;
    usedAgent: number; usedChat: number; usedCli: number;
    usedCodeReviewActive: number; usedCodeReviewPassive: number; usedCodingAgent: number;
  }>;

  const users = rows.map((r) => ({
    login: r.login,
    activeDays: r.activeDays,
    locAdded: r.locAdded,
    locDeleted: r.locDeleted,
    interactions: r.interactions,
    codeGen: r.codeGen,
    codeAccept: r.codeAccept,
    acceptanceRate: r.codeGen > 0 ? Number(((r.codeAccept / r.codeGen) * 100).toFixed(1)) : 0,
    usedAgent: r.usedAgent === 1,
    usedChat: r.usedChat === 1,
    usedCli: r.usedCli === 1,
    usedCodeReviewActive: r.usedCodeReviewActive === 1,
    usedCodeReviewPassive: r.usedCodeReviewPassive === 1,
    usedCodingAgent: r.usedCodingAgent === 1,
  }));

  return { users, total: countRow.total };
}

// ── Row-count guard ───────────────────────────────────────────────────

const ROW_COUNT_THRESHOLD = 500_000;

/**
 * Estimate the number of user_daily_metrics rows for a date range.
 * Returns 400-safe error message if the estimated count exceeds threshold.
 */
export function estimateRowCount(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): { count: number; exceeds: boolean } {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT COUNT(*) as cnt FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as { cnt: number };
  return { count: row.cnt, exceeds: row.cnt > ROW_COUNT_THRESHOLD };
}

// ── Model breakdown (SQL via json_each) ───────────────────────────────

/** Aggregate model usage across all users using json_each on totals_by_model_feature */
export function getModelBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ModelBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.model') as model,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY model
    ORDER BY interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as ModelBreakdownRow[];
}

/** Model × Feature breakdown via json_each */
export function getModelByFeatureBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ModelByFeatureRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.model') as model,
      json_extract(j.value, '$.feature') as feature,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY model, feature
    ORDER BY interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as ModelByFeatureRow[];
}

/** Model usage trend by day (top N models) via json_each */
export function getModelTrend(
  startDay: string,
  endDay: string,
  topModels: string[],
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ModelTrendRow[] {
  if (topModels.length === 0) return [];
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const modelPlaceholders = topModels.map(() => '?').join(',');
  const sql = `
    SELECT
      u.day,
      json_extract(j.value, '$.model') as model,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_model_feature IS NOT NULL AND u.totals_by_model_feature != '[]'
      AND json_extract(j.value, '$.model') IN (${modelPlaceholders})
      ${filter.clause}${ef.clause}
    GROUP BY u.day, model
    ORDER BY u.day ASC, interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...topModels, ...filter.params, ...ef.params) as ModelTrendRow[];
}

/** Model × Language breakdown via json_each on totals_by_language_model */
export function getModelByLanguageBreakdown(
  startDay: string,
  endDay: string,
  limit: number = 50,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ModelByLanguageRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.model') as model,
      json_extract(j.value, '$.language') as language,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_language_model) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_language_model IS NOT NULL AND u.totals_by_language_model != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY model, language
    ORDER BY interactions DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params, limit) as ModelByLanguageRow[];
}

// ── Language breakdown (SQL via json_each) ────────────────────────────

/** Aggregate language usage from totals_by_language_feature */
export function getLanguageBreakdown(
  startDay: string,
  endDay: string,
  limit: number = 15,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): LanguageBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.language') as language,
      COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
      COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_add_sum')), 0) as locSuggested
    FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_language_feature IS NOT NULL AND u.totals_by_language_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY language
    ORDER BY locAdded DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params, limit) as LanguageBreakdownRow[];
}

/** Full language breakdown with generations/acceptances from totals_by_language_feature */
export function getLanguageByFeatureBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): LanguageByFeatureRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.language') as language,
      COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
      COALESCE(SUM(json_extract(j.value, '$.loc_deleted_sum')), 0) as locDeleted,
      COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) as generations,
      COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) as acceptances
    FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_language_feature IS NOT NULL AND u.totals_by_language_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY language
    ORDER BY locAdded DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as LanguageByFeatureRow[];
}

// ── Feature breakdown (SQL via json_each) ─────────────────────────────

/** Aggregate feature usage from totals_by_feature */
export function getFeatureBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): FeatureBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.feature') as feature,
      COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions,
      COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) as acceptances
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY feature
    ORDER BY locAdded DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as FeatureBreakdownRow[];
}

/** Feature usage trend by day via json_each */
export function getFeatureDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): FeatureDailyRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      u.day,
      json_extract(j.value, '$.feature') as feature,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY u.day, feature
    ORDER BY u.day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as FeatureDailyRow[];
}

// ── Completion vs Agent daily trend (SQL via json_each) ───────────────

const COMPLETION_FEATURES_SQL = "('code_completion','inline_chat','chat_panel')";
const AGENT_FEATURES_SQL = "('agent_edit')";

/** Daily completion vs agent LOC metrics aggregated via json_each */
export function getCompletionDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CompletionDailyRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      u.day,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${AGENT_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${AGENT_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as agentDeleted,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY u.day
    ORDER BY u.day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as CompletionDailyRow[];
}

/** Aggregate completion vs agent totals for the whole period */
export function getCompletionTotals(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CompletionDailyRow {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      '' as day,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${AGENT_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${AGENT_FEATURES_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as agentDeleted,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
      COALESCE(SUM(CASE WHEN json_extract(j.value, '$.feature') IN ${COMPLETION_FEATURES_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as CompletionDailyRow | undefined;
  return row ?? { day: '', completionSuggested: 0, completionAccepted: 0, agentAdded: 0, agentDeleted: 0, compGenCount: 0, compAcceptCount: 0 };
}

// ── IDE breakdown (SQL via json_each) ─────────────────────────────────

/** Aggregate IDE usage from totals_by_ide */
export function getIdeBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): IdeBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      json_extract(j.value, '$.ide') as ide,
      COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
      COALESCE(SUM(json_extract(j.value, '$.loc_deleted_sum')), 0) as locDeleted,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions,
      COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) as generations,
      COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) as acceptances
    FROM user_daily_metrics u, json_each(u.totals_by_ide) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY ide
    ORDER BY interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as IdeBreakdownRow[];
}

/** IDE usage trend by day via json_each */
export function getIdeTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): IdeTrendRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      u.day,
      json_extract(j.value, '$.ide') as ide,
      COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) as interactions
    FROM user_daily_metrics u, json_each(u.totals_by_ide) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
      ${filter.clause}${ef.clause}
    GROUP BY u.day, ide
    ORDER BY u.day ASC, interactions DESC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as IdeTrendRow[];
}

// ── CLI user breakdown (SQL) ──────────────────────────────────────────

/** Aggregate CLI usage per user from totals_by_cli JSON column */
export function getCliUserBreakdown(
  startDay: string,
  endDay: string,
  limit: number = 20,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CliUserRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      user_login as login,
      COALESCE(SUM(json_extract(totals_by_cli, '$.session_count')), 0) as sessions,
      COALESCE(SUM(json_extract(totals_by_cli, '$.request_count')), 0) as requests,
      COALESCE(SUM(json_extract(totals_by_cli, '$.prompt_count')), 0) as prompts,
      COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.prompt_tokens_sum')), 0) as promptTokens,
      COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.output_tokens_sum')), 0) as outputTokens,
      COUNT(*) as days
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
      AND used_cli = 1
      AND totals_by_cli IS NOT NULL
      ${filter.clause}${ef.clause}
    GROUP BY user_login
    ORDER BY sessions DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params, limit) as CliUserRow[];
}

// ── Adoption daily trend (SQL) ────────────────────────────────────────

export interface AdoptionDailyRow {
  day: string;
  totalUsers: number;
  agentUsers: number;
  chatUsers: number;
  cliUsers: number;
}

/** Daily adoption counts from structured columns (no JSON parsing) */
export function getAdoptionDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): AdoptionDailyRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      day,
      COUNT(DISTINCT user_login) as totalUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as AdoptionDailyRow[];
}

// ── Active users trend (SQL) ──────────────────────────────────────────

export interface ActiveUsersDailyRow {
  day: string;
  daily: number;
  cliUsers: number;
}

/** Daily active user counts from structured columns */
export function getActiveUsersDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ActiveUsersDailyRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      day,
      COUNT(DISTINCT user_login) as daily,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as ActiveUsersDailyRow[];
}

export interface ActiveUsersRollingRow {
  day: string;
  daily: number;
  weekly: number;
  monthly: number;
  cliUsers: number;
}

/**
 * Active users with rolling 7-day (WAU) and 30-day (MAU) window counts.
 *
 * For each day in the range, computes:
 * - daily: unique users on that day
 * - weekly: unique users in 7-day window ending on that day
 * - monthly: unique users in 30-day window ending on that day
 * - cliUsers: CLI users on that day
 *
 * Uses DISTINCT user counting within rolling windows to properly deduplicate
 * users appearing on multiple days within each window period.
 *
 * Supports filtering by:
 * - allowedLogins: team/org membership filter (applies to all queries)
 * - enterpriseSlugs: enterprise/account filter (applies to all queries)
 *
 * Edge cases:
 * - Single-day ranges: Each day has rolling windows constrained to available data
 * - Empty filters: Returns empty result set
 * - Date range start: Earlier days have windows < 7/30 days if fewer historical days exist
 */
export function getActiveUsersRollingTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): ActiveUsersRollingRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  
  const sql = `
    SELECT
      m.day,
      COUNT(DISTINCT m.user_login) as daily,
      -- Rolling 7-day distinct user count (WAU)
      (SELECT COUNT(DISTINCT w.user_login)
       FROM user_daily_metrics w
       WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day${ef.clause}
       ${filter.clause}
      ) as weekly,
      -- Rolling 30-day distinct user count (MAU)
      (SELECT COUNT(DISTINCT mo.user_login)
       FROM user_daily_metrics mo
       WHERE mo.day BETWEEN date(m.day, '-29 days') AND m.day${ef.clause}
       ${filter.clause}
      ) as monthly,
      COUNT(DISTINCT CASE WHEN m.used_cli = 1 THEN m.user_login END) as cliUsers
    FROM user_daily_metrics m
    WHERE m.day >= ? AND m.day <= ?${ef.clause}${filter.clause}
    GROUP BY m.day
    ORDER BY m.day ASC
  `;
  
  return db.prepare(sql).all(
    ...ef.params, ...filter.params,              // for weekly subquery
    ...ef.params, ...filter.params,              // for monthly subquery
    startDay, endDay, ...ef.params, ...filter.params  // for outer WHERE
  ) as ActiveUsersRollingRow[];
}

// ── Feature usage daily (SQL, structured columns) ─────────────────────

export interface FeatureUsageDailyRow {
  day: string;
  completions: number;
  chatUsers: number;
  agentUsers: number;
  cliUsers: number;
}

/** Daily feature usage from structured columns */
export function getFeatureUsageDaily(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): FeatureUsageDailyRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      day,
      COALESCE(SUM(code_generation_activity_count), 0) as completions,
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as FeatureUsageDailyRow[];
}
