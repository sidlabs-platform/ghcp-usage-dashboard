import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseDateRangeParams } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
// Shared completion-feature allowlist SQL fragment — the single source of
// truth for "is this feature a completion feature" across all raw SQL call
// sites. Never re-declare a local copy or fall back to a bare
// `!= 'agent_edit'` exclusion, since that would silently misclassify
// `copilot_app`, `chat_inline`, or any future unknown feature as completion.
import { IS_COMPLETION_SQL, IS_CLI_SQL, IS_ACCEPTANCE_ELIGIBLE_SQL, NOT_AGENT_OR_APP_SQL, getCompletionDailyTrend } from "@/lib/db/aggregation-queries";
// Copilot App KPI aggregation is delegated entirely to this shared query
// helper (Task 2/3's SQL layer) rather than re-implemented here: it already
// dedupes same-login/same-day rows across enterprises via MAX-before-SUM and
// computes the weighted avgTokensPerRequest = (promptTokens + outputTokens) /
// requests, so re-deriving either here would risk drifting from the
// org/enterprise-level Copilot App analytics routes that use the same helper.
import { getCopilotAppUserSummary } from "@/lib/db/copilot-app-queries";

interface DailyActivity {
  day: string;
  codeGen: number;
  codeAccept: number;
  locSuggested: number;
  locAccepted: number;
  locSuggestedDelete: number;
  locDeleted: number;
  interactions: number;
  aiCreditsUsed: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  // Strict completion-only LoC (IS_COMPLETION_SQL allowlist) — the same values
  // the summary card's totalLocSuggested/completionLocAccepted/completionLocDeleted
  // are built from, so the daily chart and the card never disagree. Unlike
  // locSuggested/locAccepted (top-level loc_suggested_to_add_sum/loc_added_sum,
  // which also include copilot_app/chat_inline/unknown and agent_edit writes),
  // these exclude all of them.
  completionLocSuggested: number;
  completionLocAccepted: number;
  completionLocDeleted: number;
  // Strict completion-only loc_suggested_to_delete_sum (IS_COMPLETION_SQL
  // allowlist) — the "suggested deletion" counterpart to completionLocDeleted
  // above, from the same getCompletionDailyTrend query. Unlike the top-level
  // locSuggestedDelete (loc_suggested_to_delete_sum across ALL features), this
  // excludes copilot_app/chat_inline/unknown and agent_edit activity.
  completionLocSuggestedDelete: number;
  // Copilot App LoC, broken out for future use — never folded into completion.
  appLocAdded: number;
  appLocDeleted: number;
}

interface UserSummary {
  totalActiveDays: number;
  /** @deprecated Use totalLocSuggested — kept for backward compatibility */
  totalLocAdded: number;
  /** @deprecated Use completionLocAccepted — kept for backward compatibility */
  totalLocAccepted: number;
  totalLocSuggestedDelete: number;
  totalLocDeleted: number;
  totalInteractions: number;
  totalAiCreditsUsed: number;
  totalCodeGen: number;
  totalCodeAccept: number;
  /** Acceptance rate over completion + CLI. Excludes agent_edit (always 0 acceptances). */
  acceptanceRate: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  /**
   * Copilot CLI LoC, written to files directly. Never folded into
   * completionLocAccepted — the CLI shows no suggestion, so its LoC was never
   * "accepted" by anyone.
   */
  cliLocAdded: number;
  cliLocDeleted: number;
  // Completion-only fields (excludes agent_edit)
  totalLocSuggested: number;
  completionLocAccepted: number;
  completionLocDeleted: number;
  // Strict completion-only counterpart to totalLocSuggestedDelete (top-level
  // loc_suggested_to_delete_sum across ALL features). Used by the page's
  // "LoC Deleted" card subtitle so it never mixes completion-only headline
  // values with a top-level (copilot_app/chat_inline/unknown/agent_edit
  // inclusive) suggested-deletion count.
  completionLocSuggestedDelete: number;
  completionAcceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReview: boolean;
  usedCodingAgent: boolean;
  usedCodeReviewPassive: boolean;
  // Copilot App availability/activity — three-state, distinct from the other
  // used* booleans above:
  //   true  — at least one row has used_copilot_app = 1, OR real App activity
  //           (sessions/requests/prompts/generations/LOC) is present. Actual
  //           data evidence always wins over a missing/stale flag.
  //   false — App support evidence exists (the flag, dedicated totals, or an
  //           App feature row) but every value is zero/false — "supported,
  //           never used".
  //   null  — no App evidence at all for this user/period (legacy data
  //           synced before Copilot App tracking existed).
  usedCopilotApp: boolean | null;
}

