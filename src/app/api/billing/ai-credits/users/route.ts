import { NextRequest, NextResponse } from "next/server";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getUserAiCreditsTotals,
  getUserAiCreditsUsersPaginated,
  type UserAiCreditsFilters,
} from "@/lib/db/metrics-repo";
import { getAiCreditsReconciliation, type PremiumFilters } from "@/lib/db/billing-repo";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(params, 28);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;

    const rawPage = parseInt(params.get("page") || "1", 10);
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(params.get("pageSize") || "50", 10);
    const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? 50 : rawPageSize), 200);
    const sort = params.get("sort") || "total_ai_credits_used";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";
    const search = params.get("search") || undefined;

    const scope = parseScopeFilter(params);
    const filters: UserAiCreditsFilters = {
      allowedLogins: scope.allowedLogins ? Array.from(scope.allowedLogins) : undefined,
      search,
    };
    const reconciliationFilters: PremiumFilters | undefined =
      filters.allowedLogins !== undefined || scope.selectedOrgs.length > 0
        ? {
            allowedLogins: filters.allowedLogins,
            scopeOrgs: scope.selectedOrgs.length > 0 ? scope.selectedOrgs : undefined,
          }
        : undefined;

    const result = getUserAiCreditsUsersPaginated(
      start,
      end,
      page,
      pageSize,
      sort,
      sortDir,
      search,
      filters,
      scope.enterpriseSlugs,
    );
    const totals = getUserAiCreditsTotals(start, end, filters, scope.enterpriseSlugs);

    // The billing report is the system of record for what was actually charged.
    // Surfacing its unattributed remainder here lets this page reconcile itself
    // against Token Usage and AI Credits instead of contradicting them. Missing
    // billing data must not break the page, so this degrades to null.
    let reconciliation = null;
    try {
      reconciliation = getAiCreditsReconciliation(start, end, reconciliationFilters, scope.enterpriseSlugs);
    } catch (err) {
      console.warn("[ai-credits/users] reconciliation unavailable:", err);
    }

    return NextResponse.json({
      users: result.users,
      totals,
      reconciliation,
      pagination: {
        page,
        pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
