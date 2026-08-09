"use client";

// Server-paginated reconciliation rows table shared by the historical
// (materialized) "detail"/"rollup" views and the legacy live-snapshot
// fallback. All filtering/sorting/pagination is driven by the parent page —
// this component only renders the current page and reports sort/page
// intent back up via callbacks (no client-side re-sorting/re-paging).

import type { ReactNode } from "react";
import type { LicensePeriodRowRecord, LicenseRollupRowRecord } from "@/lib/db/license-history-repo";
import type { LicenseReconciliationRow } from "@/lib/types/licensing";

export interface TablePagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface BaseProps {
  currency: string;
  sort: string;
  sortDir: "asc" | "desc";
  onSort: (field: string) => void;
  pagination: TablePagination;
  onPageChange: (page: number) => void;
}

type DetailProps = BaseProps & { view: "detail"; rows: LicensePeriodRowRecord[] };
type RollupProps = BaseProps & { view: "rollup"; rows: LicenseRollupRowRecord[] };
type LegacyProps = BaseProps & { view: "legacy"; rows: LicenseReconciliationRow[] };

export type LicenseReconciliationTableProps = DetailProps | RollupProps | LegacyProps;

interface ColumnDef<Row> {
  key: string;
  label: string;
  sortField?: string;
  align?: "left" | "right";
  render: (row: Row) => ReactNode;
}

