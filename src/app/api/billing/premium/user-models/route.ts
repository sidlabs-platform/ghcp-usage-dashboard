import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { resolveWindow } from "@/lib/utils";
import { getPremiumUserModelBreakdown } from "@/lib/db/billing-repo";
import type { PremiumFilters } from "@/lib/db/billing-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
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

    const window = resolveWindow(params, 28);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { start, end } = window;

    // Parse scope filter (teams/orgs/enterprises) via the shared parser
    const scopeFilter = parseScopeFilter(params);
    const { selectedOrgs, allowedLogins, enterpriseSlugs } = scopeFilter;

    const filters: PremiumFilters = {
      organization: params.get("organization")?.split(",").filter(Boolean),
      model: params.get("model")?.split(",").filter(Boolean),
      exceedsQuota: params.get("exceedsQuota") === "true" ? true
        : params.get("exceedsQuota") === "false" ? false
          : undefined,
    };

    if (allowedLogins) {
      filters.allowedLogins = Array.from(allowedLogins);
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
    console.error("Failed to fetch premium user model breakdown", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
