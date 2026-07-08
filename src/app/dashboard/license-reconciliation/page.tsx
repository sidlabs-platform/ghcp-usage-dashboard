"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { safeNum } from "@/lib/utils";
import {
  CreditCard,
  Users,
  Wallet,
  Zap,
  Gauge,
  AlertTriangle,
  Search,
  Building2,
  BadgeCheck,
} from "lucide-react";
import type {
  LicenseReconciliationRow,
  LicenseReconciliationKPIs,
  LicenseGroupBreakdown,
  UtilizationBucket,
} from "@/lib/types/licensing";

interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

const PAGE_SIZE = 50;

interface SortHeaderProps {
  col: string;
  label: string;
  align?: "left" | "right";
  sort: string;
  sortDir: "asc" | "desc";
  onSort: (col: string) => void;
}

function SortHeader({ col, label, align = "left", sort, sortDir, onSort }: SortHeaderProps) {
  const isSorted = sort === col;
  const alignClass = align === "right" ? "text-right" : "text-left";

  return (
    <th
      className={`px-3 py-3 ${alignClass} text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider cursor-pointer hover:text-[hsl(var(--foreground))] select-none`}
      aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span
        className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}
        onClick={() => onSort(col)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSort(col);
          }
        }}
        tabIndex={0}
        role="button"
      >
        {label}
        {isSorted && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );
}

