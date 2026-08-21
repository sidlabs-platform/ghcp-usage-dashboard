import { getDb } from "./database";
// Explicit feature-classification SQL fragments — never rely on a bare
// `!= 'agent_edit'` exclusion, since that would silently misclassify any
// new/unknown feature (e.g. `copilot_app`, `chat_inline`) as a completion
// feature. Defined in the pure feature-classification.ts module (no database
// import, to avoid a circular import with the startup summary cache migration
// — see that file's header comment) and re-exported here so every existing
// call site (in this module and elsewhere, e.g. src/app/api/users/[login]/route.ts
// and src/app/api/teams/[slug]/route.ts) keeps importing from
// "@/lib/db/aggregation-queries" without any change.
export { FEATURE_SQL, IS_COMPLETION_SQL, IS_AGENT_SQL, IS_COPILOT_APP_SQL, IS_CLI_SQL, IS_ACCEPTANCE_ELIGIBLE_SQL, NOT_AGENT_OR_APP_SQL } from "./feature-classification";
import { IS_COMPLETION_SQL, IS_AGENT_SQL, IS_COPILOT_APP_SQL, IS_CLI_SQL, NOT_AGENT_OR_APP_SQL } from "./feature-classification";

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
  // Distinct users with `used_copilot_app = 1` in the period. This is an
  // additional, overlapping active-surface signal — App users are *not*
  // mutually exclusive with agent/chat/CLI/coding-agent users, so this
  // count must never be added to or subtracted from the other cohorts.
  // Legacy rows with `used_copilot_app IS NULL` (unsupported) contribute 0,
  // same as any other boolean flag column here.
  appUsers: number;
}

export interface UserSummary {
  login: string;
  activeDays: number;
  locAdded: number;
  locDeleted: number;
  interactions: number;
  aiCreditsUsed: number;
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
  locSuggestedAdd: number;
  locSuggestedDelete: number;
  interactions: number;
  generations: number;
  acceptances: number;
}

/** A single version → distinct-user-count row (IDE or CLI version adoption). */
export interface VersionBreakdownRow {
  version: string;
  users: number;
}

/** A plugin+version → distinct-user-count row (editor plugin version adoption). */
export interface PluginVersionBreakdownRow {
  plugin: string;
  version: string;
  users: number;
}

/** Suggested vs accepted LoC totals for CLI code suggestions. */
export interface CliSuggestionStats {
  locSuggestedAdd: number;
  locSuggestedDelete: number;
  locAdded: number;
  locDeleted: number;
  acceptanceRate: number;
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
  // Strict completion-only loc_deleted_sum (IS_COMPLETION_SQL allowlist) — the
  // same basis as completionSuggested/completionAccepted, so callers never
  // need a separate per-day query to get a consistent "completion deleted" figure.
  completionDeleted: number;
  // Strict completion-only loc_suggested_to_delete_sum (IS_COMPLETION_SQL
  // allowlist) — the "suggested deletion" counterpart to completionDeleted,
  // so daily charts can show suggested-vs-actual deletions consistently
  // without copilot_app/chat_inline/unknown/agent_edit activity leaking in.
  completionSuggestedDelete: number;
  agentAdded: number;
  agentDeleted: number;
  compGenCount: number;
  compAcceptCount: number;
  appAdded: number;
  appDeleted: number;
  appGenCount: number;
  appAcceptCount: number;
  // ── Copilot CLI, its own bucket (IS_CLI_SQL) ────────────────────────────
  // The CLI writes to files directly, so `cliAdded` is NOT "accepted
  // suggestions" and must never be pooled with completionAccepted. Its
  // generation/acceptance counts ARE a real accept/reject signal, though, so
  // they belong in the acceptance rate alongside the completion counts — use
  // the `acceptanceRate*` helpers rather than compGenCount/compAcceptCount
  // alone.
  cliSuggested: number;
  cliAdded: number;
  cliDeleted: number;
  cliGenCount: number;
  cliAcceptCount: number;
}

