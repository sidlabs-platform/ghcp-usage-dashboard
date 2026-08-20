"use client";

// Historical License & AI Credits reconciliation dashboard — a 3-tab
// (Overview / Period Detail / Data Quality) refinement of the original
// single-view page. This file owns all query state (active tab, view,
// pagination/sort/search/filters, fetch/retry, the raw API response, refs,
// and export params) and composes the presentational
// `src/components/licensing/*` components, which own row/filter/quality/run
// rendering.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card } from "@/components/ui/card";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { useDateRange } from "@/contexts/DateRangeContext";

import { CopilotCostBasisPanel, type CopilotCostBasis } from "@/components/billing/CopilotCostBasisPanel";
import { useScope } from "@/contexts/ScopeContext";
import { safeNum } from "@/lib/utils";
import { LicensePeriodFilters } from "@/components/licensing/LicensePeriodFilters";
import { LicenseReconciliationTable, type TablePagination } from "@/components/licensing/LicenseReconciliationTable";
import { LicenseDataQualityPanel, type DataQualityCoverage } from "@/components/licensing/LicenseDataQualityPanel";
import { LicenseRunHistory } from "@/components/licensing/LicenseRunHistory";
import {
  CreditCard,
  Users,
  Wallet,
  Zap,
  Gauge,
  AlertTriangle,
  Building2,
  BadgeCheck,
  Info,
} from "lucide-react";
import type {
  LicenseReconciliationRow,
  LicenseReconciliationKPIs,
  LicenseGroupBreakdown,
  UtilizationBucket,
} from "@/lib/types/licensing";
import type { LicensePeriodRowRecord, LicenseRollupRowRecord } from "@/lib/db/license-history-repo";
import type { LicenseRunReportObject } from "@/lib/db/license-run-repo";
import type { EnterprisePreflightResult } from "@/lib/github/auth-preflight";

const PAGE_SIZE = 50;

type TabId = "overview" | "detail" | "quality";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "detail", label: "Period Detail" },
  { id: "quality", label: "Data Quality" },
];

interface Coverage {
  mode: string;
  periods: string[];
  view: string;
}

/** Discriminated union of the row shapes `LicenseReconciliationTable` accepts, keyed on the resolved view. */
type ReconciliationTableRows =
  | { view: "detail"; rows: LicensePeriodRowRecord[] }
  | { view: "rollup"; rows: LicenseRollupRowRecord[] }
  | { view: "legacy"; rows: LicenseReconciliationRow[] };

/** Clarifies that zero AI-credit consumption is a data/period condition, not a reconciliation failure. Renders nothing when consumption exists. */
function ZeroConsumptionNotice({ kpis }: Readonly<{ kpis: LicenseReconciliationKPIs }>) {
  if (!(kpis.totalUsers > 0 && kpis.totalConsumedCredits <= 0)) return null;
  const users = safeNum(kpis.totalUsers).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (
    <div role="note" className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <Info className="h-5 w-5 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium">No AI-credit consumption recorded for this period.</p>
        <p className="text-xs mt-1 opacity-90">
          All {users} licensed users show zero AI-credit usage. This measures premium AI-credit spend, not Copilot activity &mdash; seats can be active with included features (completions, chat) while consuming zero credits. If you expect consumption, confirm the billing sync has AI-credit data for the selected window (AI Credits began 2026-06-01).
        </p>
      </div>
    </div>
  );
}