export default function LicenseReconciliationPage() {
  const { days } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs } = useScope();

  const [kpis, setKpis] = useState<LicenseReconciliationKPIs | null>(null);
  const [rows, setRows] = useState<LicenseReconciliationRow[]>([]);
  const [planBreakdown, setPlanBreakdown] = useState<LicenseGroupBreakdown[]>([]);
  const [orgBreakdown, setOrgBreakdown] = useState<LicenseGroupBreakdown[]>([]);
  const [utilizationBuckets, setUtilizationBuckets] = useState<UtilizationBucket[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 });
  const [currency, setCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState("total_cost");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const fmtMoney = useCallback(
    (v: number) => {
      const n = safeNum(v);
      const sign = n < 0 ? "-" : "";
      const abs = Math.abs(n);
      const body =
        abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(1)}M`
          : abs >= 1_000 ? `${(abs / 1_000).toFixed(1)}K`
          : abs.toFixed(2);
      return `${sign}${currency === "USD" ? "$" : ""}${body}`;
    },
    [currency],
  );

  const fmtNum = (v: number) => safeNum(v).toLocaleString(undefined, { maximumFractionDigits: 0 });

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    p.set("days", String(days));
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", sort);
    p.set("sortDir", sortDir);
    if (search) p.set("search", search);
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => p.set(k, v));
    return p;
  }, [days, page, sort, sortDir, search, buildScopeParams]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/license-reconciliation?${buildParams().toString()}`);
      if (!res.ok) {
        setError("Failed to load reconciliation data");
        return;
      }
      const data = await res.json();
      if (data.enabled === false) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      setKpis(data.kpis || null);
      setRows(data.rows || []);
      setPlanBreakdown(data.planBreakdown || []);
      setOrgBreakdown(data.orgBreakdown || []);
      setUtilizationBuckets(data.utilizationBuckets || []);
      setPagination(data.pagination || { page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 });
      if (data.config?.currency) setCurrency(data.config.currency);
    } catch (err) {
      console.error("Failed to load license reconciliation:", err);
      setError("Failed to load reconciliation data");
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setPage(1); }, [search, sort, sortDir, days, hasFilter, selectedEntTeams, selectedOrgTeams, selectedOrgs]);

  const handleSort = (col: string) => {
    if (sort === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(col); setSortDir("desc"); }
  };

  const csvColumns = useMemo(
    () => [
      { key: "user_login", label: "User Login" },
      { key: "orgs", label: "Organizations" },
      { key: "plan_type", label: "Plan" },
      { key: "license_assigned_date", label: "License Assigned" },
      { key: "user_status", label: "User Status" },
      { key: "seat_status", label: "Seat Status" },
      { key: "user_revoked_date", label: "Revoked Date" },
      { key: "assigned_via", label: "Assigned Via" },
      { key: "last_activity_at", label: "Last Activity" },
      { key: "activity_status", label: "Activity Status" },
      { key: "license_cost", label: `License Cost (${currency})` },
      { key: "default_aic_credits", label: "AIC Allowance (credits)" },
      { key: "aic_assigned_usd", label: `AIC Assigned (${currency})` },
      { key: "aic_assigned_rule", label: "AIC Assigned Rule" },
      { key: "aic_consumed_credits", label: "AIC Consumed (credits)" },
      { key: "aic_consumed_usd", label: `AIC Consumed (${currency})` },
      { key: "utilization_pct", label: "Utilization %" },
      { key: "over_budget", label: "Over Budget" },
      { key: "total_cost", label: `Total Cost (${currency})` },
    ],
    [currency],
  );

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="License & AI Credits" description="Per-user Copilot license + AI-credit reconciliation" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <AlertTriangle className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="License & AI Credits" description="Per-user Copilot license + AI-credit reconciliation" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <CreditCard className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">
            Enable billing (AI Credits) in{" "}
            <code className="text-xs bg-[hsl(var(--accent))] px-1 py-0.5 rounded">dashboard-config.json</code>.
          </p>
        </div>
      </div>
    );
  }

  if (loading && !kpis) {
    return (
      <div className="space-y-6">
        <PageHeader title="License & AI Credits" description="Per-user Copilot license + AI-credit reconciliation" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const hasData = !!kpis && kpis.totalUsers > 0;
  const maxPlanCredits = Math.max(1, ...planBreakdown.map((p) => Math.max(p.allowanceCredits, p.consumedCredits)));
  const maxBucket = Math.max(1, ...utilizationBuckets.map((b) => b.count));

  const planColor: Record<string, string> = {
    enterprise: "#8b5cf6",
    business: "#3b82f6",
    unknown: "#94a3b8",
  };

  const exportMeta = {
    reportName: "License & AI Credits Reconciliation",
    dateRange: `Last ${days} days`,
    ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: selectedOrgs.join(", ") }),
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title="License & AI Credits"
        description="Per-user Copilot license lifecycle, cost, and AI-credit allocation vs. consumption"
      >
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/license-reconciliation",
            extraParams: buildParams(),
            columns: csvColumns,
            dataExtractor: (json) =>
              (json.rows || []).map((r: LicenseReconciliationRow) => ({
                ...r,
                orgs: Array.isArray(r.orgs) ? r.orgs.join(" | ") : r.orgs,
                over_budget: r.over_budget ? "TRUE" : "FALSE",
              })),
            filename: `license-ai-credits-${days}d`,
            metadata: exportMeta,
          }}
          pdf={{
            sectionRefs: [kpiRef, chartsRef, tableRef],
            title: "License & AI Credits Reconciliation",
            filename: `license-ai-credits-${days}d`,
            metadata: exportMeta,
          }}
          isReady={hasData}
        />
      </PageHeader>

      {hasFilter && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-2 text-sm text-blue-700 dark:text-blue-400">
          📊 Showing filtered results: <strong>{[...selectedEntTeams, ...selectedOrgTeams, ...selectedOrgs].join(", ")}</strong>
        </div>
      )}

      {!hasData ? (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <CreditCard className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">No licensed seats found for the selected scope.</p>
          <p className="text-xs mt-1">Seat and AI-credit data are populated during sync.</p>
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div ref={kpiRef} className="space-y-4">
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <MetricCard title="Licensed Users" value={kpis!.totalUsers} accent="blue" icon={<Users className="h-5 w-5" />} subtitle={`${fmtNum(kpis!.activeUsers)} active`} />
              <MetricCard title="Monthly License Cost" value={fmtMoney(kpis!.totalLicenseCost)} format="raw" accent="teal" icon={<CreditCard className="h-5 w-5" />} subtitle="Negotiated seat pricing" />
              <MetricCard title="AI Credits Consumed" value={fmtNum(kpis!.totalConsumedCredits)} accent="violet" icon={<Zap className="h-5 w-5" />} subtitle={`${fmtMoney(kpis!.totalConsumedUsd)} spend`} />
              <MetricCard title="Credit Utilization" value={`${safeNum(kpis!.overallUtilizationPct).toFixed(1)}%`} format="raw" accent="amber" icon={<Gauge className="h-5 w-5" />} subtitle={`${fmtNum(kpis!.totalConsumedCredits)} of ${fmtNum(kpis!.totalAllowanceCredits)} allocated`} />
            </div>
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <MetricCard title="Total Cost of Ownership" value={fmtMoney(kpis!.totalCostOfOwnership)} format="raw" accent="green" icon={<Wallet className="h-5 w-5" />} subtitle="License + credit spend" />
              <MetricCard title="AIC Assigned Budget" value={fmtMoney(kpis!.totalAssignedUsd)} format="raw" accent="blue" icon={<BadgeCheck className="h-5 w-5" />} subtitle="Allocated allowance value" />
              <MetricCard title="Over-Budget Users" value={kpis!.overBudgetUsers} accent="red" icon={<AlertTriangle className="h-5 w-5" />} subtitle="Consumption exceeds budget" />
              <MetricCard title="Zero-Consumption Seats" value={kpis!.zeroConsumptionSeats} accent="amber" icon={<AlertTriangle className="h-5 w-5" />} subtitle={`${fmtNum(kpis!.pendingCancellation)} pending cancellation`} />
            </div>
          </div>

          {/* Charts */}
          <div ref={chartsRef} className="grid gap-6 lg:grid-cols-2">
            {/* Allocation vs consumption by plan */}
            <Card className="p-6">
              <h3 className="text-sm font-semibold mb-1">Allocation vs. Consumption by Plan</h3>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">AI-credit allowance and actual consumption per license plan.</p>
              <div className="space-y-4">
                {planBreakdown.length === 0 && <p className="text-sm text-[hsl(var(--muted-foreground))]">No data.</p>}
                {planBreakdown.map((p) => (
                  <div key={p.key}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium capitalize">{p.key}</span>
                      <span className="text-[hsl(var(--muted-foreground))]">
                        {fmtNum(p.consumedCredits)} / {fmtNum(p.allowanceCredits)} cr · {p.utilizationPct.toFixed(0)}% · {p.seats} seats
                      </span>
                    </div>
                    <div className="relative h-3 w-full rounded-full bg-[hsl(var(--accent))] overflow-hidden">
                      <div className="absolute inset-y-0 left-0 rounded-full opacity-30" style={{ width: `${(p.allowanceCredits / maxPlanCredits) * 100}%`, background: planColor[p.key] || "#3b82f6" }} />
                      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(p.consumedCredits / maxPlanCredits) * 100}%`, background: planColor[p.key] || "#3b82f6" }} />
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Utilization distribution */}
            <Card className="p-6">
              <h3 className="text-sm font-semibold mb-1">Credit Utilization Distribution</h3>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">How many users fall into each allowance-utilization band.</p>
              <div className="space-y-3">
                {utilizationBuckets.map((b) => (
                  <div key={b.label} className="flex items-center gap-3">
                    <span className="w-16 text-xs text-[hsl(var(--muted-foreground))] text-right">{b.label}</span>
                    <div className="flex-1 h-5 rounded bg-[hsl(var(--accent))] overflow-hidden">
                      <div
                        className="h-full rounded bg-amber-500/80 flex items-center justify-end pr-2"
                        style={{ width: `${Math.max((b.count / maxBucket) * 100, b.count > 0 ? 6 : 0)}%` }}
                      >
                        {b.count > 0 && <span className="text-[10px] font-semibold text-white">{b.count}</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Org breakdown */}
          {orgBreakdown.length > 0 && (
            <Card className="p-6">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Building2 className="h-4 w-4" /> Cost & Consumption by Organization
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="px-3 py-2 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Organization</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Seats</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">License Cost</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Consumed (cr)</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Consumed</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Utilization</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orgBreakdown.slice(0, 15).map((o) => (
                      <tr key={o.key} className="border-b border-[hsl(var(--border))]/50 hover:bg-[hsl(var(--accent))]/40">
                        <td className="px-3 py-2 font-medium">{o.key || "(none)"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(o.seats)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(o.licenseCost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtNum(o.consumedCredits)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(o.consumedUsd)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{o.utilizationPct.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Per-user reconciliation table */}
          <Card ref={tableRef} className="p-0 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b">
              <h3 className="text-sm font-semibold">Per-User Reconciliation</h3>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") setSearch(searchInput.trim()); }}
                  onBlur={() => setSearch(searchInput.trim())}
                  placeholder="Search user or org…"
                  aria-label="Search users or organizations"
                  className="pl-8 pr-3 py-1.5 text-sm rounded-md border bg-[hsl(var(--background))] w-56"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[hsl(var(--accent))]/30">
                  <tr className="border-b">
                    <SortHeader col="user_login" label="User" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Orgs</th>
                    <SortHeader col="plan_type" label="Plan" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <SortHeader col="license_assigned_date" label="Assigned" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Status</th>
                    <SortHeader col="license_cost" label="License $" align="right" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <SortHeader col="aic_consumed_credits" label="Consumed cr" align="right" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <SortHeader col="utilization_pct" label="Util %" align="right" sort={sort} sortDir={sortDir} onSort={handleSort} />
                    <SortHeader col="total_cost" label="Total $" align="right" sort={sort} sortDir={sortDir} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.user_login} className="border-b border-[hsl(var(--border))]/50 hover:bg-[hsl(var(--accent))]/40">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.user_login}</div>
                        <div className="text-[10px] text-[hsl(var(--muted-foreground))]">{r.assigned_via}</div>
                      </td>
                      <td className="px-3 py-2 max-w-[180px] truncate" title={r.orgs.join(", ")}>
                        {r.orgs.length > 1 ? `${r.orgs[0]} +${r.orgs.length - 1}` : r.orgs[0] || "—"}
                      </td>
                      <td className="px-3 py-2 capitalize">{r.plan_type}</td>
                      <td className="px-3 py-2 tabular-nums text-xs">{r.license_assigned_date || "—"}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            r.seat_status === "pending_cancellation"
                              ? "bg-red-500/10 text-red-600 dark:text-red-400"
                              : r.activity_status === "active_30d"
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                          }`}
                        >
                          {r.seat_status === "pending_cancellation"
                            ? "pending cancel"
                            : r.activity_status === "active_30d"
                              ? "active"
                              : r.activity_status === "never"
                                ? "never active"
                                : "inactive 30d"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.license_cost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.aic_consumed_credits)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={r.over_budget ? "text-red-600 dark:text-red-400 font-semibold" : ""}>
                          {r.utilization_pct.toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(r.total_cost)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-[hsl(var(--muted-foreground))]">No matching users.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between p-4 border-t text-sm">
                <span className="text-[hsl(var(--muted-foreground))]">
                  Page {pagination.page} of {pagination.totalPages} · {fmtNum(pagination.totalItems)} users
                </span>
                <div className="flex gap-2">
                  <button
                    className="px-3 py-1 rounded border disabled:opacity-40 hover:bg-[hsl(var(--accent))]"
                    disabled={pagination.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <button
                    className="px-3 py-1 rounded border disabled:opacity-40 hover:bg-[hsl(var(--accent))]"
                    disabled={pagination.page >= pagination.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
