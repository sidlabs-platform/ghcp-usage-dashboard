import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import {
  getOverviewKPIs,
  getDailyAggregates,
  getProductBreakdown,
  getOrgBreakdown,
  getUserBreakdown,
  getCostCenterBreakdown,
  getCopilotCostBasis,
} from "@/lib/db/billing-repo";
import { isValidPeriod, monthBounds, monthDayCount } from "@/lib/date/month-range";
import type { BillingFilters } from "@/lib/db/billing-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    if (!isMetricEnabledForAnyEnterprise("billing")) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;

    // A `period` ("YYYY-MM") pins the window to a calendar month. Billing is
    // billed monthly and the licensing tables are keyed by month, so this is
    // the only basis on which the Billing and License & AI Credits pages can
    // be expected to agree. A rolling `days` window remains the default.
    const periodParam = params.get("period");
    let period: string | null = null;
    let start: string;
    let end: string;
    let days: number;

    if (periodParam) {
      if (!isValidPeriod(periodParam)) {
        return NextResponse.json(
          { error: `Invalid period "${periodParam}": expected format YYYY-MM` },
          { status: 400 }
        );
      }
      period = periodParam;
      ({ startDate: start, endDate: end } = monthBounds(period));
      days = monthDayCount(period);
    } else {
      const daysResult = parseAndClampDays(params.get("days"), 28);
      if ("error" in daysResult) {
        return NextResponse.json({ error: daysResult.error }, { status: 400 });
      }
      days = daysResult.days;
      ({ start, end } = getDateRange(days));
    }

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
    // Shared with /api/billing/license-reconciliation so both surfaces quote
    // the same seat cost and credit total for the same window.
    let costBasis = null;
    try {
      costBasis = getCopilotCostBasis(start, end, filters, enterpriseSlugs);
    } catch (err) {
      // Never fail the page over the reconciliation strip.
      console.error("Failed to compute Copilot cost basis:", err);
    }

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
      costBasis,
      daysLoaded: days,
      period,
      startDate: start,
      endDate: end,
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
