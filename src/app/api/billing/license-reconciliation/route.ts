import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise, getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import { parseDateRangeParams } from "@/lib/utils";
import { getLicensingConfig, LicensingConfigError, type LicensePlanKey } from "@/lib/config/dashboard-config";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getLicenseReconciliationDataset,
  computeLicenseKPIs,
  computePlanBreakdown,
  computeOrgBreakdown,
  computeUtilizationBuckets,
  sortLicenseRows,
  type LicenseSortField,
} from "@/lib/db/license-repo";
import {
  queryLicensePeriodRows,
  getMaterializedPeriodKPIs,
  getMaterializedPlanBreakdown,
  getMaterializedOrgBreakdown,
  getMaterializedPeriods,
  getEarliestMaterializedPeriod,
  getMaterializedUtilizationBuckets,
  getLatestLicenseQualitySummary,
  hasMaterializedRows,
  DETAIL_SORT_COLUMNS,
  ROLLUP_SORT_COLUMNS,
  type PaginatedLicenseRows,
} from "@/lib/db/license-history-repo";
import type { LicensePeriodFilterQuery, LicenseHistoryKPIs, LicenseReconciliationKPIs } from "@/lib/types/licensing";
import { getCopilotCostBasis, type CopilotCostBasis } from "@/lib/db/billing-repo";
import { monthBounds } from "@/lib/date/month-range";
import type { AccountState } from "@/lib/licensing/identity-resolver";
import type { SeatLedgerConfidence } from "@/lib/licensing/seat-ledger";
import { earliestRecoverablePeriod, parseReportMonths, MAX_REPORT_MONTHS } from "@/lib/licensing/periods";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

const LEGACY_SORT_FIELDS: LicenseSortField[] = [
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

const VIEWS = ["detail", "rollup"] as const;
export type ReconciliationView = (typeof VIEWS)[number];

// Mirrors `LicensePlanKey` from `@/lib/config/dashboard-config` (not exported
// as a runtime array there), same convention as the existing `SORT_FIELDS`
// allowlist above.
const PLAN_TYPES: LicensePlanKey[] = ["business", "enterprise", "unknown"];

// Mirrors `AccountState` from `@/lib/licensing/identity-resolver` (type-only
// export; no runtime array exists there).
const ACCOUNT_STATES: AccountState[] = ["unknown", "member", "suspended", "deprovisioned"];

// No exported type backs these literals (see `materialize-license-period.ts`);
// hardcoded here as the validation allowlist, same convention as PLAN_TYPES.
const SEAT_STATUSES = ["active", "inactive", "no_seat"] as const;

// Mirrors `SeatLedgerConfidence` from `@/lib/licensing/seat-ledger`.
const HISTORY_CONFIDENCE_LEVELS: SeatLedgerConfidence[] = [
  "exact_snapshot",
  "audit_reconstructed",
  "live_snapshot_only",
  "unrecoverable",
];

function splitCsvParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function validateAllowlist<T extends string>(
  values: string[] | undefined,
  allowlist: readonly T[],
  paramName: string,
): T[] | { error: string } {
  if (!values) return [];
  for (const v of values) {
    if (!allowlist.includes(v as T)) {
      return {
        error: `Invalid ${paramName} value "${v}". Expected one of: ${allowlist.join(", ")}.`,
      };
    }
  }
  return values as T[];
}

/**
 * Collects every enterprise slug the request references, whether via the
 * plain `enterprises` CSV param or via composite `teams=entSlug:teamSlug`
 * identifiers, so callers can validate all of them against the configured
 * enterprise list in one place. Order-preserving, de-duplicated.
 */
function collectRequestedEnterpriseSlugs(params: URLSearchParams): string[] {
  const slugs = new Set<string>();
  for (const slug of splitCsvParam(params.get("enterprises")) ?? []) {
    slugs.add(slug);
  }
  for (const t of splitCsvParam(params.get("teams")) ?? []) {
    const colonIdx = t.indexOf(":");
    if (colonIdx > 0) {
      slugs.add(t.substring(0, colonIdx));
    }
  }
  return Array.from(slugs);
}

/** Strictly parses a required-integer query param within `[min, max]`; returns a structured error otherwise. */
function parseStrictIntParam(
  raw: string | null,
  paramName: string,
  defaultValue: number,
  min: number,
  max: number,
): number | { error: string } {
  if (raw === null || raw === "") return defaultValue;
  if (!/^-?\d+$/.test(raw.trim())) {
    return { error: `Invalid ${paramName} value "${raw}". Expected an integer between ${min} and ${max}.` };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: `Invalid ${paramName} value "${raw}". Expected an integer between ${min} and ${max}.` };
  }
  return parsed;
}

