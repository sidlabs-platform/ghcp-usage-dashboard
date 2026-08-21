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
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { useDateRange } from "@/contexts/DateRangeContext";

import { CopilotCostBasisPanel, type CopilotCostBasis } from "@/components/billing/CopilotCostBasisPanel";
import { periodLabel } from "@/lib/date/month-range";
import { useScope } from "@/contexts/ScopeContext";
import { safeNum } from "@/lib/utils";
import { LicensePeriodFilters } from "@/components/licensing/LicensePeriodFilters";
import { LicenseReconciliationTable, type TablePagination } from "@/components/licensing/LicenseReconciliationTable";
import { LicenseDataQualityPanel, type DataQualityCoverage } from "@/components/licensing/LicenseDataQualityPanel";
import { LicenseRunHistory } from "@/components/licensing/LicenseRunHistory";
import { LicenseBilledKpiTiles } from "@/components/licensing/LicenseBilledKpiTiles";
import { LicenseBilledBreakdown } from "@/components/licensing/LicenseBilledBreakdown";
import {
  CreditCard,
  AlertTriangle,
  Info,
} from "lucide-react";
import type {
  LicenseReconciliationRow,
  LicenseReconciliationKPIs,
} from "@/lib/types/licensing";
import type { CopilotBillingBreakdown } from "@/lib/types/billing";
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

/**
 * Names the one gap that can still exist between the per-user table below and
 * the billed figures above: AI credits billed to a login that holds no seat in
 * the current selection.
 *
 * Every other former note here excused tiles that were built from the undated
 * `copilot_seats` snapshot and from configured list prices. Those tiles are
 * gone — the Overview now reads billed rows for the selected window only — so
 * there is nothing left to excuse. A residual that is genuinely real still
 * gets named rather than silently dropped.
 */
function PeriodBasisNotice({
  kpis,
  fmtNum,
}: Readonly<{
  kpis: LicenseReconciliationKPIs;
  fmtNum: (v: number) => string;
}>) {
  const unmatched = safeNum(kpis.unmatchedConsumedCredits);
  if (unmatched <= 0) return null;

  return (
    <div role="note" className="flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 px-4 py-3 text-sm">
      <Info className="h-5 w-5 shrink-0 mt-0.5 text-[hsl(var(--muted-foreground))]" />
      <div>
        <p className="font-medium">Consumption billed outside the current seat list</p>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
          {fmtNum(unmatched)} credits ({fmtNum(kpis.unmatchedUsers)} users) were billed to logins
          with no seat in the current selection. They are counted in the billed figures above but
          cannot appear in the per-user table.
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
  const [billingBreakdown, setBillingBreakdown] = useState<CopilotBillingBreakdown | null>(null);
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
      setPagination(data.pagination || { page: 1, pageSize: PAGE_SIZE, totalItems: 0, totalPages: 0 });
      setCoverage(data.coverage || null);
      setDataSource(data.dataSource || "historical");
      setWarnings(data.warnings || []);
      setCostBasis(data.costBasis ?? null);
      setBillingBreakdown(data.billingBreakdown ?? null);
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

  // The Overview tab is now driven entirely by billed rows for the selected
  // window, so it has data whenever billing does — independently of whether a
  // per-user roster exists for the period.
  const hasBilledData = !!billingBreakdown?.hasBilledData;
  const hasRosterData = !!kpis && (kpis.totalUsers > 0 || pagination.totalItems > 0);
  const hasData = hasBilledData || hasRosterData;

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

  const windowName = costBasis?.period
    ? periodLabel(costBasis.period)
    : periods.length > 0
      ? periods.map(periodLabel).join(", ")
      : `the last ${days} days`;

  // In live-snapshot mode the per-user rows come from the *current*
  // `copilot_seats` table with period consumption joined on — a roster of who
  // holds a seat today, not a census of who held one during the window. Saying
  // so plainly is the only honest framing; the billed figures above are where
  // period-accurate answers live.
  const rosterCaption =
    dataSource === "live_snapshot_only"
      ? `Current seat-holders, with AI-credit consumption from ${windowName} joined on. This is today's roster, not a ${windowName} census — for period-accurate licence and cost figures, use the billed totals above.`
      : `Per-user licence and AI-credit detail materialized for ${windowName}.`;

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
        {hasBilledData || hasRosterData ? (
          <>
            <LicenseBilledKpiTiles basis={costBasis} breakdown={billingBreakdown} currency={currency} windowLabel={windowName} />

            {kpis && <PeriodBasisNotice kpis={kpis} fmtNum={fmtNum} />}

            <LicenseBilledBreakdown breakdown={billingBreakdown} currency={currency} windowLabel={windowName} />
          </>
        ) : null}
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
        <div role="note" className="flex items-start gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/30 px-4 py-3 text-sm">
          <Info className="h-5 w-5 shrink-0 mt-0.5 text-[hsl(var(--muted-foreground))]" />
          <div>
            <p className="font-medium">
              {dataSource === "live_snapshot_only"
                ? "Current seat roster, joined to period consumption"
                : `Per-user detail for ${windowName}`}
            </p>
            <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{rosterCaption}</p>
          </div>
        </div>
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