function formatUsd(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function identityCell(resolvedUserLogin: string | null, userLogin: string | null, holderKey: string): ReactNode {
  const login = resolvedUserLogin ?? userLogin;
  if (login) return login;
  return (
    <span>
      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        Unresolved
      </span>{" "}
      <span className="text-xs text-[hsl(var(--muted-foreground))]" title="Stable holder key (no external identity)">
        {holderKey}
      </span>
    </span>
  );
}

const DETAIL_COLUMNS: ColumnDef<LicensePeriodRowRecord>[] = [
  { key: "period", label: "Period", sortField: "billing_period", render: (r) => r.billingPeriod },
  {
    key: "identity",
    label: "User",
    sortField: "resolved_user_login",
    render: (r) => identityCell(r.resolvedUserLogin, r.userLogin, r.holderKey),
  },
  { key: "org", label: "Org", sortField: "org_login", render: (r) => r.orgLogin },
  { key: "plan", label: "Plan", sortField: "plan_type", render: (r) => r.planType },
  { key: "accountState", label: "Account state", sortField: "account_state", render: (r) => r.accountState },
  { key: "seatStatus", label: "Seat status", sortField: "seat_status", render: (r) => r.seatStatus },
  {
    key: "assignedRevoked",
    label: "Assigned / revoked",
    render: (r) => `${r.licenseAssignedDate ?? "—"} / ${r.userRevokedDate ?? "—"}`,
  },
  { key: "assignedVia", label: "Assigned via", render: (r) => r.assignedVia },
  {
    key: "identitySource",
    label: "Identity source",
    render: (r) => r.identityResolutionSource,
  },
  {
    key: "historyConfidence",
    label: "History confidence",
    sortField: "history_confidence",
    render: (r) => r.historyConfidence,
  },
  {
    key: "consumptionSource",
    label: "Consumption source",
    render: (r) => r.consumptionSource ?? "—",
  },
  {
    key: "licenseCost",
    label: "License cost",
    sortField: "license_cost",
    align: "right",
    render: (r) => formatUsd(r.licenseCost, r.currency),
  },
  {
    key: "allowance",
    label: "Allowance",
    sortField: "aic_assigned_usd",
    align: "right",
    render: (r) => formatUsd(r.aicAssignedUsd, r.currency),
  },
  {
    key: "consumed",
    label: "Consumed",
    sortField: "aic_consumed_usd",
    align: "right",
    render: (r) => `${r.aicConsumedCredits.toLocaleString()} cr / ${formatUsd(r.aicConsumedUsd, r.currency)}`,
  },
  {
    key: "utilization",
    label: "Utilization",
    align: "right",
    render: (r) => (r.aicAssignedUsd > 0 ? `${Math.round((r.aicConsumedUsd / r.aicAssignedUsd) * 100)}%` : "—"),
  },
  {
    key: "overage",
    label: "Overage",
    align: "right",
    render: (r) => (r.aicConsumedUsd > r.aicAssignedUsd ? formatUsd(r.aicConsumedUsd - r.aicAssignedUsd, r.currency) : "—"),
  },
  {
    key: "totalCost",
    label: "Total cost",
    sortField: "total_cost",
    align: "right",
    render: (r) => `${formatUsd(r.licenseCost + r.aicConsumedUsd, r.currency)} ${r.currency}`,
  },
];

const ROLLUP_COLUMNS: ColumnDef<LicenseRollupRowRecord>[] = [
  { key: "user", label: "User", sortField: "resolved_user_login", render: (r) => r.resolvedUserLogin },
  { key: "orgCount", label: "Org count", sortField: "org_count", align: "right", render: (r) => String(r.orgCount) },
  {
    key: "periodRange",
    label: "Period range",
    render: (r) => {
      const sorted = [...r.periods].sort();
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return first === last ? first : `${first} – ${last}`;
    },
  },
  { key: "seatCount", label: "Seats", sortField: "seat_count", align: "right", render: (r) => String(r.seatCount) },
  { key: "planTypes", label: "Plans", render: (r) => r.planTypes.join(", ") },
  {
    key: "historyConfidence",
    label: "History confidence (worst)",
    render: (r) => r.historyConfidence,
  },
  {
    key: "licenseCost",
    label: "License cost",
    sortField: "license_cost",
    align: "right",
    render: (r) => formatUsd(r.licenseCost, r.currency),
  },
  {
    key: "consumed",
    label: "Consumed",
    sortField: "aic_consumed_usd",
    align: "right",
    render: (r) => `${r.aicConsumedCredits.toLocaleString()} cr / ${formatUsd(r.aicConsumedUsd, r.currency)}`,
  },
  {
    key: "utilization",
    label: "Utilization",
    sortField: "utilization_pct",
    align: "right",
    render: (r) => `${Math.round(r.utilizationPct)}%`,
  },
  {
    key: "totalCost",
    label: "Total cost",
    sortField: "total_cost",
    align: "right",
    render: (r) => formatUsd(r.licenseCost + r.aicConsumedUsd, r.currency),
  },
];

const LEGACY_COLUMNS: ColumnDef<LicenseReconciliationRow>[] = [
  { key: "user", label: "User", sortField: "user_login", render: (r) => r.user_login },
  { key: "orgs", label: "Orgs", render: (r) => r.orgs.join(", ") },
  { key: "plan", label: "Plan", render: (r) => r.plan_type },
  { key: "seatStatus", label: "Seat status", render: (r) => r.seat_status },
  {
    key: "licenseCost",
    label: "License cost",
    align: "right",
    render: (r) => formatUsd(r.license_cost, "USD"),
  },
  {
    key: "consumed",
    label: "Consumed",
    align: "right",
    render: (r) => `${r.aic_consumed_credits.toLocaleString()} cr / ${formatUsd(r.aic_consumed_usd, "USD")}`,
  },
  {
    key: "utilization",
    label: "Utilization",
    align: "right",
    render: (r) => `${Math.round(r.utilization_pct)}%`,
  },
  {
    key: "totalCost",
    label: "Total cost",
    align: "right",
    render: (r) => formatUsd(r.total_cost, "USD"),
  },
];

function rowKeyFor(props: LicenseReconciliationTableProps, index: number): string {
  if (props.view === "detail") {
    const r = props.rows[index];
    return `${r.enterpriseSlug}:${r.billingPeriod}:${r.orgLogin}:${r.holderKey}`;
  }
  if (props.view === "rollup") {
    const r = props.rows[index];
    return `${r.enterpriseSlug}:${r.resolvedUserLogin}:${r.orgLogins.join(",")}`;
  }
  const r = props.rows[index];
  return `${r.user_login}:${r.orgs.join(",")}`;
}

function ariaSortFor(field: string | undefined, sort: string, sortDir: "asc" | "desc"): "ascending" | "descending" | "none" {
  if (!field || field !== sort) return "none";
  return sortDir === "asc" ? "ascending" : "descending";
}

export function LicenseReconciliationTable(props: LicenseReconciliationTableProps) {
  const { pagination, onPageChange, sort, sortDir, onSort } = props;
  const columns: ColumnDef<never>[] =
    props.view === "detail"
      ? (DETAIL_COLUMNS as ColumnDef<never>[])
      : props.view === "rollup"
        ? (ROLLUP_COLUMNS as ColumnDef<never>[])
        : (LEGACY_COLUMNS as ColumnDef<never>[]);

  const rows = props.rows as unknown[];

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-[hsl(var(--muted))]/40">
              {columns.map((col, colIdx) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSortFor(col.sortField, sort, sortDir)}
                  className={`whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${colIdx === 0 ? "sticky left-0 z-10 bg-[hsl(var(--background))]" : ""}`}
                >
                  {col.sortField ? (
                    <button type="button" onClick={() => onSort(col.sortField as string)} className="hover:underline">
                      {col.label}
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
                  No matching rows for the current filters and period selection.
                </td>
              </tr>
            ) : (
              rows.map((row, idx) => (
                <tr key={rowKeyFor(props, idx)} className="border-b last:border-0 hover:bg-[hsl(var(--accent))]/40">
                  {columns.map((col, colIdx) => (
                    <td
                      key={col.key}
                      className={`whitespace-nowrap px-3 py-2 tabular-nums ${col.align === "right" ? "text-right" : "text-left"} ${
                        colIdx === 0 ? "sticky left-0 z-10 bg-[hsl(var(--background))]" : ""
                      }`}
                    >
                      {col.render(row as never)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[hsl(var(--muted-foreground))]">
        <span>
          Page {pagination.page} of {Math.max(pagination.totalPages, 1)} · {pagination.totalItems.toLocaleString()} rows
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={pagination.page <= 1}
            onClick={() => onPageChange(pagination.page - 1)}
            className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPageChange(pagination.page + 1)}
            className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
