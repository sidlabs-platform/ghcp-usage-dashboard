import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getLicensingConfig, LicensingConfigError } from "@/lib/config/dashboard-config";
import { getLicenseReconciliationRows } from "@/lib/db/license-repo";
import {
  queryLicensePeriodExport,
  hasMaterializedRows,
  type LicensePeriodRowRecord,
  type LicenseRollupRowRecord,
} from "@/lib/db/license-history-repo";
import { escapeCSVValue } from "@/lib/export/csv";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import type { LicenseReconciliationRow } from "@/lib/types/licensing";
import { resolveReconciliationFilters } from "../../billing/license-reconciliation/route";

// Bounds how many rows this endpoint will ever materialize/emit in one
// response — independent of (and stricter than any single page of) the JSON
// API's own page-size cap. Kept modest so a single bounded, all-at-once CSV
// build can never OOM the server; if the true row count exceeds this, the
// request is rejected before any row is fetched or any CSV text is built.
// Mirrors `EXPORT_MAX_ROWS` in `license-history-repo.ts` (the repository's
// own hard cap); passed through explicitly so this route's contract stays
// self-documenting even though it currently matches the repo default.
const EXPORT_MAX_ROWS = 5000;
// Mirrors the legacy live-fallback guard already used by the JSON
// reconciliation route (`route.ts`), so both endpoints reject an
// unreasonably large live snapshot at the same threshold.
const LEGACY_MAX_ROWS = 10_000;

const NO_STORE_HEADERS = { "Cache-Control": "private, no-cache, no-store, max-age=0" };

function computeOverBudget(consumedUsd: number, assignedUsd: number): boolean {
  return consumedUsd > assignedUsd;
}

interface CsvColumnDef<T> {
  label: string;
  value: (row: T) => unknown;
}

interface DetailCsvRecord extends LicensePeriodRowRecord {
  userStatus: string;
  loginRecoverySource: string;
}

function mapHistoricalRowToDetailRecord(row: LicensePeriodRowRecord): DetailCsvRecord {
  return {
    ...row,
    userStatus: row.seatStatus === "active" ? "active" : "inactive",
    loginRecoverySource: row.identityResolutionSource,
  };
}

/**
 * Exact, deterministic detail-view column order (also reused for the legacy
 * live-snapshot fallback — see {@link mapLegacyRowToDetailRecord}).
 * The approved contract columns must remain first; dashboard-only enrichment
 * follows them.
 */
const DETAIL_COLUMNS: CsvColumnDef<DetailCsvRecord>[] = [
  { label: "user_login", value: (r) => r.userLogin },
  { label: "license_assigned_date", value: (r) => r.licenseAssignedDate },
  { label: "gh_copilot_license_cost", value: (r) => r.licenseCost },
  { label: "default_aic_user_level", value: (r) => r.defaultAicCredits },
  { label: "aic_billing_dollar_assigned", value: (r) => r.aicAssignedUsd },
  { label: "aic_consumed", value: (r) => r.aicConsumedCredits },
  { label: "user_status", value: (r) => r.userStatus },
  { label: "user_revoked_date", value: (r) => r.userRevokedDate },
  { label: "org_login", value: (r) => r.orgLogin },
  { label: "plan_type", value: (r) => r.planType },
  { label: "seat_status", value: (r) => r.seatStatus },
  { label: "assigned_via", value: (r) => r.assignedVia },
  { label: "last_activity_at", value: (r) => r.lastActivityAt },
  { label: "external_identity", value: (r) => r.externalIdentity },
  { label: "github_user_id", value: (r) => r.githubUserId },
  { label: "resolved_user_login", value: (r) => r.resolvedUserLogin },
  { label: "identity_resolution_source", value: (r) => r.identityResolutionSource },
  { label: "account_state", value: (r) => r.accountState },
  { label: "aic_assigned_rule_used", value: (r) => r.aicAssignedRule },
  { label: "default_aic_usd", value: (r) => r.defaultAicUsd },
  { label: "aic_consumed_usd", value: (r) => r.aicConsumedUsd },
  { label: "currency", value: (r) => r.currency },
  { label: "billing_period", value: (r) => r.billingPeriod },
  { label: "row_source", value: (r) => r.rowSource },
  { label: "login_recovery_source", value: (r) => r.loginRecoverySource },
  { label: "history_confidence", value: (r) => r.historyConfidence },
  { label: "as_of_utc", value: (r) => r.asOfUtc },
  { label: "data_quality_notes", value: (r) => r.dataQualityNotes.map(String).join(",") },
  { label: "data_generated_at_utc", value: (r) => r.generatedAtUtc },
  { label: "enterprise", value: (r) => r.enterpriseSlug },
  { label: "holder_key", value: (r) => r.holderKey },
  { label: "consumption_source", value: (r) => r.consumptionSource },
  { label: "over_budget", value: (r) => computeOverBudget(r.aicConsumedUsd, r.aicAssignedUsd) },
  { label: "total_cost", value: (r) => r.licenseCost + r.aicConsumedUsd },
];