export interface CliDailyVolumeRow {
  day: string;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
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

/**
 * Build a parameterized `AND <column> IN (...)` login filter clause.
 *
 * `column` is restricted to a fixed literal union of internal SQL
 * column/table-qualified expressions actually used by call sites in this
 * codebase — never an arbitrary string, and never derived from request
 * input — while the login values themselves are always bound as
 * parameters. Widening the type would let a future call site interpolate
 * an unreviewed identifier into the SQL string, so any new column must be
 * added to the union explicitly.
 *
 * By default an empty `allowedLogins` array means "no filter" (existing
 * behavior for current callers). Pass `emptyMeansNoRows = true` to instead
 * render a clause that matches zero rows (`AND 1 = 0`) when the caller has
 * explicitly scoped the request down to no allowed logins.
 */
export type LoginFilterColumn =
  | "user_login"
  | "u.user_login"
  | "m.user_login"
  | "w.user_login"
  | "mo.user_login";

export function buildLoginFilter(
  allowedLogins: string[],
  column: LoginFilterColumn = "user_login",
  emptyMeansNoRows: boolean = false,
): { clause: string; params: string[] } {
  if (allowedLogins.length === 0) {
    return emptyMeansNoRows ? { clause: "AND 1 = 0", params: [] } : { clause: "", params: [] };
  }
  const placeholders = allowedLogins.map(() => "?").join(",");
  return { clause: `AND ${column} IN (${placeholders})`, params: allowedLogins };
}

export interface EnterpriseUserScope {
  enterpriseSlug: string;
  userLogin: string;
}

type UserScopeEnterpriseColumn = "enterprise_slug" | "u.enterprise_slug" | "m.enterprise_slug" | "w.enterprise_slug" | "mo.enterprise_slug";
type UserScopeLoginColumn = "user_login" | "u.user_login" | "m.user_login" | "w.user_login" | "mo.user_login";

/** Build a parameterized enterprise/login pair filter that preserves tenant identity. */
export function buildUserScopeFilter(
  scopes: EnterpriseUserScope[],
  enterpriseColumn: UserScopeEnterpriseColumn = "enterprise_slug",
  loginColumn: UserScopeLoginColumn = "user_login",
): { clause: string; params: string[] } {
  if (scopes.length === 0) return { clause: "AND 1 = 0", params: [] };
  const tuples = scopes.map(() => "(?, ?)").join(", ");
  return {
    clause: `AND (${enterpriseColumn}, ${loginColumn}) IN (${tuples})`,
    params: scopes.flatMap((scope) => [scope.enterpriseSlug, scope.userLogin]),
  };
}

function buildAllowedUserFilter(
  allowedLogins: string[] | undefined,
  allowedUserScopes: EnterpriseUserScope[] | undefined,
  emptyMeansNoRows: boolean,
  enterpriseColumn: UserScopeEnterpriseColumn = "enterprise_slug",
  loginColumn: UserScopeLoginColumn = "user_login",
): { clause: string; params: string[] } {
  return allowedUserScopes !== undefined
    ? buildUserScopeFilter(allowedUserScopes, enterpriseColumn, loginColumn)
    : buildLoginFilter(allowedLogins ?? [], loginColumn, emptyMeansNoRows);
}

/** `column` is restricted to a fixed literal union of internal SQL
 * column/table-qualified expressions actually used by call sites in this
 * codebase — see {@link LoginFilterColumn} for the rationale. */
export type EnterpriseFilterColumn = "enterprise_slug" | "u.enterprise_slug";

export function buildEnterpriseFilter(
  slugs?: string[],
  column: EnterpriseFilterColumn = "enterprise_slug",
): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND ${column} IN (${placeholders})`, params: slugs };
}

/**
 * Aggregate chat-mode interactions for a date range.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getChatModeSums(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): ChatModeSums {
  const db = getDb();
  const filter = buildAllowedUserFilter(allowedLogins, allowedUserScopes, emptyMeansNoRows);
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

/**
 * Aggregate distinct-user adoption statistics for a date range.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getAdoptionStats(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): AdoptionStats {
  const db = getDb();
  const filter = buildAllowedUserFilter(allowedLogins, allowedUserScopes, emptyMeansNoRows);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      COUNT(DISTINCT user_login) as totalUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_coding_agent = 1 THEN user_login END) as codingAgentUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_code_review_active = 1 THEN user_login END) as codeReviewUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers,
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_app = 1 THEN user_login END) as appUsers
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
      COALESCE(SUM(ai_credits_used), 0) as aiCreditsUsed,
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
    aiCreditsUsed: number;
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
    aiCreditsUsed: r.aiCreditsUsed,
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

type RawUserRow = {
  login: string; activeDays: number; locAdded: number; locDeleted: number;
  interactions: number; aiCreditsUsed: number; codeGen: number; codeAccept: number;
  usedAgent: number; usedChat: number; usedCli: number;
  usedCodeReviewActive: number; usedCodeReviewPassive: number; usedCodingAgent: number;
};

const USER_SUMMARY_SORT_COLUMNS: Record<string, string> = {
  login: "login",
  activeDays: "activeDays",
  locAdded: "locAdded",
  interactions: "interactions",
  aiCreditsUsed: "aiCreditsUsed",
  acceptanceRate: "CASE WHEN codeGen > 0 THEN ROUND(codeAccept * 100.0 / codeGen, 1) ELSE 0 END",
  codeGen: "codeGen",
};

function mapUserRow(r: RawUserRow): UserSummary {
  return {
    login: r.login,
    activeDays: r.activeDays,
    locAdded: r.locAdded,
    locDeleted: r.locDeleted,
    interactions: r.interactions,
    aiCreditsUsed: r.aiCreditsUsed,
    codeGen: r.codeGen,
    codeAccept: r.codeAccept,
    acceptanceRate: r.codeGen > 0 ? Number(((r.codeAccept / r.codeGen) * 100).toFixed(1)) : 0,
    usedAgent: r.usedAgent === 1,
    usedChat: r.usedChat === 1,
    usedCli: r.usedCli === 1,
    usedCodeReviewActive: r.usedCodeReviewActive === 1,
    usedCodeReviewPassive: r.usedCodeReviewPassive === 1,
    usedCodingAgent: r.usedCodingAgent === 1,
  };
}

function* mapUserRowIterator(rows: Iterable<RawUserRow>): IterableIterator<UserSummary> {
  for (const row of rows) {
    yield mapUserRow(row);
  }
}

/**
 * Iterate aggregated user summaries without materializing the full result set.
 */
export function iterateUserSummaries(
  startDay: string,
  endDay: string,
  sortField: string,
  sortDir: "asc" | "desc",
  search?: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  includeInactive?: boolean,
): IterableIterator<UserSummary> {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const searchClause = search ? `AND user_login LIKE ?` : "";
  const searchParam = search ? [`%${search}%`] : [];
  const sqlSort = USER_SUMMARY_SORT_COLUMNS[sortField] || "activeDays";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";

  if (includeInactive) {
    const seatsFilter = buildLoginFilter(allowedLogins ?? []);
    const seatsEf = buildEnterpriseFilter(enterpriseSlugs);
    const seatsSearchClause = search ? `AND user_login LIKE ?` : "";
    const seatsSearchParam = search ? [`%${search}%`] : [];

    const activeParams = [startDay, endDay, ...filter.params, ...searchParam, ...ef.params];
    const inactiveParams = [
      ...seatsFilter.params,
      ...seatsSearchParam,
      ...seatsEf.params,
      startDay,
      endDay,
      ...filter.params,
      ...ef.params,
    ];

    const cteSql = `
      WITH active_users AS (
        SELECT
          user_login AS login,
          COUNT(DISTINCT day) AS activeDays,
          COALESCE(SUM(loc_added_sum), 0) AS locAdded,
          COALESCE(SUM(loc_deleted_sum), 0) AS locDeleted,
          COALESCE(SUM(user_initiated_interaction_count), 0) AS interactions,
          COALESCE(SUM(ai_credits_used), 0) AS aiCreditsUsed,
          COALESCE(SUM(code_generation_activity_count), 0) AS codeGen,
          COALESCE(SUM(code_acceptance_activity_count), 0) AS codeAccept,
          MAX(used_agent) AS usedAgent,
          MAX(used_chat) AS usedChat,
          MAX(used_cli) AS usedCli,
          MAX(used_copilot_code_review_active) AS usedCodeReviewActive,
          MAX(used_copilot_code_review_passive) AS usedCodeReviewPassive,
          MAX(used_copilot_coding_agent) AS usedCodingAgent
        FROM user_daily_metrics
        WHERE day >= ? AND day <= ? ${filter.clause} ${searchClause}${ef.clause}
        GROUP BY user_login
      ),
      inactive_users AS (
        SELECT DISTINCT
          user_login AS login,
          0 AS activeDays,
          0 AS locAdded,
          0 AS locDeleted,
          0 AS interactions,
          0 AS aiCreditsUsed,
          0 AS codeGen,
          0 AS codeAccept,
          0 AS usedAgent,
          0 AS usedChat,
          0 AS usedCli,
          0 AS usedCodeReviewActive,
          0 AS usedCodeReviewPassive,
          0 AS usedCodingAgent
        FROM copilot_seats
        WHERE 1=1 ${seatsFilter.clause} ${seatsSearchClause}${seatsEf.clause}
          AND user_login NOT IN (
            SELECT DISTINCT user_login
            FROM user_daily_metrics
            WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
          )
      ),
      all_users AS (
        SELECT * FROM active_users
        UNION ALL
        SELECT * FROM inactive_users
      )
    `;

    const dataSql = `${cteSql} SELECT * FROM all_users ORDER BY ${sqlSort} ${sqlDir}`;
    const rows = db.prepare(dataSql).iterate(
      ...activeParams,
      ...inactiveParams,
    ) as Iterable<RawUserRow>;

    return mapUserRowIterator(rows);
  }

  const baseSql = `
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause} ${searchClause}${ef.clause}
  `;
  const baseParams = [startDay, endDay, ...filter.params, ...searchParam, ...ef.params];
  const dataSql = `
    SELECT
      user_login as login,
      COUNT(DISTINCT day) as activeDays,
      COALESCE(SUM(loc_added_sum), 0) as locAdded,
      COALESCE(SUM(loc_deleted_sum), 0) as locDeleted,
      COALESCE(SUM(user_initiated_interaction_count), 0) as interactions,
      COALESCE(SUM(ai_credits_used), 0) as aiCreditsUsed,
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
  `;
  const rows = db.prepare(dataSql).iterate(...baseParams) as Iterable<RawUserRow>;

  return mapUserRowIterator(rows);
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
  includeInactive?: boolean,
): PaginatedUserSummaries {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const searchClause = search ? `AND user_login LIKE ?` : "";
  const searchParam = search ? [`%${search}%`] : [];
  const sqlSort = USER_SUMMARY_SORT_COLUMNS[sortField] || "activeDays";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";

  if (includeInactive) {
    // Build filter clauses for the copilot_seats table (uses same column names)
    const seatsFilter = buildLoginFilter(allowedLogins ?? []);
    const seatsEf = buildEnterpriseFilter(enterpriseSlugs);
    const seatsSearchClause = search ? `AND user_login LIKE ?` : "";
    const seatsSearchParam = search ? [`%${search}%`] : [];

    // Active users CTE params: startDay, endDay, filter, search, ef
    const activeParams = [startDay, endDay, ...filter.params, ...searchParam, ...ef.params];
    // Inactive users CTE params: seatsFilter, seatsSearch, seatsEf, then NOT IN subquery: startDay, endDay, filter, ef
    const inactiveParams = [
      ...seatsFilter.params, ...seatsSearchParam, ...seatsEf.params,
      startDay, endDay, ...filter.params, ...ef.params,
    ];

    const cteSql = `
      WITH active_users AS (
        SELECT
          user_login AS login,
          COUNT(DISTINCT day) AS activeDays,
          COALESCE(SUM(loc_added_sum), 0) AS locAdded,
          COALESCE(SUM(loc_deleted_sum), 0) AS locDeleted,
          COALESCE(SUM(user_initiated_interaction_count), 0) AS interactions,
          COALESCE(SUM(ai_credits_used), 0) AS aiCreditsUsed,
          COALESCE(SUM(code_generation_activity_count), 0) AS codeGen,
          COALESCE(SUM(code_acceptance_activity_count), 0) AS codeAccept,
          MAX(used_agent) AS usedAgent,
          MAX(used_chat) AS usedChat,
          MAX(used_cli) AS usedCli,
          MAX(used_copilot_code_review_active) AS usedCodeReviewActive,
          MAX(used_copilot_code_review_passive) AS usedCodeReviewPassive,
          MAX(used_copilot_coding_agent) AS usedCodingAgent
        FROM user_daily_metrics
        WHERE day >= ? AND day <= ? ${filter.clause} ${searchClause}${ef.clause}
        GROUP BY user_login
      ),
      inactive_users AS (
        SELECT DISTINCT
          user_login AS login,
          0 AS activeDays,
          0 AS locAdded,
          0 AS locDeleted,
          0 AS interactions,
          0 AS aiCreditsUsed,
          0 AS codeGen,
          0 AS codeAccept,
          0 AS usedAgent,
          0 AS usedChat,
          0 AS usedCli,
          0 AS usedCodeReviewActive,
          0 AS usedCodeReviewPassive,
          0 AS usedCodingAgent
        FROM copilot_seats
        WHERE 1=1 ${seatsFilter.clause} ${seatsSearchClause}${seatsEf.clause}
          AND user_login NOT IN (
            SELECT DISTINCT user_login FROM user_daily_metrics
            WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
          )
      ),
      all_users AS (
        SELECT * FROM active_users
        UNION ALL
        SELECT * FROM inactive_users
      )
    `;

    const allParams = [...activeParams, ...inactiveParams];

    const countSql = `${cteSql} SELECT COUNT(*) AS total FROM all_users`;
    const countRow = db.prepare(countSql).get(...allParams) as { total: number };

    const offset = (page - 1) * pageSize;
    const dataSql = `${cteSql} SELECT * FROM all_users ORDER BY ${sqlSort} ${sqlDir} LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(...allParams, pageSize, offset) as RawUserRow[];

    const users = rows.map(mapUserRow);

    return { users, total: countRow.total };
  }

  // Default path: active users only (existing behavior)
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
      COALESCE(SUM(ai_credits_used), 0) as aiCreditsUsed,
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
  const rows = db.prepare(dataSql).all(...baseParams, pageSize, offset) as RawUserRow[];

  const users = rows.map(mapUserRow);

  return { users, total: countRow.total };
}

