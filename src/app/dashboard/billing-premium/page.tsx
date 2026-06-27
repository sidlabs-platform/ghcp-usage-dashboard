"use client";

import { Fragment, useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { Zap, Users, Brain, AlertTriangle, Search, X } from "lucide-react";
import { safeNum } from "@/lib/utils";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { BillingPremiumRequestRecord, PremiumRequestUserSummary, PremiumRequestModelSummary, PremiumDailyTrend } from "@/lib/types/billing";

const PremiumModelUsageChart = dynamic(
  () => import("@/components/charts/PremiumModelUsageChart").then(m => ({ default: m.PremiumModelUsageChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const PremiumQuotaChart = dynamic(
  () => import("@/components/charts/PremiumQuotaChart").then(m => ({ default: m.PremiumQuotaChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const PremiumDailyTrendChart = dynamic(
  () => import("@/components/charts/PremiumDailyTrendChart").then(m => ({ default: m.PremiumDailyTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface PremiumKPIs {
  totalRequests: number;
  usersOverQuota: number;
  totalUsers: number;
  totalNet: number;
  topModel: string;
  uniqueModels: number;
  totalAiCredits: number;
  totalAicGross: number;
}

interface FilterOptions {
  models: string[];
  organizations: string[];
  users: string[];
}

interface UserModelBreakdownRow {
  model: string;
  ai_credits: number;
  usd: number;
}

const fmtCurrency = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;
};

/**
 * Renders the AI Credits billing dashboard page with KPIs, trends, and detailed usage tables.
 * @returns {JSX.Element} Billing dashboard page content.
 */
export default function PremiumRequestsPage() {
  const { days } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs: scopeOrgs } = useScope();
  const [kpis, setKpis] = useState<PremiumKPIs | null>(null);
  const [userSummary, setUserSummary] = useState<PremiumRequestUserSummary[]>([]);
  const [modelSummary, setModelSummary] = useState<PremiumRequestModelSummary[]>([]);
  const [dailyTrend, setDailyTrend] = useState<PremiumDailyTrend[]>([]);
  const [records, setRecords] = useState<BillingPremiumRequestRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ models: [], organizations: [], users: [] });
  const [expandedUsers, setExpandedUsers] = useState<Record<string, boolean>>({});
  const [userModelBreakdown, setUserModelBreakdown] = useState<Record<string, UserModelBreakdownRow[]>>({});
  const [loadingUserModels, setLoadingUserModels] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<string[]>([]);
  const [selectedOrg, setSelectedOrg] = useState<string[]>([]);
  const [exceedsQuota, setExceedsQuota] = useState<string>("");
  const [sort, setSort] = useState("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const trendRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const userModelBreakdownRef = useRef<Record<string, UserModelBreakdownRow[]>>({});

  // Keep ref in sync with state
  useEffect(() => {
    userModelBreakdownRef.current = userModelBreakdown;
  }, [userModelBreakdown]);

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    p.set("days", String(days));
    p.set("page", String(page));
    p.set("pageSize", "50");
    p.set("sort", sort);
    p.set("sortDir", sortDir);
    if (search) p.set("search", search);
    if (selectedModel.length) p.set("model", selectedModel.join(","));
    if (selectedOrg.length) p.set("organization", selectedOrg.join(","));
    if (exceedsQuota) p.set("exceedsQuota", exceedsQuota);
    // Merge scope params
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => p.set(k, v));
    return p;
  }, [days, page, sort, sortDir, search, selectedModel, selectedOrg, exceedsQuota, buildScopeParams]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildParams();
      const summaryParams = new URLSearchParams();
      summaryParams.set("days", String(days));
      if (selectedModel.length) summaryParams.set("model", selectedModel.join(","));
      if (selectedOrg.length) summaryParams.set("organization", selectedOrg.join(","));
      if (exceedsQuota) summaryParams.set("exceedsQuota", exceedsQuota);
      // Merge scope params into summary
      const scopeParams = buildScopeParams();
      scopeParams.forEach((v, k) => summaryParams.set(k, v));

      const [detailRes, summaryRes] = await Promise.all([
        fetch(`/api/billing/premium?${params.toString()}`),
        fetch(`/api/billing/premium/summary?${summaryParams.toString()}`),
      ]);

      const detailData = await detailRes.json();
      if (detailData.enabled === false) { setEnabled(false); return; }

      setRecords(detailData.records || []);
      setPagination(detailData.pagination || { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
      setFilterOptions(detailData.filterOptions || { models: [], organizations: [], users: [] });

      const summaryData = await summaryRes.json();
      if (summaryData.enabled !== false) {
        setKpis(summaryData.kpis || null);
        setUserSummary(summaryData.userSummary || []);
        setModelSummary(summaryData.modelSummary || []);
        setDailyTrend(summaryData.dailyTrend || []);
      }
    } catch (err) {
      console.error("Failed to load premium requests:", err);
    } finally {
      setLoading(false);
    }
  }, [buildParams, days, selectedModel, selectedOrg, exceedsQuota, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setPage(1); }, [search, selectedModel, selectedOrg, exceedsQuota, sort, sortDir, hasFilter, selectedEntTeams, selectedOrgTeams, scopeOrgs]);

  const handleSort = (col: string) => {
    if (sort === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSort(col); setSortDir("desc"); }
  };

  const getUserKey = (username: string, organization: string) => `${username}::${organization || ""}`;

  const fetchUserModelBreakdown = useCallback(async (username: string, organization: string) => {
    const key = getUserKey(username, organization);
    if (userModelBreakdownRef.current[key]) return;

    setLoadingUserModels((prev) => ({ ...prev, [key]: true }));
    try {
      const p = new URLSearchParams();
      p.set("days", String(days));
      p.set("username", username);
      p.set("rowOrganization", organization || "");
      if (selectedModel.length) p.set("model", selectedModel.join(","));
      if (selectedOrg.length) p.set("organization", selectedOrg.join(","));
      if (exceedsQuota) p.set("exceedsQuota", exceedsQuota);
      const scopeParams = buildScopeParams();
      scopeParams.forEach((v, k) => p.set(k, v));

      const res = await fetch(`/api/billing/premium/user-models?${p.toString()}`);
      const data = await res.json();
      setUserModelBreakdown((prev) => ({ ...prev, [key]: data.models || [] }));
    } catch {
      setUserModelBreakdown((prev) => ({ ...prev, [key]: [] }));
    } finally {
      setLoadingUserModels((prev) => ({ ...prev, [key]: false }));
    }
  }, [buildScopeParams, days, exceedsQuota, selectedModel, selectedOrg]);

  const toggleUserExpanded = useCallback((username: string, organization: string) => {
    const key = getUserKey(username, organization);
    setExpandedUsers((prev) => {
      const nextExpanded = !prev[key];
      if (nextExpanded) {
        void fetchUserModelBreakdown(username, organization);
      }
      return { ...prev, [key]: nextExpanded };
    });
  }, [fetchUserModelBreakdown]);

  const csvColumns = useMemo(() => [
    { key: "date", label: "Date" },
    { key: "product", label: "Product" },
    { key: "sku", label: "SKU" },
    { key: "quantity", label: "Quantity" },
    { key: "unit_type", label: "Unit Type" },
    { key: "gross_amount", label: "Gross Amount" },
    { key: "discount_amount", label: "Discount" },
    { key: "net_amount", label: "Net Amount" },
    { key: "username", label: "Username" },
    { key: "organization", label: "Organization" },
    { key: "model", label: "Model" },
    { key: "exceeds_quota", label: "Exceeds Quota" },
    { key: "total_monthly_quota", label: "Monthly Quota" },
  ], []);

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Credits" description="AI credit consumption, model usage, quotas, and per-user breakdown" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <Zap className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">Enable billing in <code className="text-xs bg-[hsl(var(--accent))] px-1 py-0.5 rounded">dashboard-config.json</code>.</p>
        </div>
      </div>
    );
  }

  if (loading && !kpis) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Credits" description="AI credit consumption, model usage, quotas, and per-user breakdown" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const hasData = kpis && kpis.totalRequests > 0;

  const SortHeader = ({ col, label }: { col: string; label: string }) => (
    <th
      className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider cursor-pointer hover:text-[hsl(var(--foreground))] select-none"
      onClick={() => handleSort(col)}
    >
      <span className="flex items-center gap-1">
        {label}
        {sort === col && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
      </span>
    </th>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="AI Credits" description="AI credit consumption, model usage, quotas, and per-user breakdown">
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/premium",
            extraParams: buildParams(),
            columns: csvColumns,
            dataExtractor: (json) => json.records,
            filename: `ai-credits-${days}d`,
            metadata: {
              reportName: "AI Credits Report",
              dateRange: `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          pdf={{
            sectionRefs: [kpiRef, trendRef, chartsRef, tableRef],
            title: "AI Credits Report",
            filename: `ai-credits-${days}d`,
            metadata: {
              reportName: "AI Credits Report",
              dateRange: `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          isReady={!!hasData}
        />
      </PageHeader>

      {/* Active scope filter indicator */}
      {hasFilter && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-2 text-sm text-blue-700 dark:text-blue-400">
          📊 Showing filtered results: <strong>{[...selectedEntTeams, ...selectedOrgTeams, ...scopeOrgs].join(", ")}</strong>
        </div>
      )}

      {!hasData && !loading && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <Zap className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-xl font-semibold mb-2">No AI credit data {hasFilter ? "for this filter" : ""}</p>
          <p className="text-sm max-w-md mx-auto">
            {hasFilter
              ? "Try adjusting your team/org filter or date range."
              : "AI credit data will appear after a billing sync."}
          </p>
        </div>
      )}

      {hasData && kpis && (
        <>
          {/* KPI Cards */}
          <div ref={kpiRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Total AI Credits"
              value={kpis.totalAiCredits > 0
                ? kpis.totalAiCredits.toLocaleString(undefined, { maximumFractionDigits: 1 })
                : kpis.totalRequests.toLocaleString()}
              format="raw"
              icon={<Zap className="h-4 w-4" />}
              subtitle={`Last ${days} days`}
            />
            <MetricCard
              title="Users Over Quota"
              value={kpis.usersOverQuota}
              icon={<AlertTriangle className="h-4 w-4" />}
              subtitle={`${kpis.totalUsers} total users`}
            />
            <MetricCard
              title="Most Used Model"
              value={kpis.topModel}
              format="raw"
              icon={<Brain className="h-4 w-4" />}
              subtitle={`${kpis.uniqueModels} models used`}
            />
            <MetricCard
              title="Total Cost"
              value={fmtCurrency(kpis.totalAicGross > 0 ? kpis.totalAicGross : kpis.totalNet)}
              format="raw"
              icon={<Users className="h-4 w-4" />}
              subtitle="AI credit billed cost"
            />
          </div>

          {/* Daily Trend */}
          {dailyTrend.length > 0 && (
            <div ref={trendRef} className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Daily Trend</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                <span className="text-purple-500">● Credits</span>{" · "}
                <span className="text-amber-500">● Cost</span>{" · "}
                <span className="text-emerald-500" style={{ borderBottom: "1px dashed" }}>Active Users</span>
              </p>
              <PremiumDailyTrendChart data={dailyTrend} />
            </div>
          )}

          {/* Charts */}
          <div ref={chartsRef} className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Usage by Model</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">AI credits consumed and cost per model</p>
              <PremiumModelUsageChart data={modelSummary} />
            </div>
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Quota Utilization</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                <span className="text-emerald-500">● Within quota</span>{" · "}
                <span className="text-red-500">● Over quota</span>
              </p>
              <PremiumQuotaChart data={userSummary} />
            </div>
          </div>

          {/* Per-User Summary Table */}
          {userSummary.length > 0 && (
            <div className="rounded-xl border bg-[hsl(var(--card))] overflow-hidden">
              <div className="px-6 py-4 border-b">
                <h3 className="text-lg font-semibold">Per-User Breakdown</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">Expand a user row to see model-wise AI credits and cost</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-[hsl(var(--accent))]/30">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">User</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Org</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">AI Credits</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Within Quota</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Over Quota</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Quota Limit</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Utilization</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[hsl(var(--border))]">
                    {userSummary.slice(0, 50).map((u) => {
                      const utilColor = u.utilization_pct > 100
                        ? "text-red-600 dark:text-red-400"
                        : (u.utilization_pct > 80 ? "text-yellow-600 dark:text-yellow-400" : "text-emerald-600 dark:text-emerald-400");
                      const key = getUserKey(u.username, u.organization || "");
                      const expanded = !!expandedUsers[key];
                      const modelRows = userModelBreakdown[key] || [];
                      const modelLoading = !!loadingUserModels[key];
                      return (
                        <Fragment key={key}>
                          <tr className="hover:bg-[hsl(var(--accent))]/20 transition-colors cursor-pointer" onClick={() => toggleUserExpanded(u.username, u.organization || "") }>
                            <td className="px-4 py-2.5 font-medium">
                              <span className="inline-flex items-center gap-2">
                                <span className="text-xs text-[hsl(var(--muted-foreground))]">{expanded ? "▾" : "▸"}</span>
                                {u.username}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))]">{u.organization || "—"}</td>
                            <td className="px-4 py-2.5 text-right">{safeNum(u.total_requests).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{safeNum(u.within_quota).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400">{safeNum(u.over_quota) > 0 ? safeNum(u.over_quota).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
                            <td className="px-4 py-2.5 text-right text-[hsl(var(--muted-foreground))]">{safeNum(u.quota_limit) > 0 ? safeNum(u.quota_limit).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}</td>
                            <td className={`px-4 py-2.5 text-right font-semibold ${utilColor}`}>
                              {safeNum(u.utilization_pct) > 0 ? `${safeNum(u.utilization_pct).toFixed(1)}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right font-semibold">{fmtCurrency(u.total_net)}</td>
                          </tr>
                          {expanded && (
                            <tr className="bg-[hsl(var(--accent))]/10">
                              <td colSpan={8} className="px-4 py-3">
                                {modelLoading ? (
                                  <div className="text-xs text-[hsl(var(--muted-foreground))]">Loading model breakdown...</div>
                                ) : modelRows.length === 0 ? (
                                  <div className="text-xs text-[hsl(var(--muted-foreground))]">No model-level usage found for this user in the selected period.</div>
                                ) : (
                                  <div className="overflow-x-auto">
                                    <table className="min-w-[420px] text-xs">
                                      <thead>
                                        <tr className="text-[hsl(var(--muted-foreground))]">
                                          <th className="py-1 pr-6 text-left font-medium">Model</th>
                                          <th className="py-1 pr-6 text-right font-medium">AI Credits</th>
                                          <th className="py-1 text-right font-medium">Cost</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {modelRows.map((m) => (
                                          <tr key={`${key}-${m.model}`}>
                                            <td className="py-1 pr-6">{m.model || "unknown"}</td>
                                            <td className="py-1 pr-6 text-right">{safeNum(m.ai_credits).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                                            <td className="py-1 text-right">{fmtCurrency(safeNum(m.usd))}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Filter Bar for Detail Records */}
          <div className="rounded-xl border bg-[hsl(var(--card))] p-4">
            <h3 className="text-sm font-semibold mb-3">Detailed Records</h3>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search user, org, model..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg border bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/20"
                />
              </div>
              <select
                className="rounded-lg border bg-transparent px-3 py-2 text-sm"
                value={selectedModel[0] || ""}
                onChange={(e) => setSelectedModel(e.target.value ? [e.target.value] : [])}
              >
                <option value="">All Models</option>
                {filterOptions.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select
                className="rounded-lg border bg-transparent px-3 py-2 text-sm"
                value={selectedOrg[0] || ""}
                onChange={(e) => setSelectedOrg(e.target.value ? [e.target.value] : [])}
              >
                <option value="">All Organizations</option>
                {filterOptions.organizations.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <div className="flex rounded-lg border overflow-hidden">
                {[
                  { value: "", label: "All" },
                  { value: "false", label: "Within Quota" },
                  { value: "true", label: "Over Quota" },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setExceedsQuota(opt.value)}
                    className={`px-3 py-2 text-xs font-medium transition-colors ${
                      exceedsQuota === opt.value
                        ? "bg-[hsl(var(--primary))] text-white"
                        : "hover:bg-[hsl(var(--accent))]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {Boolean(search || selectedModel.length || selectedOrg.length || exceedsQuota) && (
                <button
                  onClick={() => { setSearch(""); setSelectedModel([]); setSelectedOrg([]); setExceedsQuota(""); }}
                  className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>

          {/* Detailed Records Table */}
          <div ref={tableRef} className="rounded-xl border bg-[hsl(var(--card))] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-[hsl(var(--accent))]/30">
                  <tr>
                    <SortHeader col="date" label="Date" />
                    <SortHeader col="username" label="User" />
                    <SortHeader col="organization" label="Org" />
                    <SortHeader col="model" label="Model" />
                    <SortHeader col="quantity" label="AI Credits" />
                    <SortHeader col="gross_amount" label="USD" />
                    <SortHeader col="net_amount" label="Legacy Net" />
                    <th className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Exceeds Quota</th>
                    <th className="px-3 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Monthly Quota</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {loading ? (
                    <tr><td colSpan={9} className="px-3 py-12 text-center text-[hsl(var(--muted-foreground))]">Loading...</td></tr>
                  ) : records.length === 0 ? (
                    <tr><td colSpan={9} className="px-3 py-12 text-center text-[hsl(var(--muted-foreground))]">No records found</td></tr>
                  ) : (
                    records.map((r) => (
                      <tr key={`${r.date}-${r.username}-${r.organization}-${r.model}-${r.sku}`} className="hover:bg-[hsl(var(--accent))]/20 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs">{r.date}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-medium">{r.username || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{r.organization || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{r.model}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right">{safeNum(r.aic_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right">{fmtCurrency(r.aic_gross_amount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right font-semibold">{fmtCurrency(r.net_amount)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {r.exceeds_quota === "TRUE" ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">
                              Over Quota
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                              Within Quota
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right text-[hsl(var(--muted-foreground))]">
                          {safeNum(r.total_monthly_quota) > 0 ? safeNum(r.total_monthly_quota).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-3">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-sm rounded-lg border hover:bg-[hsl(var(--accent))] disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm text-[hsl(var(--muted-foreground))]">
                  Page {pagination.page} of {pagination.totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                  disabled={page >= pagination.totalPages}
                  className="px-3 py-1.5 text-sm rounded-lg border hover:bg-[hsl(var(--accent))] disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>

          {/* Info: AI Credits are User-Level */}
          <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-4">
            <p className="text-sm text-blue-700 dark:text-blue-400 flex items-center gap-2">
              <Users className="h-4 w-4 shrink-0" />
              <span>
                <strong>AI credits are user-level charges.</strong> This page prioritizes AI-credit fields from billing exports
                (<code className="mx-1">aic_quantity</code>, <code className="mx-1">aic_gross_amount</code>). AI credits are available starting{" "}
                <strong className="mx-1">2026-06-01</strong>, so earlier months are intentionally excluded from AI credit calculations.
              </span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
