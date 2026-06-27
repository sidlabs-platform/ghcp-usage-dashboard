import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { getPremiumUserModelBreakdown } from "@/lib/db/billing-repo";
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
    const username = params.get("username") || "";
    if (!username) {
      return NextResponse.json({ error: "username is required" }, { status: 400 });
    }

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

    const organization = params.get("rowOrganization") ?? undefined;

    const models = getPremiumUserModelBreakdown(
      start,
      end,
      username,
      organization,
      filters,
      enterpriseSlugs,
    );

    return NextResponse.json({
      enabled: true,
      username,
      organization: organization ?? "",
      models,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