// ── Row-count guard ───────────────────────────────────────────────────

const ROW_COUNT_THRESHOLD = 500_000;

/**
 * Estimate the number of user_daily_metrics rows for a date range.
 * Returns 400-safe error message if the estimated count exceeds threshold.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function estimateRowCount(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): { count: number; exceeds: boolean } {
  const db = getDb();
  const filter = buildAllowedUserFilter(allowedLogins, allowedUserScopes, emptyMeansNoRows);
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

/** Aggregate language usage from totals_by_language_feature (excludes agent_edit and copilot_app) */
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
      AND ${NOT_AGENT_OR_APP_SQL}
      ${filter.clause}${ef.clause}
    GROUP BY language
    ORDER BY locAdded DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params, limit) as LanguageBreakdownRow[];
}

/** Full language breakdown with generations/acceptances from totals_by_language_feature (excludes agent_edit and copilot_app) */
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
      AND ${NOT_AGENT_OR_APP_SQL}
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

// ── Completion vs Agent vs Copilot App daily trend (SQL via json_each) ─

/**
 * Daily completion vs agent vs copilot_app LOC metrics aggregated via json_each.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getCompletionDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): CompletionDailyRow[] {
  const db = getDb();
  const filter = buildAllowedUserFilter(
    allowedLogins,
    allowedUserScopes,
    emptyMeansNoRows,
    "u.enterprise_slug",
    "u.user_login",
  );
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      u.day,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as completionDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_delete_sum') ELSE 0 END), 0) as completionSuggestedDelete,
      COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded,
      COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as agentDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as appAdded,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as appDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as appGenCount,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as appAcceptCount,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as cliSuggested,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as cliAdded,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as cliDeleted,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as cliGenCount,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as cliAcceptCount
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      AND json_valid(u.totals_by_feature)
      ${filter.clause}${ef.clause}
    GROUP BY u.day
    ORDER BY u.day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as CompletionDailyRow[];
}

/**
 * Aggregate completion vs agent vs copilot_app totals for the whole period.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getCompletionTotals(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): CompletionDailyRow {
  const db = getDb();
  const filter = buildAllowedUserFilter(
    allowedLogins,
    allowedUserScopes,
    emptyMeansNoRows,
    "u.enterprise_slug",
    "u.user_login",
  );
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      '' as day,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as completionSuggested,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as completionAccepted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as completionDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_delete_sum') ELSE 0 END), 0) as completionSuggestedDelete,
      COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as agentAdded,
      COALESCE(SUM(CASE WHEN ${IS_AGENT_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as agentDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as compGenCount,
      COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as compAcceptCount,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as appAdded,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as appDeleted,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as appGenCount,
      COALESCE(SUM(CASE WHEN ${IS_COPILOT_APP_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as appAcceptCount,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) as cliSuggested,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) as cliAdded,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) as cliDeleted,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) as cliGenCount,
      COALESCE(SUM(CASE WHEN ${IS_CLI_SQL}
        THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) as cliAcceptCount
    FROM user_daily_metrics u, json_each(u.totals_by_feature) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
      AND json_valid(u.totals_by_feature)
      ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as CompletionDailyRow | undefined;
  return row ?? {
    day: '', completionSuggested: 0, completionAccepted: 0, completionDeleted: 0, completionSuggestedDelete: 0, agentAdded: 0, agentDeleted: 0,
    compGenCount: 0, compAcceptCount: 0, appAdded: 0, appDeleted: 0, appGenCount: 0, appAcceptCount: 0,
    cliSuggested: 0, cliAdded: 0, cliDeleted: 0, cliGenCount: 0, cliAcceptCount: 0,
  };
}

/**
 * Acceptance rate over every surface that reports a meaningful accept/reject
 * signal: IDE completion plus the Copilot CLI.
 *
 * Single definition, shared by every caller, so the overview KPI, the daily
 * trend, the per-user page and the per-team page can never drift apart.
 *
 * `agent_edit` is deliberately absent — it reports acceptances as a hard 0
 * against non-zero generations, so including it can only deflate the rate.
 * The CLI is deliberately present: it reports real generations *and*
 * acceptances, and excluding it (as the code previously did, by accident, by
 * classifying `copilot_cli` as nothing at all) discarded roughly three quarters
 * of the fleet's genuine acceptance signal.
 */