/** Documented upper bound for `page`; prevents unbounded/overflow-prone offsets. */
const MAX_PAGE = 100_000;
/** Aligned with the repository's historical-query pageSize cap so live and historical modes behave consistently. */
const MAX_PAGE_SIZE = 200;

interface QualitySummary {
  pass: number;
  warning: number;
  fail: number;
}

function getCoverageWarnings(mode: "historical" | "live_snapshot_only", missingPeriods: string[]): string[] {
  if (missingPeriods.length === 0) return [];
  if (mode === "live_snapshot_only") {
    return [
      "No materialized historical data is available for the requested periods; showing the live snapshot instead.",
    ];
  }
  const noun = missingPeriods.length === 1 ? "period" : "periods";
  return [`Historical data is unavailable for requested ${noun}: ${missingPeriods.join(", ")}.`];
}

function getQualityWarnings(summary: QualitySummary): string[] {
  const warnings: string[] = [];
  if (summary.warning > 0) {
    const noun = summary.warning === 1 ? "check" : "checks";
    warnings.push(`Latest reconciliation diagnostics include ${summary.warning} warning ${noun}.`);
  }
  if (summary.fail > 0) {
    const noun = summary.fail === 1 ? "check" : "checks";
    warnings.push(`Latest reconciliation diagnostics include ${summary.fail} failed ${noun}.`);
  }
  return warnings;
}

/** Structured 400 error shape returned by {@link resolveReconciliationFilters}. */
export interface ReconciliationQueryError {
  error: string;
  status: 400;
}

/**
 * Project materialized-history KPIs onto the shape the page's KPI tiles read.
 *
 * The two pipelines count at different grains — history is keyed by
 * (org, holder, period) rows, the live snapshot by user — and previously
 * returned differently-named fields for the same tiles, so switching a scope
 * from live to historical silently blanked several of them. Naming the
 * projection here keeps one contract for the client.
 */
function toReconciliationKPIs(h: LicenseHistoryKPIs): LicenseReconciliationKPIs {
  const n = (v: number | undefined | null) => (Number.isFinite(v as number) ? (v as number) : 0);
  const activeSeats = n(h?.activeSeats);
  // Genuine seats only. `no_seat` rows are consumption with no licence behind
  // them; counting them here reported unmatched consumption as seats and as
  // pending cancellations.
  const inactiveSeats = n(h?.inactiveSeatRows);
  return {
    totalUsers: n(h?.totalUsers),
    totalSeats: activeSeats + inactiveSeats,
    activeSeats,
    // A real distinct-user aggregate, not a seat-row count squeezed into a
    // user slot — a user with several active seats would otherwise mask an
    // inactive one.
    activeUsers: n(h?.activeUsers),
    pendingCancellation: inactiveSeats,
    inactive30d: 0,
    zeroConsumptionSeats: n(h?.zeroConsumptionRows),
    totalLicenseCost: n(h?.totalLicenseCost),
    totalAllowanceCredits: n(h?.totalAllowanceCredits),
    totalAssignedUsd: n(h?.totalAssignedUsd),
    totalConsumedCredits: n(h?.totalConsumedCredits),
    totalConsumedUsd: n(h?.totalConsumedUsd),
    overallUtilizationPct: n(h?.overallUtilizationPct),
    overBudgetUsers: n(h?.overBudgetRows),
    totalCostOfOwnership: n(h?.totalCostOfOwnership),
    currency: h?.currency || "USD",
    // Materialization already emits `consumption_only` rows for consumption
    // with no matching seat, so nothing is left unplaced.
    unmatchedConsumedCredits: 0,
    unmatchedConsumedUsd: 0,
    unmatchedUsers: n(h?.noSeatRows),
    dataSource: "historical",
  };
}

