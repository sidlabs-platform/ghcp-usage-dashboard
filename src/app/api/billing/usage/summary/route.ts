import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";
import {
  getProductBreakdown,
  getOrgBreakdown,
  getUserBreakdown,
  getDailyAggregates,
  getCostCenterBreakdown,
  getRepositoryBreakdown,
} from "@/lib/db/billing-repo";
import type { BillingFilters } from "@/lib/db/billing-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import type { ChargeScope } from "@/lib/types/billing";

async function handler(request: NextRequest) {
  try {
    if (!isMetricEnabled("billing")) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
    const { start, end } = getDateRange(days);
    const groupBy = params.get("groupBy") || "product";

    // Parse scope filter (teams/orgs/enterprises)
    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const enterprisesParam = params.get("enterprises");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;
    const hasScope = selectedTeams.length > 0 || selectedOrgs.length > 0;

    const filters: BillingFilters = {
      product: params.get("product")?.split(",").filter(Boolean),
      sku: params.get("sku")?.split(",").filter(Boolean),
      organization: params.get("organization")?.split(",").filter(Boolean),
      username: params.get("username") || undefined,
      chargeScope: (params.get("chargeScope") as ChargeScope) || undefined,
      costCenter: params.get("costCenter") || undefined,
    };

    if (hasScope) {
      filters.allowedLogins = resolveFilteredUsers(selectedTeams, selectedOrgs, enterpriseSlugs);
      if (selectedOrgs.length > 0) filters.scopeOrgs = selectedOrgs;
    }

    let groupedData;
    switch (groupBy) {
      case "organization":
        groupedData = getOrgBreakdown(start, end, filters, enterpriseSlugs);
        break;
      case "user":
        groupedData = getUserBreakdown(start, end, filters, enterpriseSlugs);
        break;
      case "daily":
        groupedData = getDailyAggregates(start, end, filters, enterpriseSlugs);
        break;
      case "costCenter":
        groupedData = getCostCenterBreakdown(start, end, filters, enterpriseSlugs);
        break;
      case "repository":
        groupedData = getRepositoryBreakdown(start, end, filters, undefined, enterpriseSlugs);
        break;
      case "product":
      default:
        groupedData = getProductBreakdown(start, end, filters, enterpriseSlugs);
        break;
    }

    return NextResponse.json({
      enabled: true,
      groupBy,
      data: groupedData,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