export function acceptanceRateFrom(
  row: Pick<CompletionDailyRow, "compGenCount" | "compAcceptCount"> &
    Partial<Pick<CompletionDailyRow, "cliGenCount" | "cliAcceptCount">>,
): number {
  const generations = (row.compGenCount || 0) + (row.cliGenCount || 0);
  if (generations <= 0) return 0;
  const acceptances = (row.compAcceptCount || 0) + (row.cliAcceptCount || 0);
  return (acceptances / generations) * 100;
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
      COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_add_sum')), 0) as locSuggestedAdd,
      COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_delete_sum')), 0) as locSuggestedDelete,
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

// ── Version adoption (IDE / plugin / CLI) ─────────────────────────────
//
// Version-adoption breakdowns answer "how many users are currently on
// version X?". Each user is attributed to a SINGLE version — the one from
// their most-recently-sampled telemetry (`sampled_at`) within the window.
// This intentionally de-duplicates a user who reports multiple samples over
// several days. Users whose synced data predates version resolution (or who
// otherwise lack a version) are bucketed under 'Unknown' so counts stay
// complete and the feature degrades gracefully on older data.

/**
 * Distinct users per editor version, from `totals_by_ide[].last_known_ide_version`.
 * Prefers each user's most-recent version sample; missing versions bucket to 'Unknown'.
 */
export function getIdeVersionBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): VersionBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    WITH samples AS (
      SELECT
        u.user_login AS login,
        json_extract(j.value, '$.last_known_ide_version.ide_version') AS version,
        json_extract(j.value, '$.last_known_ide_version.sampled_at') AS sampled_at
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE u.day >= ? AND u.day <= ?
        AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
        ${filter.clause}${ef.clause}
    ),
    ranked AS (
      SELECT login, version,
        ROW_NUMBER() OVER (
          PARTITION BY login
          ORDER BY (CASE WHEN version IS NOT NULL THEN 1 ELSE 0 END) DESC, sampled_at DESC
        ) AS rn
      FROM samples
    )
    SELECT COALESCE(version, 'Unknown') AS version, COUNT(*) AS users
    FROM ranked
    WHERE rn = 1
    GROUP BY COALESCE(version, 'Unknown')
    ORDER BY users DESC, version ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as VersionBreakdownRow[];
}