/** Copilot App activity stats for a single user, combining the dedicated
 * `totals_by_copilot_app` totals (sessions/requests/prompts/tokens) with the
 * `copilot_app` feature-code totals from `totals_by_feature`
 * (generations/acceptances/LOC) — see {@link getCopilotAppUserSummary}. */
interface CopilotAppStats {
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  avgTokensPerRequest: number;
  codeGenerations: number;
  codeAcceptances: number;
  locAdded: number;
  locDeleted: number;
}

interface TopLanguage {
  language: string;
  suggestions: number;
  acceptances: number;
}

interface TopModel {
  model: string;
  interactions: number;
}

interface IdeUsage {
  ide: string;
  interactions: number;
}

interface FeatureUsageRow {
  feature: string;
  interactions: number;
  codeGen: number;
  codeAccept: number;
  locAdded: number;
}

interface ChatModes {
  agent: number;
  ask: number;
  edit: number;
  plan: number;
  custom: number;
  unknown: number;
}

interface CliStats {
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
}

async function handler(request: NextRequest) {
  try {
    const login = request.nextUrl.pathname.split("/").pop();
    if (!login) {
      return NextResponse.json({ error: "Missing login parameter" }, { status: 400 });
    }

    const params = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(params, 7);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;

    const db = getDb();
    let decodedLogin: string;
    try {
      decodedLogin = decodeURIComponent(login);
    } catch {
      return NextResponse.json({ error: "Invalid login parameter" }, { status: 400 });
    }

    // Scope filtering: honour teams/orgs/enterprises params
    const scope = parseScopeFilter(params);
    const normalizedLogin = decodedLogin.toLowerCase();
    const normalizedAllowedLogins = scope.allowedLogins
      ? new Set(Array.from(scope.allowedLogins, (allowedLogin) => allowedLogin.toLowerCase()))
      : undefined;
    if (normalizedAllowedLogins && !normalizedAllowedLogins.has(normalizedLogin)) {
      return NextResponse.json({ error: "User not found in selected scope" }, { status: 404 });
    }

    // Enterprise filter clause applied to all queries
    const efClause = scope.enterpriseSlugs?.length
      ? ` AND enterprise_slug IN (${scope.enterpriseSlugs.map(() => "?").join(",")})`
      : "";
    const efParams = scope.enterpriseSlugs ?? [];

    // Daily activity (with per-day agent LOC extracted from agent_edit JSON)
    // Use CASE WHEN json_valid() to guard against empty/malformed agent_edit values
    type DailyActivityRow = Omit<DailyActivity, "completionLocSuggested" | "completionLocAccepted" | "completionLocDeleted" | "completionLocSuggestedDelete" | "appLocAdded" | "appLocDeleted">;
    const dailyActivityRows = db.prepare(`
      WITH per_user_day AS (
        SELECT day, user_id,
          MAX(COALESCE(code_generation_activity_count, 0)) AS codeGen,
          MAX(COALESCE(code_acceptance_activity_count, 0)) AS codeAccept,
          MAX(COALESCE(loc_suggested_to_add_sum, 0)) AS locSuggested,
          MAX(COALESCE(loc_added_sum, 0)) AS locAccepted,
          MAX(COALESCE(loc_suggested_to_delete_sum, 0)) AS locSuggestedDelete,
          MAX(COALESCE(loc_deleted_sum, 0)) AS locDeleted,
          MAX(COALESCE(user_initiated_interaction_count, 0)) AS interactions,
          MAX(COALESCE(ai_credits_used, 0)) AS aiCreditsUsed,
          MAX(CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_added_sum'), 0) ELSE 0 END) AS agentLocAdded,
          MAX(CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_deleted_sum'), 0) ELSE 0 END) AS agentLocDeleted
        FROM user_daily_metrics
        WHERE LOWER(user_login) = ? AND day BETWEEN ? AND ?${efClause}
        GROUP BY day, user_id
      )
      SELECT day,
        COALESCE(SUM(codeGen), 0) AS codeGen,
        COALESCE(SUM(codeAccept), 0) AS codeAccept,
        COALESCE(SUM(locSuggested), 0) AS locSuggested,
        COALESCE(SUM(locAccepted), 0) AS locAccepted,
        COALESCE(SUM(locSuggestedDelete), 0) AS locSuggestedDelete,
        COALESCE(SUM(locDeleted), 0) AS locDeleted,
        COALESCE(SUM(interactions), 0) AS interactions,
        COALESCE(SUM(aiCreditsUsed), 0) AS aiCreditsUsed,
        COALESCE(SUM(agentLocAdded), 0) AS agentLocAdded,
        COALESCE(SUM(agentLocDeleted), 0) AS agentLocDeleted
      FROM per_user_day
      GROUP BY day
      ORDER BY day ASC
    `).all(normalizedLogin, start, end, ...efParams) as DailyActivityRow[];

    // Per-day strict completion/app LoC — via json_each(totals_by_feature)
    // GROUP BY day, reusing the same shared aggregation query the org-level
    // code-generation route uses (getCompletionDailyTrend), scoped to this
    // single user. This is a separate query merged in JS by day, NOT a join
    // against the query above, so it can never multiply dailyActivity rows.
    // getCompletionDailyTrend supplies completionSuggested/completionAccepted/
    // completionDeleted/appAdded/appDeleted all from the same strict
    // IS_COMPLETION_SQL / IS_COPILOT_APP_SQL allowlists, so no extra per-day
    // query is needed to fill in any of these fields.
    const completionTrendByDay = new Map(
      getCompletionDailyTrend(start, end, [decodedLogin], scope.enterpriseSlugs).map((r) => [r.day, r]),
    );

    const dailyActivity: DailyActivity[] = dailyActivityRows.map((row) => {
      const trend = completionTrendByDay.get(row.day);
      return {
        ...row,
        completionLocSuggested: trend?.completionSuggested ?? 0,
        completionLocAccepted: trend?.completionAccepted ?? 0,
        completionLocDeleted: trend?.completionDeleted ?? 0,
        completionLocSuggestedDelete: trend?.completionSuggestedDelete ?? 0,
        appLocAdded: trend?.appAdded ?? 0,
        appLocDeleted: trend?.appDeleted ?? 0,
      };
    });

    // Summary — top-level aggregation (includes all features)
    const summaryRow = db.prepare(`
      WITH per_user_day AS (
        SELECT day, user_id,
          MAX(COALESCE(loc_suggested_to_add_sum, 0)) AS locSuggested,
          MAX(COALESCE(loc_added_sum, 0)) AS locAccepted,
          MAX(COALESCE(loc_suggested_to_delete_sum, 0)) AS locSuggestedDelete,
          MAX(COALESCE(loc_deleted_sum, 0)) AS locDeleted,
          MAX(COALESCE(user_initiated_interaction_count, 0)) AS interactions,
          MAX(COALESCE(ai_credits_used, 0)) AS aiCreditsUsed,
          MAX(COALESCE(code_generation_activity_count, 0)) AS codeGen,
          MAX(COALESCE(code_acceptance_activity_count, 0)) AS codeAccept,
          MAX(CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_added_sum'), 0) ELSE 0 END) AS agentLocAdded,
          MAX(CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_deleted_sum'), 0) ELSE 0 END) AS agentLocDeleted,
          MAX(CASE WHEN used_agent = 1 THEN 1 ELSE 0 END) AS usedAgent,
          MAX(CASE WHEN used_chat = 1 THEN 1 ELSE 0 END) AS usedChat,
          MAX(CASE WHEN used_cli = 1 THEN 1 ELSE 0 END) AS usedCli,
          MAX(CASE WHEN used_copilot_code_review_active = 1 THEN 1 ELSE 0 END) AS usedCodeReview,
          MAX(CASE WHEN used_copilot_coding_agent = 1 THEN 1 ELSE 0 END) AS usedCodingAgent,
          MAX(CASE WHEN used_copilot_code_review_passive = 1 THEN 1 ELSE 0 END) AS usedCodeReviewPassive
        FROM user_daily_metrics
        WHERE LOWER(user_login) = ? AND day BETWEEN ? AND ?${efClause}
        GROUP BY day, user_id
      )
      SELECT
        COUNT(DISTINCT day) AS totalActiveDays,
        COALESCE(SUM(locSuggested), 0) AS totalLocSuggested,
        COALESCE(SUM(locAccepted), 0) AS totalLocAccepted,
        COALESCE(SUM(locSuggestedDelete), 0) AS totalLocSuggestedDelete,
        COALESCE(SUM(locDeleted), 0) AS totalLocDeleted,
        COALESCE(SUM(interactions), 0) AS totalInteractions,
        COALESCE(SUM(aiCreditsUsed), 0) AS totalAiCreditsUsed,
        COALESCE(SUM(codeGen), 0) AS totalCodeGen,
        COALESCE(SUM(codeAccept), 0) AS totalCodeAccept,
        COALESCE(SUM(agentLocAdded), 0) AS agentLocAdded,
        COALESCE(SUM(agentLocDeleted), 0) AS agentLocDeleted,
        MAX(usedAgent) AS usedAgent,
        MAX(usedChat) AS usedChat,
        MAX(usedCli) AS usedCli,
        MAX(usedCodeReview) AS usedCodeReview,
        MAX(usedCodingAgent) AS usedCodingAgent,
        MAX(usedCodeReviewPassive) AS usedCodeReviewPassive
      FROM per_user_day
    `).get(normalizedLogin, start, end, ...efParams) as {
      totalActiveDays: number;
      totalLocSuggested: number;
      totalLocAccepted: number;
      totalLocSuggestedDelete: number;
      totalLocDeleted: number;
      totalInteractions: number;
      totalAiCreditsUsed: number;
      totalCodeGen: number;
      totalCodeAccept: number;
      agentLocAdded: number;
      agentLocDeleted: number;
      usedAgent: number;
      usedChat: number;
      usedCli: number;
      usedCodeReview: number;
      usedCodingAgent: number;
      usedCodeReviewPassive: number;
    } | undefined;

    // Completion-only LOC and acceptance from totals_by_feature.
    // Uses the explicit completion allowlist (code_completion, inline_chat,
    // chat_panel, chat_panel_*) — NOT a bare `!= 'agent_edit'` exclusion —
    // so `copilot_app`, `chat_inline`, and any unknown feature never leak
    // into completion LoC or the completion acceptance rate.
    const completionLocRow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_suggested_to_add_sum') ELSE 0 END), 0) AS compLocSuggested,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) AS compLocAccepted,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) AS compLocDeleted,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.loc_suggested_to_delete_sum') ELSE 0 END), 0) AS compLocSuggestedDelete,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) AS compCodeGen,
        COALESCE(SUM(CASE WHEN ${IS_COMPLETION_SQL} THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) AS compCodeAccept,
        COALESCE(SUM(CASE WHEN ${IS_CLI_SQL} THEN json_extract(j.value, '$.loc_added_sum') ELSE 0 END), 0) AS cliLocAdded,
        COALESCE(SUM(CASE WHEN ${IS_CLI_SQL} THEN json_extract(j.value, '$.loc_deleted_sum') ELSE 0 END), 0) AS cliLocDeleted,
        COALESCE(SUM(CASE WHEN ${IS_CLI_SQL} THEN json_extract(j.value, '$.code_generation_activity_count') ELSE 0 END), 0) AS cliCodeGen,
        COALESCE(SUM(CASE WHEN ${IS_CLI_SQL} THEN json_extract(j.value, '$.code_acceptance_activity_count') ELSE 0 END), 0) AS cliCodeAccept
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE LOWER(u.user_login) = ? AND u.day BETWEEN ? AND ?
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND json_valid(u.totals_by_feature)
        AND ${IS_ACCEPTANCE_ELIGIBLE_SQL}${efClause}
    `).get(normalizedLogin, start, end, ...efParams) as {
      compLocSuggested: number;
      compLocAccepted: number;
      compLocDeleted: number;
      compLocSuggestedDelete: number;
      compCodeGen: number;
      compCodeAccept: number;
      cliLocAdded: number;
      cliLocDeleted: number;
      cliCodeGen: number;
      cliCodeAccept: number;
    } | undefined;

    // Copilot App — a single call to the shared Task 2/3 query helper
    // (getCopilotAppUserSummary) scoped to this one login, handles the
    // multi-enterprise MAX-before-SUM dedupe and weighted avgTokensPerRequest
    // internally. `supportedRows` distinguishes "no App evidence at all"
    // (usedCopilotApp: null) from "supported but inactive" (usedCopilotApp:
    // false, zero-value stats) and "actual activity" (usedCopilotApp: true).
    const appSummary = getCopilotAppUserSummary(start, end, [decodedLogin], scope.enterpriseSlugs);
    const hasCopilotAppEvidence = appSummary.supportedRows > 0;
    const usedCopilotApp: boolean | null = hasCopilotAppEvidence ? appSummary.appActiveUsers > 0 : null;
    const copilotAppStats: CopilotAppStats | null = hasCopilotAppEvidence
      ? {
          sessions: appSummary.sessions,
          requests: appSummary.requests,
          prompts: appSummary.prompts,
          promptTokens: appSummary.promptTokens,
          outputTokens: appSummary.outputTokens,
          avgTokensPerRequest: appSummary.avgTokensPerRequest,
          codeGenerations: appSummary.codeGenerations,
          codeAcceptances: appSummary.codeAcceptances,
          locAdded: appSummary.locAdded,
          locDeleted: appSummary.locDeleted,
        }
      : null;

    let summary: UserSummary | null = null;
    if (summaryRow && summaryRow.totalActiveDays > 0) {
      const agentAdded = summaryRow.agentLocAdded ?? 0;
      const agentDeleted = summaryRow.agentLocDeleted ?? 0;

      // Prefer feature-level completion metrics; fall back to subtraction if unavailable
      const compSuggested = completionLocRow?.compLocSuggested ?? summaryRow.totalLocSuggested;
      const compAccepted = completionLocRow
        ? completionLocRow.compLocAccepted
        : Math.max(0, summaryRow.totalLocAccepted - agentAdded);
      const compDeleted = completionLocRow
        ? completionLocRow.compLocDeleted
        : Math.max(0, summaryRow.totalLocDeleted - agentDeleted);
      // No agent/copilot_app suggested-deletion fallback subtraction is possible here
      // (loc_suggested_to_delete_sum isn't tracked per-feature outside totals_by_feature),
      // so when completionLocRow is unavailable this just falls back to the top-level total.
      const compSuggestedDelete = completionLocRow?.compLocSuggestedDelete ?? summaryRow.totalLocSuggestedDelete;
      const compCodeGen = completionLocRow?.compCodeGen ?? summaryRow.totalCodeGen;
      const compCodeAccept = completionLocRow?.compCodeAccept ?? summaryRow.totalCodeAccept;
      const cliAdded = completionLocRow?.cliLocAdded ?? 0;
      const cliDeleted = completionLocRow?.cliLocDeleted ?? 0;

      // Acceptance rate over completion + CLI — the same basis as the overview
      // and team APIs (see acceptanceRateFrom). agent_edit stays out: it reports
      // 0 acceptances against non-zero generations and can only deflate the rate.
      const acceptEligibleGen = compCodeGen + (completionLocRow?.cliCodeGen ?? 0);
      const acceptEligibleAccept = compCodeAccept + (completionLocRow?.cliCodeAccept ?? 0);
      const compRate = acceptEligibleGen > 0 ? (acceptEligibleAccept / acceptEligibleGen) * 100 : 0;
      // Deliberately the same figure. The old "top level" rate divided by
      // `code_generation_activity_count`, which includes agent_edit generations
      // that can never be accepted — it read as a fleet-wide acceptance rate but
      // was structurally incapable of reaching a true one.
      const topLevelRate = compRate;

      summary = {
        totalActiveDays: summaryRow.totalActiveDays,
        // Backward-compatible aliases — values unchanged from prior API version.
        // totalLocAdded was always SUM(loc_suggested_to_add_sum) despite the misleading name.
        // totalLocAccepted was always SUM(loc_added_sum) which includes agent writes.
        totalLocAdded: summaryRow.totalLocSuggested,
        totalLocAccepted: summaryRow.totalLocAccepted,
        totalLocSuggestedDelete: summaryRow.totalLocSuggestedDelete,
        totalLocDeleted: summaryRow.totalLocDeleted,
        totalInteractions: summaryRow.totalInteractions,
        totalAiCreditsUsed: summaryRow.totalAiCreditsUsed,
        totalCodeGen: summaryRow.totalCodeGen,
        totalCodeAccept: summaryRow.totalCodeAccept,
        acceptanceRate: Math.round(topLevelRate * 10) / 10,
        agentLocAdded: agentAdded,
        agentLocDeleted: agentDeleted,
        cliLocAdded: cliAdded,
        cliLocDeleted: cliDeleted,
        // Completion-only fields (excludes agent_edit)
        totalLocSuggested: compSuggested,
        completionLocAccepted: compAccepted,
        completionLocDeleted: compDeleted,
        completionLocSuggestedDelete: compSuggestedDelete,
        completionAcceptanceRate: Math.round(compRate * 10) / 10,
        usedAgent: summaryRow.usedAgent === 1,
        usedChat: summaryRow.usedChat === 1,
        usedCli: summaryRow.usedCli === 1,
        usedCodeReview: summaryRow.usedCodeReview === 1,
        usedCodingAgent: summaryRow.usedCodingAgent === 1,
        usedCodeReviewPassive: summaryRow.usedCodeReviewPassive === 1,
        usedCopilotApp,
      };
    }

    // Top languages — mirrors getLanguageBreakdown/getLanguageByFeatureBreakdown
    // in aggregation-queries.ts: uses NOT_AGENT_OR_APP_SQL (exclusion), not the
    // strict IS_COMPLETION_SQL allowlist, so legacy rows synced before the
    // `feature` key existed (COALESCE(feature, '') = '') remain included, while
    // agent_edit and copilot_app are still excluded from this "completion-ish"
    // language view. This intentionally differs from summary.completionLocAccepted
    // above, which uses the strict allowlist.
    const topLanguages = db.prepare(`
      SELECT
        j.value->>'language' AS language,
        SUM(CAST(COALESCE(j.value->>'code_generation_activity_count', '0') AS INTEGER)) AS suggestions,
        SUM(CAST(COALESCE(j.value->>'code_acceptance_activity_count', '0') AS INTEGER)) AS acceptances
      FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
      WHERE LOWER(u.user_login) = ? AND u.day BETWEEN ? AND ?
        AND u.totals_by_language_feature IS NOT NULL AND u.totals_by_language_feature != '[]'
        AND json_valid(u.totals_by_language_feature)
        AND ${NOT_AGENT_OR_APP_SQL}${efClause}
      GROUP BY language
      ORDER BY suggestions DESC
      LIMIT 10
    `).all(normalizedLogin, start, end, ...efParams) as TopLanguage[];

    // Top models
    const topModels = db.prepare(`
      SELECT
        j.value->>'model' AS model,
        SUM(CAST(COALESCE(j.value->>'user_initiated_interaction_count', '0') AS INTEGER)) AS interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE LOWER(u.user_login) = ? AND u.day BETWEEN ? AND ?${efClause}
      GROUP BY model
      ORDER BY interactions DESC
      LIMIT 10
    `).all(normalizedLogin, start, end, ...efParams) as TopModel[];

    // IDE usage
    const ideUsage = db.prepare(`
      SELECT
        j.value->>'ide' AS ide,
        SUM(CAST(COALESCE(j.value->>'user_initiated_interaction_count', '0') AS INTEGER)) AS interactions
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE LOWER(u.user_login) = ? AND u.day BETWEEN ? AND ?${efClause}
      GROUP BY ide
      ORDER BY interactions DESC
    `).all(normalizedLogin, start, end, ...efParams) as IdeUsage[];

    // Feature usage from totals_by_feature JSON
    const featureUsage = db.prepare(`
      SELECT
        json_extract(j.value, '$.feature') AS feature,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) AS interactions,
        COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) AS codeGen,
        COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) AS codeAccept,
        COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) AS locAdded
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE LOWER(u.user_login) = ? AND u.day BETWEEN ? AND ?
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND json_valid(u.totals_by_feature)${efClause}
      GROUP BY feature
      ORDER BY interactions DESC
    `).all(normalizedLogin, start, end, ...efParams) as FeatureUsageRow[];

    // Chat mode breakdown
    const chatModesRow = db.prepare(`
      SELECT
        COALESCE(SUM(chat_panel_agent_mode), 0) AS agent,
        COALESCE(SUM(chat_panel_ask_mode), 0) AS ask,
        COALESCE(SUM(chat_panel_edit_mode), 0) AS edit,
        COALESCE(SUM(chat_panel_plan_mode), 0) AS plan,
        COALESCE(SUM(chat_panel_custom_mode), 0) AS custom,
        COALESCE(SUM(chat_panel_unknown_mode), 0) AS unknown
      FROM user_daily_metrics
      WHERE LOWER(user_login) = ? AND day BETWEEN ? AND ?${efClause}
    `).get(normalizedLogin, start, end, ...efParams) as ChatModes | undefined;

    const chatModes: ChatModes = chatModesRow ?? { agent: 0, ask: 0, edit: 0, plan: 0, custom: 0, unknown: 0 };

    // CLI stats from totals_by_cli JSON
    const cliStatsRow = db.prepare(`
      SELECT
        COALESCE(SUM(json_extract(totals_by_cli, '$.session_count')), 0) AS sessions,
        COALESCE(SUM(json_extract(totals_by_cli, '$.request_count')), 0) AS requests,
        COALESCE(SUM(json_extract(totals_by_cli, '$.prompt_count')), 0) AS prompts,
        COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.prompt_tokens_sum')), 0) AS promptTokens,
        COALESCE(SUM(json_extract(totals_by_cli, '$.token_usage.output_tokens_sum')), 0) AS outputTokens
      FROM user_daily_metrics
      WHERE LOWER(user_login) = ? AND day BETWEEN ? AND ?
        AND totals_by_cli IS NOT NULL AND totals_by_cli != ''${efClause}
    `).get(normalizedLogin, start, end, ...efParams) as CliStats | undefined;

    const cliStats: CliStats | null =
      cliStatsRow && (cliStatsRow.sessions > 0 || cliStatsRow.requests > 0 || cliStatsRow.promptTokens > 0)
        ? cliStatsRow : null;

    return NextResponse.json({
      user: decodedLogin,
      dailyActivity,
      summary,
      topLanguages,
      topModels,
      ideUsage,
      featureUsage,
      chatModes,
      cliStats,
      copilotAppStats,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
