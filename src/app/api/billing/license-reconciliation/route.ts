import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { getLicensingConfig } from "@/lib/config/dashboard-config";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getLicenseReconciliationRows,
  computeLicenseKPIs,
  computePlanBreakdown,
  computeOrgBreakdown,
  computeUtilizationBuckets,
  sortLicenseRows,
  type LicenseSortField,
} from "@/lib/db/license-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

const SORT_FIELDS: LicenseSortField[] = [
  "user_login",
  "plan_type",
  "license_assigned_date",
  "last_activity_at",
  "license_cost",
  "aic_consumed_credits",
  "aic_consumed_usd",
  "utilization_pct",
  "total_cost",
];

async function handler(request: NextRequest) {
  try {
    // Reconciliation depends on AI-credit consumption; gate on the same
    // sub-toggles as the AI Credits page.
    if (
      !isBillingSubEnabledForAnyEnterprise("aiCredits") &&
      !isBillingSubEnabledForAnyEnterprise("premiumRequests")
    ) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { start, end } = getDateRange(daysResult.days);

    const rawPage = parseInt(params.get("page") || "1", 10);
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(params.get("pageSize") || "50", 10);
    const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? 50 : rawPageSize), 500);

    const sortParam = (params.get("sort") || "total_cost") as LicenseSortField;
    const sort: LicenseSortField = SORT_FIELDS.includes(sortParam) ? sortParam : "total_cost";
    const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";
    const search = params.get("search") || undefined;

    const scope = parseScopeFilter(params);

    const allRows = getLicenseReconciliationRows({
      start,
      end,
      filters: {
        allowedLogins: scope.allowedLogins,
        enterpriseSlugs: scope.enterpriseSlugs,
        search,
      },
    });

    // KPIs and breakdowns are computed over the full (filtered) dataset so they
    // remain accurate regardless of pagination.
    const kpis = computeLicenseKPIs(allRows);
    const planBreakdown = computePlanBreakdown(allRows);
    const orgBreakdown = computeOrgBreakdown(allRows);
    const utilizationBuckets = computeUtilizationBuckets(allRows);

    const sorted = sortLicenseRows(allRows, sort, sortDir);
    const offset = (page - 1) * pageSize;
    const rows = sorted.slice(offset, offset + pageSize);

    const cfg = getLicensingConfig();

    return NextResponse.json(
      {
        enabled: true,
        kpis,
        rows,
        planBreakdown,
        orgBreakdown,
        utilizationBuckets,
        config: { currency: cfg.currency, creditToUsd: cfg.creditToUsd },
        pagination: {
          page,
          pageSize,
          totalItems: sorted.length,
          totalPages: Math.ceil(sorted.length / pageSize),
        },
      },
      { headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