/**
 * Distinct users per editor plugin+version, from `totals_by_ide[].last_known_plugin_version`.
 * Prefers each user's most-recent plugin sample; missing plugin/version bucket to 'Unknown'.
 */
export function getPluginVersionBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): PluginVersionBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    WITH samples AS (
      SELECT
        u.user_login AS login,
        json_extract(j.value, '$.last_known_plugin_version.plugin') AS plugin,
        json_extract(j.value, '$.last_known_plugin_version.plugin_version') AS version,
        json_extract(j.value, '$.last_known_plugin_version.sampled_at') AS sampled_at
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE u.day >= ? AND u.day <= ?
        AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
        ${filter.clause}${ef.clause}
    ),
    ranked AS (
      SELECT plugin, version, login,
        ROW_NUMBER() OVER (
          PARTITION BY login
          ORDER BY (CASE WHEN version IS NOT NULL THEN 1 ELSE 0 END) DESC, sampled_at DESC
        ) AS rn
      FROM samples
    )
    SELECT
      COALESCE(plugin, 'Unknown') AS plugin,
      COALESCE(version, 'Unknown') AS version,
      COUNT(*) AS users
    FROM ranked
    WHERE rn = 1
    GROUP BY COALESCE(plugin, 'Unknown'), COALESCE(version, 'Unknown')
    ORDER BY users DESC, plugin ASC, version ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as PluginVersionBreakdownRow[];
}

