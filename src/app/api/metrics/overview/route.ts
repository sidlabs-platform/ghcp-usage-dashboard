import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseMetrics, getAggregatedDailySummary, resolveEnterpriseId, countEffectiveEnterprises } from "@/lib/db/metrics-repo";
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
import { extractCompletionMetrics, extractAgentMetrics, isCompletionFeature } from "@/lib/aggregation/separate-metrics";
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
    // When multiple enterprises exist, skip enterprise-level data (can't sum DAU/WAU/MAU
    // across enterprises — overlapping users would be double-counted)
    const isMultiEnterprise = !hasFilter && countEffectiveEnterprises(enterpriseSlugs) > 1;
    const resolvedId = hasFilter || isMultiEnterprise ? null : resolveEnterpriseId(enterpriseSlugs);
    const metrics = resolvedId ? getEnterpriseMetrics(start, end, enterpriseSlugs) : [];

    const useAggregated = metrics.length === 0;
    const aggregated = useAggregated && !hasFilter ? getAggregatedDailySummary(start, end, enterpriseSlugs) : [];

    const seatStats = getSeatStats(enterpriseSlugs);

    // Feature usage (incl. Copilot App) via SQL — always computed up front so
    // every data-source branch below (enterprise-direct, aggregated, and
    // filtered/SQL-aggregated) can source a consistent `app` daily value,
    // including as a fallback when enterprise rows don't carry their own
    // `daily_active_copilot_app_users`.
    const featureRows = getFeatureUsageDaily(start, end, allowedLoginsArray, enterpriseSlugs);
    const featureByDay = new Map(featureRows.map((r) => [r.day, r]));

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
          rate: r && r.compGenCount > 0 ? (r.compAcceptCount / r.compGenCount) * 100 : 0,
        };
      });

      // Feature usage via SQL
      if (hasFilter) {
        featureUsage = (activeUsersTrend).map((t) => {
          const r = featureByDay.get(t.day);
          return {
            day: t.day,
            completions: r?.completions ?? 0,
            chat: r?.chatUsers ?? 0,
            agent: r?.agentUsers ?? 0,
            cli: r?.cliUsers ?? 0,
            app: r?.appUsers ?? 0,
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
              app: featureByDay.get(d.day)?.appUsers ?? 0,
            }))
          : (activeUsersTrend).map((t) => {
              const r = featureByDay.get(t.day);
              return {
                day: t.day,
                completions: r?.completions ?? 0,
                chat: r?.chatUsers ?? 0,
                agent: r?.agentUsers ?? 0,
                cli: r?.cliUsers ?? 0,
                app: r?.appUsers ?? 0,
              };
            });
      }

      // CLI vs IDE
      if (hasFilter) {
        cliVsIde = userTrendRows.map((r) => ({
          day: r.day,
          ideUsers: r.daily - r.cliUsers,
          cliUsers: r.cliUsers,
        }));
      } else {
        cliVsIde = aggregated.length > 0
          ? aggregated.map((d) => ({
              day: d.day,
              ideUsers: d.daily_active_users - (d.daily_active_cli_users || 0),
              cliUsers: d.daily_active_cli_users || 0,
            }))
          : userTrendRows.map((r) => ({
              day: r.day,
              ideUsers: r.daily - r.cliUsers,
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
          rate: comp.codeGenCount > 0 ? (comp.codeAcceptCount / comp.codeGenCount) * 100 : 0,
        };
      });

      featureUsage = metrics.map((d) => {
        const features = d.totals_by_feature || [];
        const completionFeatures = features.filter((f) => isCompletionFeature(f.feature));
        // Legacy (pre-Task6) enterprise-direct fallback values, used only
        // when featureByDay has no row for this day (e.g. user-level
        // metrics are disabled/empty) so the chart never falsely reports
        // zero. `chat` is the total chat_panel*/chat_panel interaction
        // count from this enterprise row's own totals_by_feature (an event
        // count, not a distinct-user count); `agent` reuses the enterprise
        // row's own monthly_active_agent_users rolling counter.
        const legacyChatInteractions =
          features.find((f) => f.feature === "chat_panel" || f.feature.startsWith("chat_panel_"))
            ?.user_initiated_interaction_count ?? 0;
        return {
          day: d.day,
          completions: completionFeatures.reduce((s, f) => s + (f.code_generation_activity_count || 0), 0),
          // `chat`/`agent` prefer distinct-user counts to match the unit
          // used by every other branch (hasFilter/aggregated above both use
          // chatUsers/agentUsers from getFeatureUsageDaily) — the
          // SQL-aggregated featureByDay value, exactly like `app` below.
          // Only when featureByDay has no row for the day (undefined, not
          // an explicit supported zero) do we fall back to the legacy
          // enterprise-direct aggregate above, so the chart never falsely
          // reports zero just because user-level metrics are unavailable.
          chat: featureByDay.get(d.day)?.chatUsers ?? legacyChatInteractions,
          agent: featureByDay.get(d.day)?.agentUsers ?? (d.monthly_active_agent_users ?? 0),
          cli: d.daily_active_cli_users || 0,
          // Prefer the enterprise row's own dedicated App counter; NULL means
          // unavailable (fall back to the SQL-aggregated featureByDay value),
          // while an explicit 0 is a valid supported "no App users" reading
          // that must NOT be overridden by a nonzero user-level fallback.
          app: d.daily_active_copilot_app_users ?? featureByDay.get(d.day)?.appUsers ?? 0,
        };
      });

      cliVsIde = metrics.map((d) => ({
        day: d.day,
        ideUsers: d.daily_active_users - (d.daily_active_cli_users ?? 0),
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

    // Average WAU/MAU across the selected period — changes with date range selection,
    // unlike rolling values which are point-in-time snapshots at the last day.
    const avgOfField = (field: 'weekly' | 'monthly') =>
      activeUsersTrend.length > 0
        ? Math.round(activeUsersTrend.reduce((sum, t) => sum + (t[field] ?? 0), 0) / activeUsersTrend.length)
        : 0;
    const avgWAU = avgOfField('weekly');
    const avgMAU = avgOfField('monthly');

    const kpis = {
      dailyActiveUsers: latestTrend?.daily || 0,
      weeklyActiveUsers: avgWAU,
      monthlyActiveUsers: avgMAU,
      agentAdoption: adoption.totalUsers > 0 ? (adoption.agentUsers / adoption.totalUsers) * 100 : 0,
      codingAgentAdoption: adoption.totalUsers > 0 ? (adoption.codingAgentUsers / adoption.totalUsers) * 100 : 0,
      codeReviewAdoption: adoption.totalUsers > 0 ? (adoption.codeReviewUsers / adoption.totalUsers) * 100 : 0,
      cliUsers: latestTrend ? cliVsIde[cliVsIde.length - 1]?.cliUsers || 0 : 0,
      licenseUtilization: hasFilter
        ? -1 // Indicate N/A when filtered
        : (seatStats.total > 0 ? (seatStats.active30d / seatStats.total) * 100 : 0),
      periodActiveUsers: adoption.totalUsers,
      // Latest-day Copilot App active-user count from the featureUsage series
      // — an overlapping active-surface signal, not additive with the other
      // adoption KPIs above (see OverviewData.featureUsage.app for details).
      copilotAppUsers: featureUsage.length > 0 ? featureUsage[featureUsage.length - 1].app : 0,
      deltas: {
        dau: prevTrend && latestTrend && prevTrend.daily > 0
          ? ((latestTrend.daily - prevTrend.daily) / prevTrend.daily) * 100 : 0,
      },
    };

    const totalDays = activeUsersTrend.length;

    return NextResponse.json({
      kpis,
      dailyTrendValues: activeUsersTrend.map(t => t.daily),
      activeUsersTrend,
      acceptanceRateTrend,
      chatModes,
      featureUsage,
      cliVsIde,
      dataAsOf: end,
      daysLoaded: totalDays,
      dataSource: hasFilter ? "filtered-users" : (resolvedId ? "enterprise" : (isMultiEnterprise ? "multi-enterprise" : (aggregated.length > 0 ? "aggregated" : "user-aggregated"))),
      filtered: hasFilter || !!enterpriseSlugs,
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