/**
 * Pure (no DB access) resolution of every query parameter shared by the JSON
 * reconciliation API and the CSV export endpoint: period selection (with
 * explicit `periods` > custom `startDate`/`endDate` > `days`/default
 * precedence), view, scope, and every enum filter. Exported so
 * `/api/export/license-reconciliation` can reuse identical validation/
 * resolution logic without duplicating it (or resorting to SQL of its own).
 */
export interface ReconciliationFilterResolution {
  /** Resolved "YYYY-MM" periods driving historical queries. */
  periods: string[];
  /**
   * The single date window (inclusive `YYYY-MM-DD`) every figure on this page
   * is computed over — the live-snapshot per-user query, the shared Copilot
   * cost basis, and the CSV export alike.
   *
   * An explicit `periods` selection resolves to that month's bounds, exactly
   * as `/api/billing/overview` resolves its `period` param, so the two pages
   * quote the same month. Everything else keeps the caller's own
   * `startDate`/`endDate` or `days` window.
   */
  windowStart: string;
  windowEnd: string;
  /** The calendar period `windowStart`/`windowEnd` represent, or null when the window is not one whole month. */
  periodHint: string | null;
  view: ReconciliationView;
  scope: ReturnType<typeof parseScopeFilter>;
  search?: string;
  /** Base scope (enterprise + period + allowedLogins only, no narrow filters) used to decide fallback vs historical. */
  baseFilterQuery: LicensePeriodFilterQuery;
  /** Full filter query (base scope + narrow filters) used for the actual historical query/KPIs/breakdowns. */
  filterQuery: LicensePeriodFilterQuery;
}