// ── CLI user breakdown (SQL) ──────────────────────────────────────────

/** Aggregate daily CLI session/token volume from user-level totals_by_cli JSON */
export function getCliDailyVolume(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CliDailyVolumeRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      day,
      COALESCE(SUM(json_extract(totals_by_cli, '$.session_count')), 0) as sessions,
      COALESCE(SUM(json_extract(totals_by_cli, '$.request_count')), 0) as requests,
      COALESCE(SUM(json_extract(totals_by_cli, '$.prompt_count')), 0) as prompts,
      COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.prompt_tokens_sum')), 0) as promptTokens,
      COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.output_tokens_sum')), 0) as outputTokens
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
      AND used_cli = 1
      AND totals_by_cli IS NOT NULL
      ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as CliDailyVolumeRow[];
}

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

/**
 * Distinct users per CLI version, from `totals_by_cli.last_known_cli_version`.
 * Prefers each user's most-recent version sample; missing versions bucket to 'Unknown'.
 */
export function getCliVersionBreakdown(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): VersionBreakdownRow[] {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    WITH samples AS (
      SELECT
        user_login AS login,
        json_extract(totals_by_cli, '$.last_known_cli_version.cli_version') AS version,
        json_extract(totals_by_cli, '$.last_known_cli_version.sampled_at') AS sampled_at
      FROM user_daily_metrics
      WHERE day >= ? AND day <= ?
        AND used_cli = 1
        AND totals_by_cli IS NOT NULL AND totals_by_cli != ''
        ${filter.clause}${ef.clause}
    ),
    ranked AS (
      SELECT login, version,
        ROW_NUMBER() OVER (
          PARTITION BY login
          ORDER BY (CASE WHEN version IS NOT NULL THEN 1 ELSE 0 END) DESC, sampled_at DESC
        ) AS rn
      FROM samples
    )
    SELECT COALESCE(version, 'Unknown') AS version, COUNT(*) AS users
    FROM ranked
    WHERE rn = 1
    GROUP BY COALESCE(version, 'Unknown')
    ORDER BY users DESC, version ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as VersionBreakdownRow[];
}

