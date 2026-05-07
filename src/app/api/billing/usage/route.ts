import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import {
  getUsageRecordsPaginated,
  getUsageFilterOptions,
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
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

    const rawPage = parseInt(params.get("page") || "1", 10);
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(params.get("pageSize") || "50", 10);
    const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? 50 : rawPageSize), 200);
    const sort = params.get("sort") || "date";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";
    const search = params.get("search") || undefined;

    // Parse scope filter (teams/orgs/enterprises)
    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const enterprisesParam = params.get("enterprises");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;
    const hasScope = selectedTeams.length > 0 || selectedOrgs.length > 0;

    const rawChargeScope = params.get("chargeScope");
    const validChargeScopes: ChargeScope[] = ["user", "org"];
    const chargeScope = rawChargeScope && validChargeScopes.includes(rawChargeScope as ChargeScope)
      ? (rawChargeScope as ChargeScope)
      : undefined;

    const filters: BillingFilters = {
      product: params.get("product")?.split(",").filter(Boolean),
      sku: params.get("sku")?.split(",").filter(Boolean),
      organization: params.get("organization")?.split(",").filter(Boolean),
      username: params.get("username") || undefined,
      chargeScope,
      costCenter: params.get("costCenter") || undefined,
    };

    if (hasScope) {
      filters.allowedLogins = resolveFilteredUsers(selectedTeams, selectedOrgs, enterpriseSlugs);
      if (selectedOrgs.length > 0) filters.scopeOrgs = selectedOrgs;
    }

    const { records, total } = getUsageRecordsPaginated(
      start, end, page, pageSize, sort, sortDir, search, filters, enterpriseSlugs,
    );

    const filterOptions = getUsageFilterOptions(start, end, enterpriseSlugs);

    return NextResponse.json({
      enabled: true,
      records,
      pagination: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize),
      },
      filterOptions,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
