import { NextResponse } from "next/server";
import { resolveEnterpriseId, getEnterpriseMetrics, getAggregatedDailySummary, countEffectiveEnterprises } from "@/lib/db/metrics-repo";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getActiveUsersDailyTrend,
  getCliDailyVolume,
  getCliUserBreakdown,
  getCliVersionBreakdown,
  getCliSuggestionStats,
  countOutdatedCliUsers,
  MIN_RELIABLE_CLI_VERSION,
} from "@/lib/db/aggregation-queries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const daysResult = parseAndClampDays(searchParams.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);

    const scopeFilter = parseScopeFilter(searchParams);
    const allowedLogins = scopeFilter.allowedLogins ? Array.from(scopeFilter.allowedLogins) : undefined;
    const { enterpriseSlugs } = scopeFilter;
    const isMultiEnterprise = !scopeFilter.hasFilter && countEffectiveEnterprises(enterpriseSlugs) > 1;
    const eid = scopeFilter.hasFilter || isMultiEnterprise ? null : resolveEnterpriseId(enterpriseSlugs);

    const enterpriseRecords = eid ? getEnterpriseMetrics(start, end, enterpriseSlugs) : [];
    const aggregated = enterpriseRecords.length === 0 && !scopeFilter.hasFilter ? getAggregatedDailySummary(start, end, enterpriseSlugs) : [];

    // Daily CLI/IDE users trend
    let dailyTrend;
    if (scopeFilter.hasFilter || (enterpriseRecords.length === 0 && aggregated.length === 0)) {
      // Build from user-level data via SQL — no getAllUserMetrics
      const rows = getActiveUsersDailyTrend(start, end, allowedLogins, enterpriseSlugs);
      dailyTrend = rows.map((r) => ({
        day: r.day,
        cliUsers: r.cliUsers,
        ideUsers: r.daily - r.cliUsers,
      }));
    } else if (enterpriseRecords.length > 0) {
      dailyTrend = enterpriseRecords.map((d) => ({
        day: d.day,
        cliUsers: d.daily_active_cli_users ?? 0,
        ideUsers: d.daily_active_users - (d.daily_active_cli_users ?? 0),
      }));
    } else {
      dailyTrend = aggregated.map((d) => ({
        day: d.day,
        cliUsers: d.daily_active_cli_users ?? 0,
        ideUsers: d.daily_active_users - (d.daily_active_cli_users ?? 0),
      }));
    }

    // Daily token/session/request volume
    const dailyTokens = enterpriseRecords.length > 0
      ? enterpriseRecords.map((d) => {
        const cli = d.totals_by_cli;
        return {
          day: d.day,
          sessions: cli?.session_count ?? 0,
          requests: cli?.request_count ?? 0,
          prompts: cli?.prompt_count ?? 0,
          promptTokens: cli?.token_usage?.prompt_tokens_sum ?? 0,
          outputTokens: cli?.token_usage?.output_tokens_sum ?? 0,
          avgPerRequest: cli?.token_usage?.avg_tokens_per_request ?? 0,
        };
      })
      : getCliDailyVolume(start, end, allowedLogins, enterpriseSlugs).map((row) => ({
        day: row.day,
        sessions: row.sessions,
        requests: row.requests,
        prompts: row.prompts,
        promptTokens: row.promptTokens,
        outputTokens: row.outputTokens,
        avgPerRequest: row.requests > 0 ? Math.round((row.promptTokens + row.outputTokens) / row.requests) : 0,
      }));

    // Latest day values for KPIs
    const latestTrendRow = dailyTrend.length > 0 ? dailyTrend[dailyTrend.length - 1] : null;
    const latestTokenRow = latestTrendRow
      ? dailyTokens.find((row) => row.day === latestTrendRow.day) ?? null
      : null;

    // Top CLI users — SQL aggregation, no getAllUserMetrics
    const topCliUsers = getCliUserBreakdown(start, end, 20, allowedLogins, enterpriseSlugs);

    // CLI code-suggestion effectiveness (Insight B) — suggested vs accepted LoC.
    const cliSuggestion = getCliSuggestionStats(start, end, allowedLogins, enterpriseSlugs);

    // CLI version adoption (Insight A) — distinct users per version + outdated callout.
    const cliVersions = getCliVersionBreakdown(start, end, allowedLogins, enterpriseSlugs);
    const outdatedCliUsers = countOutdatedCliUsers(cliVersions);

    return NextResponse.json({
      dailyTrend,
      dailyTokens,
      kpis: {
        dailyCliUsers: latestTrendRow?.cliUsers ?? 0,
        sessionsToday: latestTokenRow?.sessions ?? 0,
        requestsToday: latestTokenRow?.requests ?? 0,
        avgTokensPerRequest: latestTokenRow?.avgPerRequest ?? 0,
      },
      cliSuggestion,
      cliVersions,
      outdatedCliUsers,
      minReliableCliVersion: MIN_RELIABLE_CLI_VERSION,
      topCliUsers,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
