import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseMetrics, getAggregatedDailySummary, resolveEnterpriseId } from "@/lib/db/metrics-repo";
import { getSeatStats } from "@/lib/db/seats-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getChatModeSums,
  getAdoptionStats,
  getActiveUsersDailyTrend,
  getActiveUsersRollingTrend,
  getCompletionDailyTrend,
  getFeatureUsageDaily,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { extractCompletionMetrics, extractAgentMetrics } from "@/lib/aggregation/separate-metrics";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const hasFilter = filter.selectedTeams.length > 0 || filter.selectedOrgs.length > 0;
    const allowedLoginsSet = filter.allowedLogins;
    const allowedLoginsArray = allowedLoginsSet ? Array.from(allowedLoginsSet) : undefined;

    // Row-count guard
    const estimate = estimateRowCount(start, end, allowedLoginsArray, enterpriseSlugs);
    if (estimate.exceeds) {
      return NextResponse.json(
        { error: `Result set too large (${estimate.count.toLocaleString()} rows). Try a narrower date range or add filters.` },
        { status: 400 },
      );
    }

    // When filters are active, always use user-level aggregation
    const resolvedId = hasFilter ? null : resolveEnterpriseId(enterpriseSlugs);
    let metrics = resolvedId ? getEnterpriseMetrics(start, end, enterpriseSlugs) : [];

    const useAggregated = metrics.length === 0;
    const aggregated = useAggregated && !hasFilter ? getAggregatedDailySummary(start, end, enterpriseSlugs) : [];

    const seatStats = getSeatStats(enterpriseSlugs);

    let activeUsersTrend;
    let acceptanceRateTrend;
    let featureUsage;
    let cliVsIde;

    if (hasFilter || useAggregated) {
      // Build all trends from SQL aggregation — no getAllUserMetrics()

      // Active users trend via SQL
      const userTrendRows = getActiveUsersDailyTrend(start, end, allowedLoginsArray, enterpriseSlugs);

      if (hasFilter) {
        // For filtered view, use rolling window calculations for WAU/MAU
        const rollingTrendRows = getActiveUsersRollingTrend(start, end, allowedLoginsArray, enterpriseSlugs);
        activeUsersTrend = rollingTrendRows.map((r) => ({
          day: r.day,
          daily: r.daily,
          weekly: r.weekly,
          monthly: r.monthly,
        }));
      } else {
        // For aggregated (no enterprise data), use the aggregated daily summary
        activeUsersTrend = aggregated.length > 0
          ? aggregated.map((d) => ({
              day: d.day,
              daily: d.daily_active_users,
              weekly: d.weekly_active_users,
              monthly: d.monthly_active_users,
            }))
          : (console.warn(`[overview] Aggregated summary empty for range ${start}-${end}, using DAU fallback`),
             userTrendRows.map((r) => ({
              day: r.day,
              daily: r.daily,
              weekly: r.daily,
              monthly: r.daily,
            })));
      }

      // Acceptance rate trend via SQL (completion-only, uses json_each)
      const compTrendRows = getCompletionDailyTrend(start, end, allowedLoginsArray, enterpriseSlugs);
      const compTrendByDay = new Map(compTrendRows.map((r) => [r.day, r]));

      acceptanceRateTrend = (activeUsersTrend).map((t) => {
        const r = compTrendByDay.get(t.day);
        return {
          day: t.day,
          suggested: r?.completionSuggested ?? 0,
          accepted: r?.completionAccepted ?? 0,
          agentAdded: r?.agentAdded ?? 0,
          rate: r && r.completionSuggested > 0 ? (r.completionAccepted / r.completionSuggested) * 100 : 0,
        };
      });

      // Feature usage via SQL
      const featureRows = getFeatureUsageDaily(start, end, allowedLoginsArray, enterpriseSlugs);
      const featureByDay = new Map(featureRows.map((r) => [r.day, r]));

      if (hasFilter) {
        featureUsage = (activeUsersTrend).map((t) => {
          const r = featureByDay.get(t.day);
          return {
            day: t.day,
            completions: r?.completions ?? 0,
            chat: r?.chatUsers ?? 0,
            agent: r?.agentUsers ?? 0,
            cli: r?.cliUsers ?? 0,
          };
        });
      } else {
        featureUsage = aggregated.length > 0
          ? aggregated.map((d) => ({
              day: d.day,
              completions: d.code_generation_activity_count,
              chat: d.chat_users,
              agent: d.agent_users,
              cli: d.daily_active_cli_users,
            }))
          : (activeUsersTrend).map((t) => {
              const r = featureByDay.get(t.day);
              return {
                day: t.day,
                completions: r?.completions ?? 0,
                chat: r?.chatUsers ?? 0,
                agent: r?.agentUsers ?? 0,
                cli: r?.cliUsers ?? 0,
              };
            });
      }

      // CLI vs IDE
      if (hasFilter) {
        cliVsIde = userTrendRows.map((r) => ({
          day: r.day,
          ideUsers: r.daily,
          cliUsers: r.cliUsers,
        }));
      } else {
        cliVsIde = aggregated.length > 0
          ? aggregated.map((d) => ({
              day: d.day,
              ideUsers: d.daily_active_users,
              cliUsers: d.daily_active_cli_users || 0,
            }))
          : userTrendRows.map((r) => ({
              day: r.day,
              ideUsers: r.daily,
              cliUsers: r.cliUsers,
            }));
      }
    } else {
      // Enterprise-level data available — use it directly (no JSON parsing needed for overview)
      activeUsersTrend = metrics.map((d) => ({
        day: d.day,
        daily: d.daily_active_users,
        weekly: d.weekly_active_users,
        monthly: d.monthly_active_users,
      }));

      acceptanceRateTrend = metrics.map((d) => {
        const comp = extractCompletionMetrics(d.totals_by_feature || []);
        const agent = extractAgentMetrics(d.totals_by_feature || []);
        return {
          day: d.day,
          suggested: comp.locSuggested,
          accepted: comp.locAccepted,
          agentAdded: agent.locAdded,
          rate: comp.locSuggested > 0 ? (comp.locAccepted / comp.locSuggested) * 100 : 0,
        };
      });

      featureUsage = metrics.map((d) => {
        const completions = (d.totals_by_feature || []).find((f) => f.feature === "code_completion");
        const chat = (d.totals_by_feature || []).find((f) => f.feature === "chat_panel");
        return {
          day: d.day,
          completions: completions?.code_generation_activity_count || 0,
          chat: chat?.user_initiated_interaction_count || 0,
          agent: d.monthly_active_agent_users || 0,
          cli: d.daily_active_cli_users || 0,
        };
      });

      cliVsIde = metrics.map((d) => ({
        day: d.day,
        ideUsers: d.daily_active_users,
        cliUsers: d.daily_active_cli_users || 0,
      }));
    }

    // Chat mode distribution via SQL aggregation
    const chatModes = getChatModeSums(start, end, allowedLoginsArray, enterpriseSlugs);

    // Adoption stats via SQL aggregation
    const adoption = getAdoptionStats(start, end, allowedLoginsArray, enterpriseSlugs);

    // KPIs
    const latestTrend = activeUsersTrend[activeUsersTrend.length - 1];
    const prevTrend = activeUsersTrend.length > 1 ? activeUsersTrend[activeUsersTrend.length - 2] : null;

    const kpis = {
      dailyActiveUsers: latestTrend?.daily || 0,
      weeklyActiveUsers: latestTrend?.weekly || 0,
      monthlyActiveUsers: hasFilter
        ? adoption.totalUsers
        : (useAggregated
          ? adoption.totalUsers
          : (metrics[metrics.length - 1] as { monthly_active_users?: number })?.monthly_active_users || 0),
      agentAdoption: adoption.totalUsers > 0 ? (adoption.agentUsers / adoption.totalUsers) * 100 : 0,
      codingAgentAdoption: adoption.totalUsers > 0 ? (adoption.codingAgentUsers / adoption.totalUsers) * 100 : 0,
      codeReviewAdoption: adoption.totalUsers > 0 ? (adoption.codeReviewUsers / adoption.totalUsers) * 100 : 0,
      cliUsers: latestTrend ? cliVsIde[cliVsIde.length - 1]?.cliUsers || 0 : 0,
      licenseUtilization: hasFilter
        ? -1 // Indicate N/A when filtered
        : (seatStats.total > 0 ? (seatStats.active30d / seatStats.total) * 100 : 0),
      deltas: {
        dau: prevTrend && latestTrend && prevTrend.daily > 0
          ? ((latestTrend.daily - prevTrend.daily) / prevTrend.daily) * 100 : 0,
        wau: 0,
      },
    };

    const totalDays = activeUsersTrend.length;

    return NextResponse.json({
      kpis,
      activeUsersTrend,
      acceptanceRateTrend,
      chatModes,
      featureUsage,
      cliVsIde,
      dataAsOf: end,
      daysLoaded: totalDays,
      dataSource: hasFilter ? "filtered-users" : (useAggregated ? "user-aggregated" : "enterprise"),
      filtered: hasFilter || !!enterpriseSlugs,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
