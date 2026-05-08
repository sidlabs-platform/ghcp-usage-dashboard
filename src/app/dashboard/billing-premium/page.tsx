"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
}

interface FilterOptions {
  models: string[];
  organizations: string[];
  users: string[];
}

const fmtCurrency = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;
};

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
        <PageHeader title="Premium Requests" description="Premium model request tracking, quotas, and per-user breakdown" />
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
        <PageHeader title="Premium Requests" description="Premium model request tracking, quotas, and per-user breakdown" />
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
      <PageHeader title="Premium Requests" description="Premium model request tracking, quotas, and per-user breakdown">
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/premium",
            extraParams: buildParams(),
            columns: csvColumns,
            dataExtractor: (json) => json.records,
            filename: `premium-requests-${days}d`,
            metadata: {
              reportName: "Premium Requests Report",
              dateRange: `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          pdf={{
            sectionRefs: [kpiRef, trendRef, chartsRef, tableRef],
            title: "Premium Requests Report",
            filename: `premium-requests-${days}d`,
            metadata: {
              reportName: "Premium Requests Report",
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
          <p className="text-xl font-semibold mb-2">No premium request data {hasFilter ? "for this filter" : ""}</p>
          <p className="text-sm max-w-md mx-auto">
            {hasFilter
              ? "Try adjusting your team/org filter or date range."
              : "Premium request data will appear after a billing sync. Premium request reporting is available from October 2025 onward."}
          </p>
        </div>
      )}

      {hasData && kpis && (
        <>
          {/* KPI Cards */}
          <div ref={kpiRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Total Premium Requests"
              value={kpis.totalRequests}
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
              value={fmtCurrency(kpis.totalNet)}
              format="raw"
              icon={<Users className="h-4 w-4" />}
              subtitle="Net premium request cost"
            />
          </div>

          {/* Daily Trend */}
          {dailyTrend.length > 0 && (
            <div ref={trendRef} className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Daily Trend</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                <span className="text-purple-500">● Requests</span>{" · "}
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
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Request volume and cost per AI model</p>
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
                <p className="text-sm text-[hsl(var(--muted-foreground))]">Premium request quota utilization by user</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-[hsl(var(--accent))]/30">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Username</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Org</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase">Total Requests</th>
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
                        : u.utilization_pct > 80
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-emerald-600 dark:text-emerald-400";
                      return (
                        <tr key={u.username} className="hover:bg-[hsl(var(--accent))]/20 transition-colors">
                          <td className="px-4 py-2.5 font-medium">{u.username}</td>
                          <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))]">{u.organization || "—"}</td>
                          <td className="px-4 py-2.5 text-right">{safeNum(u.total_requests).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{safeNum(u.within_quota).toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400">{safeNum(u.over_quota) > 0 ? safeNum(u.over_quota).toLocaleString() : "—"}</td>
                          <td className="px-4 py-2.5 text-right text-[hsl(var(--muted-foreground))]">{safeNum(u.quota_limit) > 0 ? safeNum(u.quota_limit).toLocaleString() : "—"}</td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${utilColor}`}>
                            {safeNum(u.utilization_pct) > 0 ? `${safeNum(u.utilization_pct).toFixed(1)}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-semibold">{fmtCurrency(u.total_net)}</td>
                        </tr>
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
              {(search || selectedModel.length || selectedOrg.length || exceedsQuota) && (
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
                    <SortHeader col="quantity" label="Qty" />
                    <SortHeader col="gross_amount" label="Gross" />
                    <SortHeader col="net_amount" label="Net" />
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
                    records.map((r, i) => (
                      <tr key={i} className="hover:bg-[hsl(var(--accent))]/20 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs">{r.date}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap font-medium">{r.username || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{r.organization || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{r.model}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right">{safeNum(r.quantity).toLocaleString()}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right">{fmtCurrency(r.gross_amount)}</td>
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

          {/* Info: Premium Requests are User-Level */}
          <div className="rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-4">
            <p className="text-sm text-blue-700 dark:text-blue-400 flex items-center gap-2">
              <Users className="h-4 w-4 shrink-0" />
              <span>
                <strong>Premium requests are user-level charges.</strong> Each request is attributed to the individual user
                who made it. Users exceeding their monthly quota will incur additional charges billed to the organization.
              </span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
