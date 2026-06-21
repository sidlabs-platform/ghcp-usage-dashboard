import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import {
  getPremiumUserSummary,
  getPremiumModelSummary,
  getPremiumDailyTrend,
} from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
import {
  getUserAiCreditsSummary,
  getUserAiCreditsTotals,
  type UserAiCreditsFilters,
} from "@/lib/db/metrics-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

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

    // Parse scope filter (teams/orgs/enterprises)
    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const enterprisesParam = params.get("enterprises");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;
    const hasScope = selectedTeams.length > 0 || selectedOrgs.length > 0;

    const filters: PremiumFilters = {
      username: params.get("username") || undefined,
      organization: params.get("organization")?.split(",").filter(Boolean),
      model: params.get("model")?.split(",").filter(Boolean),
      exceedsQuota: params.get("exceedsQuota") === "true" ? true
        : params.get("exceedsQuota") === "false" ? false
        : undefined,
    };

    if (hasScope) {
      filters.allowedLogins = resolveFilteredUsers(selectedTeams, selectedOrgs, enterpriseSlugs);
      if (selectedOrgs.length > 0) filters.scopeOrgs = selectedOrgs;
    }

    const userSummary = getPremiumUserSummary(start, end, filters, enterpriseSlugs);
    const modelSummary = getPremiumModelSummary(start, end, filters, enterpriseSlugs);
    const dailyTrend = getPremiumDailyTrend(start, end, filters, enterpriseSlugs);
    const metricsAiCreditsFilters: UserAiCreditsFilters = {
      userLogin: filters.username,
      allowedLogins: filters.allowedLogins,
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

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