export default function LicenseReconciliationPage() {
  const { mode: dateMode, days, startDate, endDate, period: selectedPeriod } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs, selectedEnterprises, filterOptions } =
    useScope();

  // ── Tab state ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // ── Query state (owned by the page; components are fully controlled) ──
  const [view, setView] = useState<"detail" | "rollup">("detail");
  const [periods, setPeriods] = useState<string[]>([]);
  const [costBasis, setCostBasis] = useState<CopilotCostBasis | null>(null);
  const [search, setSearch] = useState("");
  const [planTypes, setPlanTypes] = useState<string[]>([]);
  const [accountStates, setAccountStates] = useState<string[]>([]);
  const [seatStatuses, setSeatStatuses] = useState<string[]>([]);
  const [historyConfidence, setHistoryConfidence] = useState<string[]>([]);
  const [sort, setSort] = useState("total_cost");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // ── Fetched response state ──────────────────────────────────────────
  const [kpis, setKpis] = useState<LicenseReconciliationKPIs | null>(null);
  const [rows, setRows] = useState<(LicensePeriodRowRecord | LicenseRollupRowRecord | LicenseReconciliationRow)[]>([]);
  const [planBreakdown, setPlanBreakdown] = useState<LicenseGroupBreakdown[]>([]);
  const [orgBreakdown, setOrgBreakdown] = useState<LicenseGroupBreakdown[]>([]);
  const [utilizationBuckets, setUtilizationBuckets] = useState<UtilizationBucket[]>([]);
  const [pagination, setPagination] = useState<TablePagination>({ page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 });
  const [currency, setCurrency] = useState("USD");
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [dataSource, setDataSource] = useState<string>("historical");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Data quality / run drilldown state ──────────────────────────────
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunReport, setSelectedRunReport] = useState<LicenseRunReportObject | null>(null);
  const [runReportLoading, setRunReportLoading] = useState(false);
  const [runReportError, setRunReportError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<EnterprisePreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  const overviewRef = useRef<HTMLDivElement>(null);
  const qualityRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  const skipNextFetch = useRef(false);
  const fetchRequestSeq = useRef(0);
  const preflightRequestSeq = useRef(0);

  const activeEnterprise = selectedEnterprises[0] ?? filterOptions.enterprises[0]?.slug ?? null;

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
    if (periods.length > 0) {
      // An explicit in-page period selection always wins.
      p.set("periods", periods.join(","));
    } else if (dateMode === "month" && selectedPeriod) {
      // Share the globally-selected month so this page and Billing resolve to
      // identical bounds rather than each deriving a window of its own.
      p.set("periods", selectedPeriod);
    } else if (dateMode === "custom") {
      p.set("startDate", startDate);
      p.set("endDate", endDate);
    } else {
      p.set("days", String(days));
    }
    p.set("view", view);
    p.set("page", String(page));
    p.set("pageSize", String(PAGE_SIZE));
    p.set("sort", sort);
    p.set("sortDir", sortDir);
    if (search) p.set("search", search);
    if (planTypes.length > 0) p.set("plan", planTypes.join(","));
    if (accountStates.length > 0) p.set("accountState", accountStates.join(","));
    if (seatStatuses.length > 0) p.set("seatStatus", seatStatuses.join(","));
    if (historyConfidence.length > 0) p.set("historyConfidence", historyConfidence.join(","));
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => p.set(k, v));
    return p;
  }, [
    periods,
    dateMode,
    selectedPeriod,
    startDate,
    endDate,
    days,
    view,
    page,
    sort,
    sortDir,
    search,
    planTypes,
    accountStates,
    seatStatuses,
    historyConfidence,
    buildScopeParams,
  ]);

  const fetchData = useCallback(async () => {
    const requestSeq = ++fetchRequestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/license-reconciliation?${buildParams().toString()}`);
      if (fetchRequestSeq.current !== requestSeq) return;
      if (!res.ok) {
        setError("Failed to load reconciliation data. Review the current filters and try again.");
        return;
      }
      const data = await res.json();
      if (fetchRequestSeq.current !== requestSeq) return;
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
      setCoverage(data.coverage || null);
      setDataSource(data.dataSource || "historical");
      setWarnings(data.warnings || []);
      setCostBasis(data.costBasis ?? null);
      if (data.config?.currency) setCurrency(data.config.currency);
    } catch {
      if (fetchRequestSeq.current !== requestSeq) return;
      setError("Failed to load reconciliation data. Review the current filters and try again.");
    } finally {
      if (fetchRequestSeq.current === requestSeq) setLoading(false);
    }
  }, [buildParams]);

  const fetchPreflight = useCallback(async () => {
    const requestSeq = ++preflightRequestSeq.current;
    if (!activeEnterprise) {
      setPreflight(null);
      setPreflightError(null);
      setPreflightLoading(false);
      return;
    }

    setPreflightLoading(true);
    setPreflightError(null);
    try {
      const response = await fetch(
        `/api/billing/license-reconciliation/preflight?enterprise=${encodeURIComponent(activeEnterprise)}`,
        { cache: "no-store" },
      );
      if (preflightRequestSeq.current !== requestSeq) return;
      if (!response.ok) {
        setPreflightError("Failed to check licensing capabilities.");
        return;
      }
      const result = (await response.json()) as EnterprisePreflightResult;
      if (preflightRequestSeq.current !== requestSeq) return;
      setPreflight(result);
    } catch {
      if (preflightRequestSeq.current !== requestSeq) return;
      setPreflightError("Failed to check licensing capabilities.");
    } finally {
      if (preflightRequestSeq.current === requestSeq) setPreflightLoading(false);
    }
  }, [activeEnterprise]);

  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => {
    if (pageRef.current !== 1) {
      // Criteria changes should reset pagination; skip the stale old-page fetch and let page=1 fetch next.
      skipNextFetch.current = true;
      setPage(1);
    }
  }, [
    search,
    sort,
    sortDir,
    days,
    startDate,
    endDate,
    periods,
    view,
    planTypes,
    accountStates,
    seatStatuses,
    historyConfidence,
    hasFilter,
    selectedEntTeams,
    selectedOrgTeams,
    selectedOrgs,
  ]);
  useEffect(() => {
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    fetchData();
  }, [fetchData]);
  useEffect(() => {
    setSelectedRunId(null);
    setSelectedRunReport(null);
    setRunReportLoading(false);
    setRunReportError(null);
    setPreflight(null);
    setPreflightError(null);
    preflightRequestSeq.current += 1;
  }, [activeEnterprise]);
  useEffect(() => {
    if (activeTab === "quality") void fetchPreflight();
  }, [activeTab, fetchPreflight]);

  const handleSort = (col: string) => {
    if (sort === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(col); setSortDir("desc"); }
  };

  const handleViewChange = (nextView: "detail" | "rollup") => {
    setSort("total_cost");
    setSortDir("desc");
    setView(nextView);
  };

  const handleClearFilters = () => {
    setSearch("");
    setPlanTypes([]);
    setAccountStates([]);
    setSeatStatuses([]);
    setHistoryConfidence([]);
    setPeriods([]);
  };

  const handleSelectRun = (runId: string) => {
    setSelectedRunId(runId);
    setRunReportLoading(true);
    setRunReportError(null);
  };

  const handleReportChange = (report: LicenseRunReportObject | null) => {
    setSelectedRunReport(report);
    setRunReportLoading(false);
  };

  const handleReportErrorChange = useCallback((message: string | null) => {
    setRunReportError(message);
  }, []);

  // ── Tab keyboard navigation (ArrowLeft/ArrowRight/Home/End, wraparound) ──
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      tabRefs.current[nextIndex]?.focus();
      setActiveTab(TABS[nextIndex].id);
    }
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

  if (error && !kpis) {
    return (
      <div className="space-y-6">
        <PageHeader title="License & AI Credits" description="Per-user Copilot license + AI-credit reconciliation" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <AlertTriangle className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">{error}</p>
          <button
            type="button"
            onClick={() => fetchData()}
            className="mt-4 rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-[hsl(var(--accent))]"
          >
            Retry
          </button>
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

  const hasData = !!kpis && (kpis.totalUsers > 0 || pagination.totalItems > 0);
  const maxPlanCredits = Math.max(1, ...planBreakdown.map((p) => Math.max(p.allowanceCredits, p.consumedCredits)));
  const maxBucket = Math.max(1, ...utilizationBuckets.map((b) => b.count));

  const planColor: Record<string, string> = {
    enterprise: "#8b5cf6",
    business: "#3b82f6",
    unknown: "#94a3b8",
  };

  const exportMeta = {
    reportName: "License & AI Credits Reconciliation",
    dateRange: periods.length > 0 ? `Periods: ${periods.join(", ")}` : `Last ${days} days`,
    view,
    ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: selectedOrgs.join(", ") }),
  };

  const effectiveView: "detail" | "rollup" | "legacy" =
    dataSource === "live_snapshot_only" ? "legacy" : ((coverage?.view as "detail" | "rollup") ?? view);
  const tableRowsProps: ReconciliationTableRows =
    effectiveView === "rollup"
      ? { view: "rollup", rows: rows as LicenseRollupRowRecord[] }
      : effectiveView === "legacy"
        ? { view: "legacy", rows: rows as LicenseReconciliationRow[] }
        : { view: "detail", rows: rows as LicensePeriodRowRecord[] };

  const qualityCoverage: DataQualityCoverage | null = coverage;

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
            sectionRefs: [overviewRef, qualityRef],
            title: "License & AI Credits Reconciliation",
            filename: `license-ai-credits-${days}d`,
            metadata: exportMeta,
          }}
          isReady={hasData}
        />
      </PageHeader>

      {/* ── Tabs ──────────────────────────────────────────────────────── */}
      <div role="tablist" aria-label="License reconciliation views" className="flex gap-1 border-b">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => { tabRefs.current[index] = el; }}
            role="tab"
            id={`license-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`license-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, index)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))] ${
              activeTab === tab.id
                ? "border-[hsl(var(--primary))] text-[hsl(var(--foreground))]"
                : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Coverage / status rail ───────────────────────────────────── */}
      {coverage && (
        <div
          className={`rounded-lg border px-4 py-2 text-sm ${
            coverage.mode === "live_snapshot_only"
              ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
              : "border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 text-[hsl(var(--muted-foreground))]"
          }`}
          role={coverage.mode === "live_snapshot_only" ? "alert" : "status"}
        >
          {coverage.mode === "live_snapshot_only" ? (
            <span>
              Showing live snapshot only — historical periods unavailable until sync completes. This is not a substitute
              for full history.
            </span>
          ) : (
            <span>
              Historical coverage: periods <span className="tabular-nums font-medium">{coverage.periods.join(", ")}</span>{" "}
              · {coverage.view} view · mode: {coverage.mode}
              {warnings.length > 0 && (
                <span className="ml-2 text-amber-700 dark:text-amber-400">⚠ {warnings.join("; ")}</span>
              )}
            </span>
          )}
        </div>
      )}

      {/* Shared basis — identical figures render on the Billing page. */}
      <CopilotCostBasisPanel basis={costBasis} currency={currency} surface="licensing" />

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => fetchData()}
            className="rounded-md border border-current px-3 py-1 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {!hasData && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <CreditCard className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">No matching license history for the current selection.</p>
          <p className="text-xs mt-1">Run sync to populate data, change periods, or clear filters to broaden your search.</p>
        </div>
      )}

      {/* ── Overview panel ────────────────────────────────────────────── */}
      <div
        id="license-panel-overview"
        role="tabpanel"
        aria-labelledby="license-tab-overview"
        hidden={activeTab !== "overview"}
        ref={overviewRef}
        className="space-y-8"
      >
        {hasData && kpis && (
          <>
            <div className="space-y-4">
              <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <MetricCard title="Licensed Users" value={kpis.totalUsers} accent="blue" icon={<Users className="h-5 w-5" />} subtitle={`${fmtNum(kpis.activeUsers)} active`} />
                <MetricCard title="Monthly License Cost" value={fmtMoney(kpis.totalLicenseCost)} format="raw" accent="teal" icon={<CreditCard className="h-5 w-5" />} subtitle="Negotiated seat pricing" />
                <MetricCard title="AI Credits (attributed)" value={fmtNum(kpis.totalConsumedCredits)} accent="violet" icon={<Zap className="h-5 w-5" />} subtitle={`${fmtMoney(kpis.totalConsumedUsd)} spend · per-user report`} />
                <MetricCard title="Credit Utilization" value={`${safeNum(kpis.overallUtilizationPct).toFixed(1)}%`} format="raw" accent="amber" icon={<Gauge className="h-5 w-5" />} subtitle={`${fmtNum(kpis.totalConsumedCredits)} attributed of ${fmtNum(kpis.totalAllowanceCredits)} allocated`} />
              </div>
              <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <MetricCard title="Total Cost of Ownership" value={fmtMoney(kpis.totalCostOfOwnership)} format="raw" accent="green" icon={<Wallet className="h-5 w-5" />} subtitle="License + credit spend" />
                <MetricCard title="AIC Assigned Budget" value={fmtMoney(kpis.totalAssignedUsd)} format="raw" accent="blue" icon={<BadgeCheck className="h-5 w-5" />} subtitle="Allocated allowance value" />
                <MetricCard title="Over-Budget Users" value={kpis.overBudgetUsers} accent="red" icon={<AlertTriangle className="h-5 w-5" />} subtitle="Consumption exceeds budget" />
                <MetricCard title="Zero-Consumption Seats" value={kpis.zeroConsumptionSeats} accent="amber" icon={<AlertTriangle className="h-5 w-5" />} subtitle={`${fmtNum(kpis.pendingCancellation)} pending cancellation`} />
              </div>

              <ZeroConsumptionNotice kpis={kpis} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
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

              <Card className="p-6">
                <h3 className="text-sm font-semibold mb-1">Credit Utilization Distribution</h3>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">How many users fall into each allowance-utilization band.</p>
                <div className="space-y-3">
                 {utilizationBuckets.length === 0 ? (
                   <p className="text-sm text-[hsl(var(--muted-foreground))]">
                     Utilization distribution is unavailable for the selected historical periods.
                   </p>
                 ) : (
                   utilizationBuckets.map((b) => (
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
                   ))
                 )}
                </div>
              </Card>
            </div>

            {orgBreakdown.length > 0 && (
              <Card className="p-6">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <Building2 className="h-4 w-4" /> Cost & Consumption by Organization
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Copilot license cost and AI-credit consumption per organization, for the
                      selected period and scope.
                    </caption>
                    <thead>
                      <tr className="border-b">
                        <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Organization</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Seats</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">License Cost</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Consumed (cr)</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Consumed</th>
                        <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Utilization</th>
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
          </>
        )}
      </div>

      {/* ── Period Detail panel ──────────────────────────────────────── */}
      <div
        id="license-panel-detail"
        role="tabpanel"
        aria-labelledby="license-tab-detail"
        hidden={activeTab !== "detail"}
        className="space-y-4"
      >
        <LicensePeriodFilters
          view={view}
          onViewChange={handleViewChange}
          periods={periods}
          onPeriodsChange={setPeriods}
          search={search}
          onSearchChange={setSearch}
          planTypes={planTypes}
          onPlanTypesChange={setPlanTypes}
          accountStates={accountStates}
          onAccountStatesChange={setAccountStates}
          seatStatuses={seatStatuses}
          onSeatStatusesChange={setSeatStatuses}
          historyConfidence={historyConfidence}
          onHistoryConfidenceChange={setHistoryConfidence}
          onClearFilters={handleClearFilters}
        />
        <LicenseReconciliationTable
          {...tableRowsProps}
          currency={currency}
          sort={sort}
          sortDir={sortDir}
          onSort={handleSort}
          pagination={pagination}
          onPageChange={setPage}
        />
      </div>

      {/* ── Data Quality panel ───────────────────────────────────────── */}
      <div
        id="license-panel-quality"
        role="tabpanel"
        aria-labelledby="license-tab-quality"
        hidden={activeTab !== "quality"}
        ref={qualityRef}
        className="space-y-6"
      >
        <LicenseRunHistory
          enterpriseSlug={activeEnterprise}
          selectedRunId={selectedRunId}
          onSelectRun={handleSelectRun}
          onReportChange={handleReportChange}
          onReportErrorChange={handleReportErrorChange}
        />
        <LicenseDataQualityPanel
          coverage={qualityCoverage}
          warnings={warnings}
          report={selectedRunReport}
          reportLoading={runReportLoading}
          reportError={runReportError}
          preflight={preflight}
          preflightLoading={preflightLoading}
          preflightError={preflightError}
          onRetryPreflight={fetchPreflight}
        />
      </div>
    </div>
  );
}
