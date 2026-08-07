import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import {
  getPremiumUserSummary,
  getPremiumModelSummary,
  getPremiumDailyTrend,
  getPremiumCostCenterBreakdown,
  getPremiumOrgBreakdown,
} from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
import {
  getUserAiCreditsSummary,
  getUserAiCreditsTotals,
  type UserAiCreditsFilters,
} from "@/lib/db/metrics-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { AI_CREDIT_COVERAGE_NOTE } from "@/lib/constants";

async function handler(request: NextRequest) {
  try {
    if (!isBillingSubEnabledForAnyEnterprise("premiumRequests") &&
        !isBillingSubEnabledForAnyEnterprise("aiCredits")) {
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
      exceedsQuota: params.get("exceedsQuota") === "true" ? true
        : params.get("exceedsQuota") === "false" ? false
        : undefined,
    };

    if (scope.allowedLogins) {
      filters.allowedLogins = Array.from(scope.allowedLogins);
    }
    if (scope.selectedOrgs.length > 0) {
      filters.scopeOrgs = scope.selectedOrgs;
    }

    const userSummary = getPremiumUserSummary(start, end, filters, enterpriseSlugs);
    const modelSummary = getPremiumModelSummary(start, end, filters, enterpriseSlugs);
    const dailyTrend = getPremiumDailyTrend(start, end, filters, enterpriseSlugs);
    const costCenterBreakdown = getPremiumCostCenterBreakdown(start, end, filters, enterpriseSlugs);
    const orgBreakdown = getPremiumOrgBreakdown(start, end, filters, enterpriseSlugs);
    const metricsAiCreditsFilters: UserAiCreditsFilters = {
      userLogin: filters.username,
      allowedLogins: scope.allowedLogins ? Array.from(scope.allowedLogins) : undefined,
    };
    const metricsAiCreditSummary = getUserAiCreditsSummary(
      start,
      end,
      metricsAiCreditsFilters,
      enterpriseSlugs,
      10
    );
    const metricsAiCreditTotals = getUserAiCreditsTotals(
      start,
      end,
      metricsAiCreditsFilters,
      enterpriseSlugs
    );

    // Compute KPIs from user summary
    const totalRequests = userSummary.reduce((sum, u) => sum + u.total_requests, 0);
    const usersOverQuota = userSummary.filter((u) => u.over_quota > 0).length;
    const totalUsers = userSummary.length;
    const totalNet = userSummary.reduce((sum, u) => sum + u.total_net, 0);
    const topModel = modelSummary.length > 0
      ? modelSummary.reduce((a, b) => (a.total_requests > b.total_requests ? a : b)).model
      : "N/A";
    const totalAiCredits = userSummary.reduce((sum, u) => sum + (u.total_aic_quantity ?? 0), 0);
    const totalAicGross = userSummary.reduce((sum, u) => sum + (u.total_aic_gross ?? 0), 0);

    return NextResponse.json({
      enabled: true,
      kpis: {
        totalRequests,
        usersOverQuota,
        totalUsers,
        totalNet,
        topModel,
        uniqueModels: modelSummary.length,
        totalAiCredits,
        totalAicGross,
        metricsTotalAiCreditsUsed: metricsAiCreditTotals.total_ai_credits_used,
        metricsTrackedUsers: metricsAiCreditTotals.tracked_users,
        metricsTopUser: metricsAiCreditTotals.top_user_login,
      },
      userSummary,
      modelSummary,
      dailyTrend,
      costCenterBreakdown,
      orgBreakdown,
      coverageNote: AI_CREDIT_COVERAGE_NOTE,
      metricsAiCreditSummary,
      daysLoaded: days,
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