/**
 * Aggregate CLI code-suggestion LoC from the CLI's entry in `totals_by_ide`.
 * The CLI reports its editor-equivalent activity as an IDE whose name is "cli"
 * or ends with "_cli"/"-cli" (e.g. "copilot_cli"); suggested-LoC coverage is reliable on CLI
 * 1.0.57+ and de-duplicated on 1.0.64+. Returns zeros when no CLI IDE rows exist.
 */
export function getCliSuggestionStats(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): CliSuggestionStats {
  const db = getDb();
  const filter = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_add_sum')), 0) as locSuggestedAdd,
      COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_delete_sum')), 0) as locSuggestedDelete,
      COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) as locAdded,
      COALESCE(SUM(json_extract(j.value, '$.loc_deleted_sum')), 0) as locDeleted
    FROM user_daily_metrics u, json_each(u.totals_by_ide) j
    WHERE u.day >= ? AND u.day <= ?
      AND u.totals_by_ide IS NOT NULL AND u.totals_by_ide != '[]'
      AND (
        LOWER(json_extract(j.value, '$.ide')) = 'cli'
        OR LOWER(json_extract(j.value, '$.ide')) LIKE '%\\_cli' ESCAPE '\\'
        OR LOWER(json_extract(j.value, '$.ide')) LIKE '%-cli'
      )
      ${filter.clause}${ef.clause}
  `;
  const row = db.prepare(sql).get(startDay, endDay, ...filter.params, ...ef.params) as
    | Omit<CliSuggestionStats, "acceptanceRate">
    | undefined;
  const base = row ?? { locSuggestedAdd: 0, locSuggestedDelete: 0, locAdded: 0, locDeleted: 0 };
  const acceptanceRate =
    base.locSuggestedAdd > 0 ? Math.round((base.locAdded / base.locSuggestedAdd) * 1000) / 10 : 0;
  return { ...base, acceptanceRate };
}

/** Minimum CLI version with de-duplicated suggested-LoC reporting (changelog 2026-07-02). */
export const MIN_RELIABLE_CLI_VERSION = "1.0.64";

/**
 * Compare two dotted numeric version strings (e.g. "1.0.64" vs "1.0.7").
 * Returns a negative number if a<b, 0 if equal, positive if a>b.
 * Missing or non-numeric components are treated as 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? "0", 10);
    const nb = parseInt(pb[i] ?? "0", 10);
    const va = Number.isNaN(na) ? 0 : na;
    const vb = Number.isNaN(nb) ? 0 : nb;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * Count distinct users running a CLI version older than `threshold`.
 * 'Unknown' and non-numeric version strings are excluded because their age is
 * indeterminate. Intended for the "outdated CLI degrades metric quality" callout.
 */
export function countOutdatedCliUsers(
  rows: VersionBreakdownRow[],
  threshold: string = MIN_RELIABLE_CLI_VERSION,
): number {
  return rows.reduce((sum, r) => {
    if (r.version === "Unknown" || !/^\d/.test(r.version)) return sum;
    return compareVersions(r.version, threshold) < 0 ? sum + r.users : sum;
  }, 0);
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

/**
 * Daily active user counts from structured columns.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getActiveUsersDailyTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): ActiveUsersDailyRow[] {
  const db = getDb();
  const filter = buildAllowedUserFilter(allowedLogins, allowedUserScopes, emptyMeansNoRows);
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
 *
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getActiveUsersRollingTrend(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): ActiveUsersRollingRow[] {
  const db = getDb();
  const outerFilter = buildAllowedUserFilter(
    allowedLogins,
    allowedUserScopes,
    emptyMeansNoRows,
    "m.enterprise_slug",
    "m.user_login",
  );
  const weeklyFilter = buildAllowedUserFilter(
    allowedLogins,
    allowedUserScopes,
    emptyMeansNoRows,
    "w.enterprise_slug",
    "w.user_login",
  );
  const monthlyFilter = buildAllowedUserFilter(
    allowedLogins,
    allowedUserScopes,
    emptyMeansNoRows,
    "mo.enterprise_slug",
    "mo.user_login",
  );
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  
  const sql = `
    SELECT
      m.day,
      COUNT(DISTINCT m.user_login) as daily,
      -- Rolling 7-day distinct user count (WAU)
      (SELECT COUNT(DISTINCT w.user_login)
       FROM user_daily_metrics w
       WHERE w.day BETWEEN date(m.day, '-6 days') AND m.day${ef.clause}
       ${weeklyFilter.clause}
      ) as weekly,
      -- Rolling 30-day distinct user count (MAU)
      (SELECT COUNT(DISTINCT mo.user_login)
       FROM user_daily_metrics mo
       WHERE mo.day BETWEEN date(m.day, '-29 days') AND m.day${ef.clause}
       ${monthlyFilter.clause}
      ) as monthly,
      COUNT(DISTINCT CASE WHEN m.used_cli = 1 THEN m.user_login END) as cliUsers
    FROM user_daily_metrics m
    WHERE m.day >= ? AND m.day <= ?${ef.clause}${outerFilter.clause}
    GROUP BY m.day
    ORDER BY m.day ASC
  `;
  
  return db.prepare(sql).all(
    ...ef.params, ...weeklyFilter.params,
    ...ef.params, ...monthlyFilter.params,
    startDay, endDay, ...ef.params, ...outerFilter.params
  ) as ActiveUsersRollingRow[];
}

// ── Feature usage daily (SQL, structured columns) ─────────────────────

export interface FeatureUsageDailyRow {
  day: string;
  // Sum of `code_generation_activity_count` — an activity/event volume count,
  // NOT a distinct-user count. This is intentionally a different unit than
  // the four `*Users` fields below (each `COUNT(DISTINCT user_login ...)`);
  // do not "align" it to a user count — see chart/consumer usage for the
  // rationale (completions volume vs. feature adoption headcount).
  completions: number;
  chatUsers: number;
  agentUsers: number;
  cliUsers: number;
  // Distinct `used_copilot_app = 1` users for the day — see AdoptionStats.appUsers
  // for the overlap-semantics note; this is the daily-granularity counterpart.
  appUsers: number;
}

/**
 * Daily feature usage from structured columns.
 * @param emptyMeansNoRows When true, an empty `allowedLogins` list matches zero rows; otherwise it omits the login filter.
 * @param allowedUserScopes Enterprise-qualified users that take precedence over `allowedLogins`.
 */
export function getFeatureUsageDaily(
  startDay: string,
  endDay: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
  emptyMeansNoRows = false,
  allowedUserScopes?: EnterpriseUserScope[],
): FeatureUsageDailyRow[] {
  const db = getDb();
  const filter = buildAllowedUserFilter(allowedLogins, allowedUserScopes, emptyMeansNoRows);
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const sql = `
    SELECT
      day,
      COALESCE(SUM(code_generation_activity_count), 0) as completions,
      COUNT(DISTINCT CASE WHEN used_chat = 1 THEN user_login END) as chatUsers,
      COUNT(DISTINCT CASE WHEN used_agent = 1 THEN user_login END) as agentUsers,
      COUNT(DISTINCT CASE WHEN used_cli = 1 THEN user_login END) as cliUsers,
      COUNT(DISTINCT CASE WHEN used_copilot_app = 1 THEN user_login END) as appUsers
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ? ${filter.clause}${ef.clause}
    GROUP BY day
    ORDER BY day ASC
  `;
  return db.prepare(sql).all(startDay, endDay, ...filter.params, ...ef.params) as FeatureUsageDailyRow[];
}
