import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { resolveWindow } from "@/lib/utils";
import {
  getPremiumRequestsPaginated,
  getPremiumFilterOptions,
} from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
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
    const window = resolveWindow(params, 28);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { days, start, end } = window;

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

    const { records, total } = getPremiumRequestsPaginated(
      start, end, page, pageSize, sort, sortDir, search, filters, enterpriseSlugs,
    );

    const filterOptions = getPremiumFilterOptions(start, end, enterpriseSlugs);

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

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
