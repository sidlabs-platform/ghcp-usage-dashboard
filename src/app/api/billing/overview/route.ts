import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";
import {
  getOverviewKPIs,
  getDailyAggregates,
  getProductBreakdown,
  getOrgBreakdown,
  getUserBreakdown,
  getCostCenterBreakdown,
} from "@/lib/db/billing-repo";
import type { BillingFilters } from "@/lib/db/billing-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    if (!isMetricEnabled("billing")) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
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

    const filters: BillingFilters = {};
    if (hasScope) {
      filters.allowedLogins = resolveFilteredUsers(selectedTeams, selectedOrgs, enterpriseSlugs);
      if (selectedOrgs.length > 0) filters.scopeOrgs = selectedOrgs;
    }

    const kpis = getOverviewKPIs(start, end, filters, enterpriseSlugs);
    const dailyAggregates = getDailyAggregates(start, end, filters, enterpriseSlugs);
    const productBreakdown = getProductBreakdown(start, end, filters, enterpriseSlugs);
    const orgBreakdown = getOrgBreakdown(start, end, filters, enterpriseSlugs);
    const userBreakdown = getUserBreakdown(start, end, filters, enterpriseSlugs);
    const costCenterBreakdown = getCostCenterBreakdown(start, end, filters, enterpriseSlugs);

    // Build daily cost trend (aggregate across products per day)
    const dailyMap = new Map<string, { day: string; total_net: number; user_net: number; org_net: number }>();
    for (const agg of dailyAggregates) {
      const existing = dailyMap.get(agg.day) || { day: agg.day, total_net: 0, user_net: 0, org_net: 0 };
      existing.total_net += agg.total_net;
      if (agg.charge_scope === "user") existing.user_net += agg.total_net;
      else existing.org_net += agg.total_net;
      dailyMap.set(agg.day, existing);
    }
    const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    return NextResponse.json({
      enabled: true,
      kpis,
      dailyTrend,
      productBreakdown,
      orgBreakdown,
      userBreakdown,
      costCenterBreakdown,
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