export function resolveReconciliationFilters(
  params: URLSearchParams,
): ReconciliationFilterResolution | ReconciliationQueryError {
  const dateRange = parseDateRangeParams(params, 28);
  if ("error" in dateRange) {
    return { error: dateRange.error, status: 400 };
  }

  const viewParam = params.get("view") || "detail";
  if (!VIEWS.includes(viewParam as ReconciliationView)) {
    return { error: `Invalid view "${viewParam}". Expected one of: ${VIEWS.join(", ")}.`, status: 400 };
  }
  const view = viewParam as ReconciliationView;

  const explicitPeriods = splitCsvParam(params.get("periods"));
  let periods: string[];
  try {
    if (explicitPeriods) {
      periods = parseReportMonths(explicitPeriods);
    } else {
      // Derive month periods deterministically from the resolved date window
      // (custom startDate/endDate, or the days/default fallback) by reusing
      // `parseReportMonths`' range-expansion + `MAX_REPORT_MONTHS` cap rather
      // than reimplementing date-range → month-list conversion.
      const startMonth = dateRange.start.slice(0, 7);
      const endMonth = dateRange.end.slice(0, 7);
      periods = parseReportMonths([`${startMonth}..${endMonth}`]);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid periods parameter.";
    return { error: message, status: 400 };
  }
  if (periods.length > MAX_REPORT_MONTHS) {
    // Defensive: parseReportMonths already enforces this per-token, but guard
    // the merged/deduplicated result too since a caller could combine an
    // explicit `periods` list of many individually-valid single months.
    return {
      error: `Requested periods span ${periods.length} months, exceeding the maximum of ${MAX_REPORT_MONTHS}.`,
      status: 400,
    };
  }

  const planTypes = validateAllowlist(splitCsvParam(params.get("plan")), PLAN_TYPES, "plan");
  if ("error" in planTypes) return { ...planTypes, status: 400 };
  const accountStates = validateAllowlist(splitCsvParam(params.get("accountState")), ACCOUNT_STATES, "accountState");
  if ("error" in accountStates) return { ...accountStates, status: 400 };
  const seatStatuses = validateAllowlist(splitCsvParam(params.get("seatStatus")), SEAT_STATUSES, "seatStatus");
  if ("error" in seatStatuses) return { ...seatStatuses, status: 400 };
  const historyConfidence = validateAllowlist(
    splitCsvParam(params.get("historyConfidence")),
    HISTORY_CONFIDENCE_LEVELS,
    "historyConfidence",
  );
  if ("error" in historyConfidence) return { ...historyConfidence, status: 400 };

  const logins = splitCsvParam(params.get("login"));
  const search = params.get("search") || undefined;

  const requestedEnterpriseSlugs = collectRequestedEnterpriseSlugs(params);
  if (requestedEnterpriseSlugs.length > 0) {
    const configuredSlugs = new Set(getEnterpriseSlugs());
    const unknown = requestedEnterpriseSlugs.filter((slug) => !configuredSlugs.has(slug));
    if (unknown.length > 0) {
      return {
        error: `Unknown enterprise slug(s): ${unknown.join(", ")}. Expected one of the configured enterprises.`,
        status: 400,
      };
    }
  }

  const scope = parseScopeFilter(params);
  // Fail-closed: `scope.allowedLogins` is a `Set` (possibly empty) when a
  // team/org filter was applied; convert to the array shape
  // `LicensePeriodFilterQuery` expects, preserving "undefined = unrestricted"
  // vs "empty array = zero rows" semantics exactly.
  const allowedLogins = scope.allowedLogins ? Array.from(scope.allowedLogins) : undefined;

  const baseFilterQuery: LicensePeriodFilterQuery = {
    enterpriseSlugs: scope.enterpriseSlugs,
    periods,
    allowedLogins,
  };

  const filterQuery: LicensePeriodFilterQuery = {
    ...baseFilterQuery,
    logins,
    planTypes: planTypes.length > 0 ? planTypes : undefined,
    accountStates: accountStates.length > 0 ? accountStates : undefined,
    seatStatuses: seatStatuses.length > 0 ? seatStatuses : undefined,
    historyConfidence: historyConfidence.length > 0 ? historyConfidence : undefined,
    search,
  };

  // One window for every figure on the page. A month selection is authoritative
  // — it must not be silently replaced by the `days` default that
  // `parseDateRangeParams` falls back to when no `days`/`startDate` is sent,
  // which is what previously made the per-user tiles quote a rolling 28-day
  // window while the cost-basis strip quoted the selected calendar month.
  let windowStart = dateRange.start;
  let windowEnd = dateRange.end;
  let periodHint: string | null = null;
  if (explicitPeriods) {
    const sorted = [...periods].sort((a, b) => a.localeCompare(b));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first && last) {
      windowStart = monthBounds(first).startDate;
      windowEnd = monthBounds(last).endDate;
      periodHint = first === last ? first : null;
    }
  }

  return {
    periods,
    windowStart,
    windowEnd,
    periodHint,
    view,
    scope,
    search,
    baseFilterQuery,
    filterQuery,
  };
}

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
    const resolved = resolveReconciliationFilters(params);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const { periods, windowStart, windowEnd, periodHint, view, scope, filterQuery, baseFilterQuery } = resolved;

    const pageResult = parseStrictIntParam(params.get("page"), "page", 1, 1, MAX_PAGE);
    if (typeof pageResult === "object") {
      return NextResponse.json({ error: pageResult.error }, { status: 400 });
    }
    const page = pageResult;

    const pageSizeResult = parseStrictIntParam(params.get("pageSize"), "pageSize", 50, 1, MAX_PAGE_SIZE);
    if (typeof pageSizeResult === "object") {
      return NextResponse.json({ error: pageSizeResult.error }, { status: 400 });
    }
    const pageSize = pageSizeResult;

    const sort = params.get("sort") || "total_cost";
    const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";

    const cfg = getLicensingConfig();

    // Same shared basis the Billing page renders, over the *same* window the
    // per-user rows below are computed from, so every figure on this page
    // describes one period and the two surfaces cannot disagree.
    let costBasis: CopilotCostBasis | null = null;
    try {
      costBasis = getCopilotCostBasis(
        windowStart,
        windowEnd,
        {
          allowedLogins: baseFilterQuery.allowedLogins ? [...baseFilterQuery.allowedLogins] : undefined,
          scopeOrgs: scope.selectedOrgs?.length ? [...scope.selectedOrgs] : undefined,
        },
        scope.enterpriseSlugs ? [...scope.enterpriseSlugs] : undefined,
        periodHint,
      );
    } catch (err) {
      // The reconciliation strip is supplementary — never fail the page over it.
      console.error("Failed to compute Copilot cost basis:", err);
    }

    const earliestMaterialized = getEarliestMaterializedPeriod({
      enterpriseSlugs: baseFilterQuery.enterpriseSlugs,
      allowedLogins: baseFilterQuery.allowedLogins,
    });
    const earliestRecoverable = earliestRecoverablePeriod({
      auditRetentionDays: cfg.history?.auditRetentionDays ?? 0,
      snapshotDates: earliestMaterialized
        ? [`${earliestMaterialized}-01T00:00:00.000Z`]
        : [],
    });

    // Only the base scope (enterprise + period + team/org-resolved
    // allowedLogins) decides whether materialized history exists — narrow
    // filters (search/login/plan/accountState/seatStatus/historyConfidence)
    // must never cause a valid, narrowly-filtered *empty* historical result
    // to be mistaken for "no history materialized yet".
    const materialized = hasMaterializedRows(baseFilterQuery);
    const allKnownSortFields = Array.from(
      new Set<string>([...LEGACY_SORT_FIELDS, ...DETAIL_SORT_COLUMNS, ...ROLLUP_SORT_COLUMNS]),
    );
    if (!allKnownSortFields.includes(sort)) {
      return NextResponse.json(
        { error: `Invalid sort value "${sort}". Expected one of: ${allKnownSortFields.join(", ")}.` },
        { status: 400 },
      );
    }
    if (materialized) {
      const historicalSortFields = view === "rollup" ? ROLLUP_SORT_COLUMNS : DETAIL_SORT_COLUMNS;
      if (!historicalSortFields.includes(sort)) {
        return NextResponse.json(
          { error: `Invalid sort value "${sort}" for ${view} view. Expected one of: ${historicalSortFields.join(", ")}.` },
          { status: 400 },
        );
      }
    }
    const qualitySummary = getLatestLicenseQualitySummary({
      enterpriseSlugs: scope.enterpriseSlugs ?? getEnterpriseSlugs(),
      periods,
      orgLogins: (scope.selectedOrgs?.length ?? 0) > 0 ? scope.selectedOrgs : undefined,
    });
    const qualityWarnings = getQualityWarnings(qualitySummary);

    if (!materialized) {
      // Backward-compatible fallback: no materialized rows for this
      // scope/period base — reuse the exact legacy live query unchanged so
      // existing callers/tests keep working byte-for-byte, and additively
      // mark the response with a `coverage`/`dataSource` indicator.
      const { rows: allRows, coverage: consumptionCoverage } = getLicenseReconciliationDataset({
        start: windowStart,
        end: windowEnd,
        filters: {
          allowedLogins: scope.allowedLogins,
          enterpriseSlugs: scope.enterpriseSlugs,
          scopeOrgs: scope.selectedOrgs?.length ? [...scope.selectedOrgs] : undefined,
          search: resolved.search,
        },
      });

      const MAX_ROWS = 10_000;
      if (allRows.length > MAX_ROWS) {
        return NextResponse.json(
          { error: `Result set too large (${allRows.length} rows). Narrow the scope or reduce the date range.` },
          { status: 400 },
        );
      }

      const kpis = computeLicenseKPIs(allRows, consumptionCoverage);
      const planBreakdown = computePlanBreakdown(allRows);
      const orgBreakdown = computeOrgBreakdown(allRows);
      const utilizationBuckets = computeUtilizationBuckets(allRows);

      const liveSort: LicenseSortField = LEGACY_SORT_FIELDS.includes(sort as LicenseSortField)
        ? (sort as LicenseSortField)
        : "total_cost";
      const sorted = sortLicenseRows(allRows, liveSort, sortDir);
      const offset = (page - 1) * pageSize;
      const rows = sorted.slice(offset, offset + pageSize);

      const materializedPeriods: string[] = [];
      const missingPeriods = [...periods];
      const coverageWarnings = getCoverageWarnings("live_snapshot_only", missingPeriods);
      const warnings = [...coverageWarnings, ...qualityWarnings];
      if (liveSort !== sort) {
        warnings.push(`${sort} sorting requires materialized history; sorting the live snapshot by total cost instead.`);
      }
      if (view === "rollup") {
        warnings.push("rollup view requires materialized history; showing live snapshot detail rows instead.");
      }

      return NextResponse.json(
        {
          enabled: true,
          coverage: {
            mode: "live_snapshot_only",
            periods,
            view: "detail",
            requestedPeriods: periods,
            materializedPeriods,
            missingPeriods,
            earliestRecoverablePeriod: earliestRecoverable,
            warnings: coverageWarnings,
          },
          dataSource: "live_snapshot_only",
          qualitySummary,
          kpis,
          costBasis,
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
          warnings,
        },
        { headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" } },
      );
    }

    // Historical mode: materialized rows exist for the requested base scope
    // (an empty result could still occur once narrow filters are applied —
    // that is expected and not a fallback trigger).
    const paginated: PaginatedLicenseRows =
      view === "rollup"
        ? queryLicensePeriodRows({ ...filterQuery, view: "rollup", page, pageSize, sortField: sort, sortDir })
        : queryLicensePeriodRows({ ...filterQuery, view: "detail", page, pageSize, sortField: sort, sortDir });

    const kpis = toReconciliationKPIs(getMaterializedPeriodKPIs(filterQuery));
    const planBreakdown = getMaterializedPlanBreakdown(filterQuery);
    const orgBreakdown = getMaterializedOrgBreakdown(filterQuery);
    const materializedSet = new Set(getMaterializedPeriods(baseFilterQuery));
    const materializedPeriods = periods.filter((period) => materializedSet.has(period));
    const missingPeriods = periods.filter((period) => !materializedSet.has(period));
    const coverageWarnings = getCoverageWarnings("historical", missingPeriods);
    const utilizationBuckets = getMaterializedUtilizationBuckets(filterQuery);

    return NextResponse.json(
      {
        enabled: true,
        coverage: {
          mode: "historical",
          periods,
          view,
          requestedPeriods: periods,
          materializedPeriods,
          missingPeriods,
          earliestRecoverablePeriod: earliestRecoverable,
          warnings: coverageWarnings,
        },
        dataSource: "historical",
        qualitySummary,
        kpis,
        costBasis,
        rows: paginated.rows,
        planBreakdown,
        orgBreakdown,
        utilizationBuckets,
        config: { currency: cfg.currency, creditToUsd: cfg.creditToUsd },
        pagination: paginated.pagination,
        warnings: [...coverageWarnings, ...qualityWarnings],
      },
      { headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" } },
    );
  } catch (err) {
    if (err instanceof LicensingConfigError) {
      // Misconfigured licensing settings are an operator/config problem, not
      // a server fault — surface a stable, typed 422 with the specific
      // validation details (never the raw error/stack) so operators can fix
      // dashboard-config.json without any sensitive info leaking.
      return NextResponse.json(
        { error: "invalid_licensing_config", details: err.details },
        { status: 422 },
      );
    }
    console.error("License reconciliation error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
