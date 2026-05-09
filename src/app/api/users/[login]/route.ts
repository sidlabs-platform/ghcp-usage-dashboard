import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseAndClampDays, getDateRange } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

interface DailyActivity {
  day: string;
  codeGen: number;
  codeAccept: number;
  locSuggested: number;
  locAccepted: number;
  locSuggestedDelete: number;
  locDeleted: number;
  interactions: number;
  agentLocAdded: number;
  agentLocDeleted: number;
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
  totalCodeGen: number;
  totalCodeAccept: number;
  acceptanceRate: number;
  agentLocAdded: number;
  agentLocDeleted: number;
  // Completion-only fields (excludes agent_edit)
  totalLocSuggested: number;
  completionLocAccepted: number;
  completionLocDeleted: number;
  completionAcceptanceRate: number;
  usedAgent: boolean;
  usedChat: boolean;
  usedCli: boolean;
  usedCodeReview: boolean;
  usedCodingAgent: boolean;
  usedCodeReviewPassive: boolean;
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
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);

    const db = getDb();
    let decodedLogin: string;
    try {
      decodedLogin = decodeURIComponent(login);
    } catch {
      return NextResponse.json({ error: "Invalid login parameter" }, { status: 400 });
    }

    // Scope filtering: honour teams/orgs/enterprises params
    const scope = parseScopeFilter(params);
    if (scope.allowedLogins && !scope.allowedLogins.has(decodedLogin)) {
      return NextResponse.json({ error: "User not found in selected scope" }, { status: 404 });
    }

    // Enterprise filter clause applied to all queries
    const efClause = scope.enterpriseSlugs?.length
      ? ` AND enterprise_slug IN (${scope.enterpriseSlugs.map(() => "?").join(",")})`
      : "";
    const efParams = scope.enterpriseSlugs ?? [];

    // Daily activity (with per-day agent LOC extracted from agent_edit JSON)
    // Use CASE WHEN json_valid() to guard against empty/malformed agent_edit values
    const dailyActivity = db.prepare(`
      SELECT day,
        COALESCE(code_generation_activity_count, 0) AS codeGen,
        COALESCE(code_acceptance_activity_count, 0) AS codeAccept,
        COALESCE(loc_suggested_to_add_sum, 0) AS locSuggested,
        COALESCE(loc_added_sum, 0) AS locAccepted,
        COALESCE(loc_suggested_to_delete_sum, 0) AS locSuggestedDelete,
        COALESCE(loc_deleted_sum, 0) AS locDeleted,
        COALESCE(user_initiated_interaction_count, 0) AS interactions,
        CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_added_sum'), 0) ELSE 0 END AS agentLocAdded,
        CASE WHEN json_valid(agent_edit) THEN COALESCE(json_extract(agent_edit, '$.loc_deleted_sum'), 0) ELSE 0 END AS agentLocDeleted
      FROM user_daily_metrics
      WHERE user_login = ? AND day BETWEEN ? AND ?${efClause}
      ORDER BY day ASC
    `).all(decodedLogin, start, end, ...efParams) as DailyActivity[];

    // Summary — top-level aggregation (includes all features)
    const summaryRow = db.prepare(`
      SELECT
        COUNT(DISTINCT day) AS totalActiveDays,
        COALESCE(SUM(loc_suggested_to_add_sum), 0) AS totalLocSuggested,
        COALESCE(SUM(loc_added_sum), 0) AS totalLocAccepted,
        COALESCE(SUM(loc_suggested_to_delete_sum), 0) AS totalLocSuggestedDelete,
        COALESCE(SUM(loc_deleted_sum), 0) AS totalLocDeleted,
        COALESCE(SUM(user_initiated_interaction_count), 0) AS totalInteractions,
        COALESCE(SUM(code_generation_activity_count), 0) AS totalCodeGen,
        COALESCE(SUM(code_acceptance_activity_count), 0) AS totalCodeAccept,
        MAX(CASE WHEN used_agent = 1 THEN 1 ELSE 0 END) AS usedAgent,
        MAX(CASE WHEN used_chat = 1 THEN 1 ELSE 0 END) AS usedChat,
        MAX(CASE WHEN used_cli = 1 THEN 1 ELSE 0 END) AS usedCli,
        MAX(CASE WHEN used_copilot_code_review_active = 1 THEN 1 ELSE 0 END) AS usedCodeReview,
        MAX(CASE WHEN used_copilot_coding_agent = 1 THEN 1 ELSE 0 END) AS usedCodingAgent,
        MAX(CASE WHEN used_copilot_code_review_passive = 1 THEN 1 ELSE 0 END) AS usedCodeReviewPassive
      FROM user_daily_metrics
      WHERE user_login = ? AND day BETWEEN ? AND ?${efClause}
    `).get(decodedLogin, start, end, ...efParams) as {
      totalActiveDays: number;
      totalLocSuggested: number;
      totalLocAccepted: number;
      totalLocSuggestedDelete: number;
      totalLocDeleted: number;
      totalInteractions: number;
      totalCodeGen: number;
      totalCodeAccept: number;
      usedAgent: number;
      usedChat: number;
      usedCli: number;
      usedCodeReview: number;
      usedCodingAgent: number;
      usedCodeReviewPassive: number;
    } | undefined;

    // Agent LoC from agent_edit JSON
    const agentLocRow = db.prepare(`
      SELECT
        COALESCE(SUM(json_extract(agent_edit, '$.loc_added_sum')), 0) AS agentLocAdded,
        COALESCE(SUM(json_extract(agent_edit, '$.loc_deleted_sum')), 0) AS agentLocDeleted
      FROM user_daily_metrics
      WHERE user_login = ? AND day BETWEEN ? AND ?
        AND agent_edit IS NOT NULL AND agent_edit != ''${efClause}
    `).get(decodedLogin, start, end, ...efParams) as { agentLocAdded: number; agentLocDeleted: number } | undefined;

    // Completion-only LOC and acceptance from totals_by_feature (excludes agent_edit)
    const completionLocRow = db.prepare(`
      SELECT
        COALESCE(SUM(json_extract(j.value, '$.loc_suggested_to_add_sum')), 0) AS compLocSuggested,
        COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) AS compLocAccepted,
        COALESCE(SUM(json_extract(j.value, '$.loc_deleted_sum')), 0) AS compLocDeleted,
        COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) AS compCodeGen,
        COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) AS compCodeAccept
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'
        AND COALESCE(json_extract(j.value, '$.feature'), '') != 'agent_edit'${efClause}
    `).get(decodedLogin, start, end, ...efParams) as {
      compLocSuggested: number;
      compLocAccepted: number;
      compLocDeleted: number;
      compCodeGen: number;
      compCodeAccept: number;
    } | undefined;

    let summary: UserSummary | null = null;
    if (summaryRow && summaryRow.totalActiveDays > 0) {
      const agentAdded = agentLocRow?.agentLocAdded ?? 0;
      const agentDeleted = agentLocRow?.agentLocDeleted ?? 0;

      // Prefer feature-level completion metrics; fall back to subtraction if unavailable
      const compSuggested = completionLocRow?.compLocSuggested ?? summaryRow.totalLocSuggested;
      const compAccepted = completionLocRow
        ? completionLocRow.compLocAccepted
        : Math.max(0, summaryRow.totalLocAccepted - agentAdded);
      const compDeleted = completionLocRow
        ? completionLocRow.compLocDeleted
        : Math.max(0, summaryRow.totalLocDeleted - agentDeleted);
      const compCodeGen = completionLocRow?.compCodeGen ?? summaryRow.totalCodeGen;
      const compCodeAccept = completionLocRow?.compCodeAccept ?? summaryRow.totalCodeAccept;

      const compRate = compCodeGen > 0 ? (compCodeAccept / compCodeGen) * 100 : 0;
      const topLevelRate = summaryRow.totalCodeGen > 0
        ? (summaryRow.totalCodeAccept / summaryRow.totalCodeGen) * 100
        : 0;

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
        totalCodeGen: summaryRow.totalCodeGen,
        totalCodeAccept: summaryRow.totalCodeAccept,
        acceptanceRate: Math.round(topLevelRate * 10) / 10,
        agentLocAdded: agentAdded,
        agentLocDeleted: agentDeleted,
        // Completion-only fields (excludes agent_edit)
        totalLocSuggested: compSuggested,
        completionLocAccepted: compAccepted,
        completionLocDeleted: compDeleted,
        completionAcceptanceRate: Math.round(compRate * 10) / 10,
        usedAgent: summaryRow.usedAgent === 1,
        usedChat: summaryRow.usedChat === 1,
        usedCli: summaryRow.usedCli === 1,
        usedCodeReview: summaryRow.usedCodeReview === 1,
        usedCodingAgent: summaryRow.usedCodingAgent === 1,
        usedCodeReviewPassive: summaryRow.usedCodeReviewPassive === 1,
      };
    }

    // Top languages (excludes agent_edit to show completion-only language metrics)
    const topLanguages = db.prepare(`
      SELECT
        j.value->>'language' AS language,
        SUM(CAST(COALESCE(j.value->>'code_generation_activity_count', '0') AS INTEGER)) AS suggestions,
        SUM(CAST(COALESCE(j.value->>'code_acceptance_activity_count', '0') AS INTEGER)) AS acceptances
      FROM user_daily_metrics u, json_each(u.totals_by_language_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
        AND COALESCE(j.value->>'feature', '') != 'agent_edit'${efClause}
      GROUP BY language
      ORDER BY suggestions DESC
      LIMIT 10
    `).all(decodedLogin, start, end, ...efParams) as TopLanguage[];

    // Top models
    const topModels = db.prepare(`
      SELECT
        j.value->>'model' AS model,
        SUM(CAST(COALESCE(j.value->>'user_initiated_interaction_count', '0') AS INTEGER)) AS interactions
      FROM user_daily_metrics u, json_each(u.totals_by_model_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?${efClause}
      GROUP BY model
      ORDER BY interactions DESC
      LIMIT 10
    `).all(decodedLogin, start, end, ...efParams) as TopModel[];

    // IDE usage
    const ideUsage = db.prepare(`
      SELECT
        j.value->>'ide' AS ide,
        SUM(CAST(COALESCE(j.value->>'user_initiated_interaction_count', '0') AS INTEGER)) AS interactions
      FROM user_daily_metrics u, json_each(u.totals_by_ide) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?${efClause}
      GROUP BY ide
      ORDER BY interactions DESC
    `).all(decodedLogin, start, end, ...efParams) as IdeUsage[];

    // Feature usage from totals_by_feature JSON
    const featureUsage = db.prepare(`
      SELECT
        json_extract(j.value, '$.feature') AS feature,
        COALESCE(SUM(json_extract(j.value, '$.user_initiated_interaction_count')), 0) AS interactions,
        COALESCE(SUM(json_extract(j.value, '$.code_generation_activity_count')), 0) AS codeGen,
        COALESCE(SUM(json_extract(j.value, '$.code_acceptance_activity_count')), 0) AS codeAccept,
        COALESCE(SUM(json_extract(j.value, '$.loc_added_sum')), 0) AS locAdded
      FROM user_daily_metrics u, json_each(u.totals_by_feature) j
      WHERE u.user_login = ? AND u.day BETWEEN ? AND ?
        AND u.totals_by_feature IS NOT NULL AND u.totals_by_feature != '[]'${efClause}
      GROUP BY feature
      ORDER BY interactions DESC
    `).all(decodedLogin, start, end, ...efParams) as FeatureUsageRow[];

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
      WHERE user_login = ? AND day BETWEEN ? AND ?${efClause}
    `).get(decodedLogin, start, end, ...efParams) as ChatModes | undefined;

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
      WHERE user_login = ? AND day BETWEEN ? AND ?
        AND totals_by_cli IS NOT NULL AND totals_by_cli != ''${efClause}
    `).get(decodedLogin, start, end, ...efParams) as CliStats | undefined;

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
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
