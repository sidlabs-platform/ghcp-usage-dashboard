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
  getCompletionTotals,
  getFeatureUsageDaily,
  estimateRowCount,
  buildLoginFilter,
  buildEnterpriseFilter,
  buildUserScopeFilter,
} from "@/lib/db/aggregation-queries";
import { getDb } from "@/lib/db/database";
import { parseDateRangeParams } from "@/lib/utils";
import { extractCompletionMetrics, extractAgentMetrics, isCompletionFeature, isAgentFeature } from "@/lib/aggregation/separate-metrics";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { getOverviewKPIs } from "@/lib/db/billing-repo";

const DAYS_PER_MONTH = 30;

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(params, 7);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    ) + 1;

    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const hasFilter = filter.selectedTeams.length > 0 || filter.selectedOrgs.length > 0;
    const allowedLoginsSet = filter.allowedLogins;
    const allowedLoginsArray = allowedLoginsSet ? Array.from(allowedLoginsSet) : undefined;
    const allowedUserScopes = filter.allowedUserScopes;
    const emptyScopeMeansNoRows = allowedLoginsArray !== undefined;

    // Row-count guard
    const estimate = estimateRowCount(
      start,
      end,
      allowedLoginsArray,
      enterpriseSlugs,
      emptyScopeMeansNoRows,
      allowedUserScopes,
    );
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
    const featureRows = getFeatureUsageDaily(
      start,
      end,
      allowedLoginsArray,
      enterpriseSlugs,
      emptyScopeMeansNoRows,
      allowedUserScopes,
    );
    const featureByDay = new Map(featureRows.map((r) => [r.day, r]));

    let activeUsersTrend;
    let acceptanceRateTrend;
    let featureUsage;
    let cliVsIde;

    if (hasFilter || useAggregated) {
      // Build all trends from SQL aggregation — no getAllUserMetrics()

      // Active users trend via SQL
      const userTrendRows = getActiveUsersDailyTrend(
        start,
        end,
        allowedLoginsArray,
        enterpriseSlugs,
        emptyScopeMeansNoRows,
        allowedUserScopes,
      );

      if (hasFilter) {
        // For filtered view, use rolling window calculations for WAU/MAU
        const rollingTrendRows = getActiveUsersRollingTrend(
          start,
          end,
          allowedLoginsArray,
          enterpriseSlugs,
          emptyScopeMeansNoRows,
          allowedUserScopes,
        );
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
      const compTrendRows = getCompletionDailyTrend(
        start,
        end,
        allowedLoginsArray,
        enterpriseSlugs,
        emptyScopeMeansNoRows,
        allowedUserScopes,
      );
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

      // Source decision made ONCE for the whole response/range — never
      // per-day — to avoid mixing distinct-user counts (chatUsers/agentUsers)
      // with legacy event/interaction counts (user_initiated_interaction_count/
      // code_generation_activity_count) within the same chart series. If
      // getFeatureUsageDaily returned at least one row anywhere in the
      // selected range, user-level data is considered available for the
      // whole range: every day uses chatUsers/agentUsers, and a day with no
      // row (not present in featureByDay) becomes 0, never a per-day legacy
      // fallback. Only when the whole range has zero user-level rows (e.g.
      // user-level metrics are disabled/empty entirely) do we fall back to
      // the legacy enterprise-direct totals_by_feature aggregate for every
      // day, as a compatibility fallback.
      const hasUserFeatureData = featureRows.length > 0;

      featureUsage = metrics.map((d) => {
        const features = d.totals_by_feature || [];
        const completionFeatures = features.filter((f) => isCompletionFeature(f.feature));
        // Legacy enterprise-direct fallback values, used only when
        // hasUserFeatureData is false for the whole range (see above).
        // `chat` is the total chat_panel*/chat_panel interaction count from
        // this enterprise row's own totals_by_feature (an event count, not a
        // distinct-user count); `agent` uses the code_generation_activity_count
        // from agent_edit rows.
        const legacyChatInteractions =
          features.find((f) => f.feature === "chat_panel" || f.feature.startsWith("chat_panel_"))
            ?.user_initiated_interaction_count ?? 0;
        const legacyAgentInteractions =
          features.find((f) => isAgentFeature(f.feature))
            ?.code_generation_activity_count ?? 0;
        return {
          day: d.day,
          completions: completionFeatures.reduce((s, f) => s + (f.code_generation_activity_count || 0), 0),
          // `chat`/`agent` use distinct-user counts for every day once
          // hasUserFeatureData is true for the range (missing days become 0,
          // never a per-day legacy fallback), matching the unit used by
          // every other branch (hasFilter/aggregated above both use
          // chatUsers/agentUsers from getFeatureUsageDaily), exactly like
          // `app` below. Only when the whole range has no user-level rows do
          // we use the legacy enterprise-direct aggregate for every day.
          chat: hasUserFeatureData ? (featureByDay.get(d.day)?.chatUsers ?? 0) : legacyChatInteractions,
          agent: hasUserFeatureData ? (featureByDay.get(d.day)?.agentUsers ?? 0) : legacyAgentInteractions,
          cli: d.daily_active_cli_users || 0,
          // Prefer the enterprise row's own dedicated App counter; NULL means
          // unavailable (fall back to the SQL-aggregated featureByDay value),
          // while an explicit 0 is a valid supported "no App users" reading
          // that must NOT be overridden by a nonzero user-level fallback.
          // `app` units already match (both are distinct-user counts), so no
          // whole-range gating is needed here.
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
    const chatModes = getChatModeSums(
      start,
      end,
      allowedLoginsArray,
      enterpriseSlugs,
      emptyScopeMeansNoRows,
      allowedUserScopes,
    );

    // Adoption stats via SQL aggregation
    const adoption = getAdoptionStats(
      start,
      end,
      allowedLoginsArray,
      enterpriseSlugs,
      emptyScopeMeansNoRows,
      allowedUserScopes,
    );

    // Period-wide completion acceptance rate — single aggregated query, consistent
    // across enterprise/aggregated/filtered paths.
    const completionTotals = getCompletionTotals(
      start,
      end,
      allowedLoginsArray,
      enterpriseSlugs,
      emptyScopeMeansNoRows,
      allowedUserScopes,
    );
    const completionAcceptanceRate =
      completionTotals.compGenCount > 0
        ? (completionTotals.compAcceptCount / completionTotals.compGenCount) * 100
        : 0;

    // AI credits consumed from usage API (ai_credits_used column on user_daily_metrics)
    let aiCreditsConsumed: number | null = null;
    try {
      const loginF = allowedUserScopes !== undefined
        ? buildUserScopeFilter(allowedUserScopes)
        : buildLoginFilter(
            allowedLoginsArray ?? [],
            "user_login",
            allowedLoginsArray !== undefined,
          );
      const entF = buildEnterpriseFilter(enterpriseSlugs);
      const acRow = getDb()
        .prepare(
          `SELECT COALESCE(SUM(ai_credits_used), 0) AS total
           FROM user_daily_metrics
           WHERE day >= ? AND day <= ?
           ${loginF.clause}${entF.clause}`,
        )
        .get(start, end, ...loginF.params, ...entF.params) as { total: number } | undefined;
      const total = acRow?.total ?? 0;
      if (total > 0) aiCreditsConsumed = total;
    } catch { /* usage column unavailable — stay null */ }

    // Monthly net cost from billing tables (graceful degradation: null when not synced)
    let monthlyNetCost: number | null = null;
    let billingAvailable = false;
    try {
      const billingFilters = hasFilter
        ? {
            allowedLogins: allowedLoginsArray,
          allowedUserScopes,
          scopeOrgs: filter.selectedTeams.length === 0 ? filter.selectedOrgs : undefined,
        }
        : undefined;
      const billingKpis = getOverviewKPIs(start, end, billingFilters, enterpriseSlugs);
      // totalNet already combines metered + premium; only mark available when cost is non-zero.
      if ((billingKpis?.totalGross ?? 0) > 0) {
        monthlyNetCost = billingKpis.totalNet * (DAYS_PER_MONTH / days);
        billingAvailable = true;
      }
    } catch { /* billing tables may not exist — stay null */ }

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
      // ── Added in #100 ────────────────────────────────────────────────────
      completionAcceptanceRate,
      inactiveSeats: hasFilter ? 0 : (seatStats.inactive30d ?? 0),
      totalSeats: hasFilter ? 0 : (seatStats.total ?? 0),
      monthlyNetCost,
      aiCreditsConsumed,
      billingAvailable,
    };

    const totalDays = activeUsersTrend.length;

    return NextResponse.json({
      kpis,
      // One series per KPI that has one. `periodActiveUsers` is a distinct count
      // over the whole window, not a daily series, so it deliberately has none —
      // sharing `dailyTrendValues` across cards drew the same curve under
      // different numbers.
      dailyTrendValues: activeUsersTrend.map(t => t.daily),
      weeklyTrendValues: activeUsersTrend.map(t => t.weekly ?? 0),
      monthlyTrendValues: activeUsersTrend.map(t => t.monthly ?? 0),
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