/** Exact, deterministic rollup-view column order — an aggregated grain, so per-row assignment/revocation dates and identity-resolution source do not apply. */
const ROLLUP_COLUMNS: CsvColumnDef<LicenseRollupRowRecord>[] = [
  { label: "Enterprise", value: (r) => r.enterpriseSlug },
  { label: "Periods", value: (r) => r.periods.join(";") },
  { label: "Orgs", value: (r) => r.orgLogins.join(";") },
  { label: "Login", value: (r) => r.resolvedUserLogin },
  { label: "Plan Types", value: (r) => r.planTypes.join(";") },
  { label: "Seat Count", value: (r) => r.seatCount },
  { label: "Org Count", value: (r) => r.orgCount },
  { label: "Period Count", value: (r) => r.periodCount },
  { label: "History Confidence", value: (r) => r.historyConfidence },
  { label: "Default AIC Credits", value: (r) => r.defaultAicCredits },
  { label: "AIC Assigned USD", value: (r) => r.aicAssignedUsd },
  { label: "AIC Consumed Credits", value: (r) => r.aicConsumedCredits },
  { label: "AIC Consumed USD", value: (r) => r.aicConsumedUsd },
  { label: "Utilization %", value: (r) => r.utilizationPct },
  { label: "Over Budget", value: (r) => computeOverBudget(r.aicConsumedUsd, r.aicAssignedUsd) },
  { label: "License Cost", value: (r) => r.licenseCost },
  { label: "Currency", value: (r) => r.currency },
];

/**
 * Adapt a legacy live-snapshot row (from `getLicenseReconciliationRows`,
 * which has no per-row enterprise/period/holder-key concept) onto the same
 * shape `DETAIL_COLUMNS` reads, so the live-fallback CSV export path reuses
 * the exact same column list/order as the historical path rather than
 * duplicating a second set of column definitions. Fields the legacy dataset
 * genuinely does not track render empty;
 * `rowSource`/`historyConfidence` are set to `"live_snapshot_only"`, an
 * existing, real `SeatLedgerConfidence` value — the same marker the JSON
 * route uses for this fallback mode.
 */
function mapLegacyRowToDetailRecord(
  row: LicenseReconciliationRow,
  enterpriseSlugs: string[] | undefined,
  currency: string,
  nowIso: string,
): DetailCsvRecord {
  return {
    enterpriseSlug: enterpriseSlugs?.join(";") ?? "",
    billingPeriod: "live",
    orgLogin: row.orgs.join(";"),
    holderKey: row.user_login,
    githubUserId: null,
    userLogin: row.user_login,
    resolvedUserLogin: row.user_login,
    externalIdentity: null,
    identityResolutionSource: "live_snapshot_only",
    accountState: "",
    licenseAssignedDate: row.license_assigned_date ?? null,
    userRevokedDate: row.user_revoked_date ?? null,
    planType: row.plan_type,
    seatStatus: row.seat_status,
    assignedVia: row.assigned_via,
    lastActivityAt: row.last_activity_at ?? null,
    licenseCost: row.license_cost ?? 0,
    defaultAicCredits: row.default_aic_credits ?? 0,
    defaultAicUsd: row.default_aic_usd ?? 0,
    aicAssignedUsd: row.aic_assigned_usd ?? 0,
    aicAssignedRule: row.aic_assigned_rule ?? "plan_default",
    aicConsumedCredits: row.aic_consumed_credits ?? 0,
    aicConsumedUsd: row.aic_consumed_usd ?? 0,
    currency,
    rowSource: "live_snapshot_only",
    consumptionSource: "",
    historyConfidence: "live_snapshot_only",
    dataQualityNotes: [],
    asOfUtc: nowIso,
    generatedAtUtc: nowIso,
    userStatus: row.user_status,
    loginRecoverySource: "live_snapshot_only",
  };
}

function renderCsvLine<T>(row: T, columns: CsvColumnDef<T>[]): string {
  return columns.map((col) => escapeCSVValue(col.value(row))).join(",");
}

function buildCsv<T>(rows: T[], columns: CsvColumnDef<T>[], metadataLines: string[]): string {
  const lines = [...metadataLines, columns.map((c) => escapeCSVValue(c.label)).join(",")];
  for (const row of rows) {
    lines.push(renderCsvLine(row, columns));
  }
  // CRLF row separator per RFC4180 (distinct from the shared `arrayToCSV`
  // helper in `@/lib/export/csv`, which stays LF-separated for its other,
  // out-of-scope consumers).
  return lines.join("\r\n");
}

