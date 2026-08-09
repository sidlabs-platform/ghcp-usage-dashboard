import { NextRequest, NextResponse } from "next/server";
import { isBillingSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { getLicensingConfig, LicensingConfigError } from "@/lib/config/dashboard-config";
import { getLicenseReconciliationRows } from "@/lib/db/license-repo";
import {
  queryLicensePeriodRows,
  hasMaterializedRows,
  type LicensePeriodRowRecord,
  type LicenseRollupRowRecord,
} from "@/lib/db/license-history-repo";
import { escapeCSVValue } from "@/lib/export/csv";
import { withTimeout } from "@/lib/api/timeout";
import { resolveReconciliationFilters } from "../../billing/license-reconciliation/route";

// Bounds how many rows this endpoint will ever materialize/emit in one
// response — independent of (and stricter than any single page of) the JSON
// API's own page-size cap. Kept modest so a single bounded, all-at-once CSV
// build can never OOM the server; if the true row count exceeds this, the
// request is rejected before any row is fetched or any CSV text is built.
const EXPORT_MAX_ROWS = 5000;
// Same value as `MAX_PAGE_SIZE` in license-history-repo.ts — that cap is
// internal to the repo (not exported), so the largest page this route can
// ever request per call is 200; looping is required to gather more than one
// page, entirely server-side (never a client-side N-request loop).
const REPO_PAGE_SIZE = 200;
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

/**
 * Exact, deterministic detail-view column order (also reused for the legacy
 * live-snapshot fallback — see {@link mapLegacyRowToDetailRecord}).
 * `externalIdentity` and `dataQualityNotes` (free-form, not guaranteed safe)
 * are deliberately never included.
 */
const DETAIL_COLUMNS: CsvColumnDef<LicensePeriodRowRecord>[] = [
  { label: "Enterprise", value: (r) => r.enterpriseSlug },
  { label: "Period", value: (r) => r.billingPeriod },
  { label: "Org", value: (r) => r.orgLogin },
  { label: "Login", value: (r) => r.resolvedUserLogin ?? r.userLogin ?? "" },
  { label: "Holder Key", value: (r) => r.holderKey },
  { label: "Plan Type", value: (r) => r.planType },
  { label: "Account State", value: (r) => r.accountState },
  { label: "Seat Status", value: (r) => r.seatStatus },
  { label: "Assigned Via", value: (r) => r.assignedVia },
  { label: "License Assigned Date", value: (r) => r.licenseAssignedDate },
  { label: "User Revoked Date", value: (r) => r.userRevokedDate },
  { label: "Row Source", value: (r) => r.rowSource },
  { label: "Consumption Source", value: (r) => r.consumptionSource },
  { label: "History Confidence", value: (r) => r.historyConfidence },
  { label: "Default AIC Credits", value: (r) => r.defaultAicCredits },
  { label: "AIC Assigned USD", value: (r) => r.aicAssignedUsd },
  { label: "AIC Consumed Credits", value: (r) => r.aicConsumedCredits },
  { label: "AIC Consumed USD", value: (r) => r.aicConsumedUsd },
  { label: "Over Budget", value: (r) => computeOverBudget(r.aicConsumedUsd, r.aicAssignedUsd) },
  { label: "License Cost", value: (r) => r.licenseCost },
  { label: "Currency", value: (r) => r.currency },
  { label: "As Of (UTC)", value: (r) => r.asOfUtc },
  { label: "Generated At (UTC)", value: (r) => r.generatedAtUtc },
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LegacyReconciliationRow = any;

/**
 * Adapt a legacy live-snapshot row (from `getLicenseReconciliationRows`,
 * which has no per-row enterprise/period/holder-key concept) onto the same
 * shape `DETAIL_COLUMNS` reads, so the live-fallback CSV export path reuses
 * the exact same column list/order as the historical path rather than
 * duplicating a second set of column definitions. Fields the legacy dataset
 * genuinely does not track (accountState, consumptionSource) render empty;
 * `rowSource`/`historyConfidence` are set to `"live_snapshot_only"`, an
 * existing, real `SeatLedgerConfidence` value — the same marker the JSON
 * route uses for this fallback mode.
 */
function mapLegacyRowToDetailRecord(
  row: LegacyReconciliationRow,
  enterpriseSlugs: string[] | undefined,
  currency: string,
  nowIso: string,
): LicensePeriodRowRecord {
  return {
    enterpriseSlug: enterpriseSlugs?.join(";") ?? "",
    billingPeriod: "live",
    orgLogin: Array.isArray(row.orgs) ? row.orgs.join(";") : "",
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
  return lines.join("\n");
}

/**
 * Gather every row across as many repository pages as needed (the repo caps
 * a single page at {@link REPO_PAGE_SIZE}), stopping — without fetching any
 * further page — the moment the true total exceeds {@link EXPORT_MAX_ROWS}.
 * This is the only place pages are looped; callers (the route handler, and
 * ultimately `useExport.ts`) never issue more than one HTTP request.
 */
function collectAllRows<TRow>(
  fetchPage: (page: number) => { rows: TRow[]; pagination: { totalItems: number; totalPages: number } },
): { tooLarge: true; totalItems: number } | { tooLarge: false; rows: TRow[]; totalItems: number } {
  const first = fetchPage(1);
  const totalItems = first.pagination.totalItems;
  if (totalItems > EXPORT_MAX_ROWS) {
    return { tooLarge: true, totalItems };
  }
  let rows = [...first.rows];
  for (let page = 2; page <= first.pagination.totalPages; page += 1) {
    rows = rows.concat(fetchPage(page).rows);
  }
  return { tooLarge: false, rows, totalItems };
}

function buildMetadataLines(periodsLabel: string, view: string): string[] {
  return [
    `Report,${escapeCSVValue("License Reconciliation")}`,
    `Period,${escapeCSVValue(periodsLabel)}`,
    `View,${escapeCSVValue(view)}`,
    `Exported At,${escapeCSVValue(new Date().toLocaleString())}`,
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
        start: resolved.legacyStart,
        end: resolved.legacyEnd,
        filters: {
          allowedLogins: scope.allowedLogins,
          enterpriseSlugs: scope.enterpriseSlugs,
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
    // narrowing/casting is needed to pick the matching column set.
    if (view === "rollup") {
      const result = collectAllRows((page) =>
        queryLicensePeriodRows({ ...filterQuery, view: "rollup", page, pageSize: REPO_PAGE_SIZE }),
      );
      if (result.tooLarge) {
        return NextResponse.json(
          { error: `Result set too large (${result.totalItems} rows). Narrow the scope, periods, or filters before exporting.` },
          { status: 400, headers: NO_STORE_HEADERS },
        );
      }
      const csv = buildCsv(result.rows, ROLLUP_COLUMNS, buildMetadataLines(periodsLabel, "rollup"));
      return csvResponse(csv, filenameBase);
    }

    const result = collectAllRows((page) =>
      queryLicensePeriodRows({ ...filterQuery, view: "detail", page, pageSize: REPO_PAGE_SIZE }),
    );
    if (result.tooLarge) {
      return NextResponse.json(
        { error: `Result set too large (${result.totalItems} rows). Narrow the scope, periods, or filters before exporting.` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    const csv = buildCsv(result.rows, DETAIL_COLUMNS, buildMetadataLines(periodsLabel, "detail"));
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

export const GET = withTimeout(handler);
