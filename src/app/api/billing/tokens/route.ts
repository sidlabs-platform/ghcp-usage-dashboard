import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import {
  getTokenKpis,
  getTokenModelSummary,
  getTokenDailyTrend,
  getTokenUserSummary,
  getTokenAttribution,
  getTokenModelDailySeries,
  getTokenUserModelEfficiency,
} from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
import {
  analyzeCorrelation,
  analyzeCacheSavings,
  detectAnomalies,
} from "@/lib/analysis/token-credits";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";

/**
 * Token usage analytics, backed by the per-model token breakdown GitHub added to
 * the AI usage report on 2026-08-11.
 *
 * Historical rows synced before that breakdown was wired up carry zero tokens.
 * Rather than failing or rendering misleading zeros, the response sets
 * `hasTokenData: false` so the page can show an explicit empty state pointing at
 * the billing refetch action.
 */
async function handler(request: NextRequest) {
  try {
    if (
      !isBillingSubEnabledForAnyEnterprise("premiumRequests") &&
      !isBillingSubEnabledForAnyEnterprise("aiCredits")
    ) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

    const scope = parseScopeFilter(params);
    const enterpriseSlugs = scope.enterpriseSlugs;

    const filters: PremiumFilters = {
      username: params.get("username") || undefined,
      organization: params.get("organization")?.split(",").filter(Boolean),
      model: params.get("model")?.split(",").filter(Boolean),
    };
    if (scope.allowedLogins) {
      filters.allowedLogins = Array.from(scope.allowedLogins);
    }
    if (scope.selectedOrgs.length > 0) {
      filters.scopeOrgs = scope.selectedOrgs;
    }

    const kpis = getTokenKpis(start, end, filters, enterpriseSlugs);
    const hasTokenData = kpis.total_tokens > 0;

    const modelSummary = getTokenModelSummary(start, end, filters, enterpriseSlugs);
    const dailyTrend = getTokenDailyTrend(start, end, filters, enterpriseSlugs);
    const topUsers = getTokenUserSummary(start, end, filters, enterpriseSlugs, 50);
    const attribution = getTokenAttribution(start, end, filters, enterpriseSlugs, 25);

    // Correlation / cache / anomaly analysis runs over pre-aggregated rows only.
    const modelDaily = hasTokenData
      ? getTokenModelDailySeries(start, end, filters, enterpriseSlugs)
      : [];
    const correlation = analyzeCorrelation(modelDaily);
    const cacheSavings = analyzeCacheSavings(modelDaily, correlation.fleetRatesPerMTok);
    const anomalies = hasTokenData
      ? detectAnomalies({
          modelDaily,
          userModel: getTokenUserModelEfficiency(start, end, filters, enterpriseSlugs),
        })
      : [];

    return NextResponse.json(
      {
        enabled: true,
        hasTokenData,
        kpis,
        modelSummary,
        dailyTrend,
        topUsers,
        attribution,
        correlation,
        cacheSavings,
        anomalies,
        range: { start, end },
        daysLoaded: days,
      },
      {
        headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
      }
    );
  } catch (err) {
    // Never surface the raw exception: a SQLite failure names tables, columns
    // and the database file path.
    console.error("[api/billing/tokens] failed:", err);
    return NextResponse.json({ error: "Failed to load token analytics." }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