function buildMetadataLines(periodsLabel: string, view: string): string[] {
  return [
    `Report,${escapeCSVValue("License Reconciliation")}`,
    `Period,${escapeCSVValue(periodsLabel)}`,
    `View,${escapeCSVValue(view)}`,
    `Exported At,${escapeCSVValue(new Date().toISOString())}`,
    "",
  ];
}

function csvResponse(csv: string, filenameBase: string): NextResponse {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameBase}.csv"`,
      ...NO_STORE_HEADERS,
    },
  });
}

async function handler(request: NextRequest) {
  try {
    if (
      !isBillingSubEnabledForAnyEnterprise("aiCredits") &&
      !isBillingSubEnabledForAnyEnterprise("premiumRequests")
    ) {
      return NextResponse.json(
        { error: "License reconciliation export is not enabled." },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    const params = request.nextUrl.searchParams;
    const resolved = resolveReconciliationFilters(params);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status, headers: NO_STORE_HEADERS });
    }
    const { periods, view, scope, filterQuery, baseFilterQuery } = resolved;
    const cfg = getLicensingConfig();
    const periodsLabel = periods.length > 0 ? periods.join(";") : "live";
    const filenameBase = `license-reconciliation-${periodsLabel.replace(/[^a-z0-9;.-]/gi, "_")}-${view}`;

    const materialized = hasMaterializedRows(baseFilterQuery);

    if (!materialized) {
      // Same backward-compatible fallback as the JSON route: no
      // materialized history for this scope/period base — export the exact
      // legacy live-snapshot dataset (unpaginated, bounded by licensed user
      // count) mapped onto the shared detail column layout.
      const allRows = getLicenseReconciliationRows({
        start: resolved.windowStart,
        end: resolved.windowEnd,
        filters: {
          allowedLogins: scope.allowedLogins,
          enterpriseSlugs: scope.enterpriseSlugs,
          scopeOrgs: scope.selectedOrgs?.length ? [...scope.selectedOrgs] : undefined,
          search: resolved.search,
        },
      });

      if (allRows.length > LEGACY_MAX_ROWS) {
        return NextResponse.json(
          { error: `Result set too large (${allRows.length} rows). Narrow the scope or reduce the date range.` },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }

      const nowIso = new Date().toISOString();
      const detailRows = allRows.map((row) =>
        mapLegacyRowToDetailRecord(row, scope.enterpriseSlugs, cfg.currency, nowIso),
      );
      const csv = buildCsv(detailRows, DETAIL_COLUMNS, buildMetadataLines(periodsLabel, "detail"));
      return csvResponse(csv, filenameBase);
    }

    // Historical mode: branch on the requested (literal) view *before*
    // querying, so each call site matches a single `queryLicensePeriodRows`
    // overload exactly and gets a precisely-typed result — no post-call
    // narrowing/casting is needed to pick the matching column set. Calls the
    // bounded, transaction-consistent export repository function exactly
    // once per request — no N-page loop here or in the repository.
    if (view === "rollup") {
      const result = queryLicensePeriodExport({
        ...filterQuery,
        view: "rollup",
        maxRows: EXPORT_MAX_ROWS,
      });
      if (result.tooLarge) {
        return NextResponse.json(
          { error: `Result set too large (${result.totalItems} rows). Narrow the scope, periods, or filters before exporting.` },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }
      const csv = buildCsv(result.rows, ROLLUP_COLUMNS, buildMetadataLines(periodsLabel, "rollup"));
      return csvResponse(csv, filenameBase);
    }

    const result = queryLicensePeriodExport({
      ...filterQuery,
      view: "detail",
      maxRows: EXPORT_MAX_ROWS,
    });
    if (result.tooLarge) {
      return NextResponse.json(
        { error: `Result set too large (${result.totalItems} rows). Narrow the scope, periods, or filters before exporting.` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const detailRows = result.rows.map(mapHistoricalRowToDetailRecord);
    const csv = buildCsv(detailRows, DETAIL_COLUMNS, buildMetadataLines(periodsLabel, "detail"));
    return csvResponse(csv, filenameBase);
  } catch (err) {
    if (err instanceof LicensingConfigError) {
      return NextResponse.json(
        { error: "invalid_licensing_config", details: err.details },
        { status: 422, headers: NO_STORE_HEADERS },
      );
    }
    console.error("License reconciliation CSV export error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export const GET = withRateLimit(withTimeout(handler));
