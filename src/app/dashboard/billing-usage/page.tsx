"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { periodLabel } from "@/lib/date/month-range";
import { DollarSign, Search, Filter, Building2, Users, ChevronDown, X } from "lucide-react";
import { safeNum } from "@/lib/utils";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { BillingUsageRecord, ChargeScope, BillingCostCenterBreakdown, BillingRepositoryBreakdown } from "@/lib/types/billing";

const BillingCostTrendChart = dynamic(
  () => import("@/components/charts/BillingCostTrendChart").then(m => ({ default: m.BillingCostTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingCostCenterChart = dynamic(
  () => import("@/components/charts/BillingCostCenterChart").then(m => ({ default: m.BillingCostCenterChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingRepoBreakdownChart = dynamic(
  () => import("@/components/charts/BillingRepoBreakdownChart").then(m => ({ default: m.BillingRepoBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

interface PaginationInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

interface FilterOptions {
  products: string[];
  skus: string[];
  organizations: string[];
  costCenters: string[];
}

const CHARGE_SCOPE_BADGE: Record<string, { label: string; color: string }> = {
  user: { label: "User", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
  org: { label: "Org", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
};

const fmtCurrency = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;
};

export default function MeteredUsagePage() {
  const { days, mode, period } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs: scopeOrgs } = useScope();
  const [records, setRecords] = useState<BillingUsageRecord[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
  const [filterOptions, setFilterOptions] = useState<FilterOptions>({ products: [], skus: [], organizations: [], costCenters: [] });
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  // Filters
  const [search, setSearch] = useState("");
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [selectedCostCenter, setSelectedCostCenter] = useState("");
  const [chargeScope, setChargeScope] = useState<ChargeScope | "">("");
  const [sort, setSort] = useState("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);

  // Trend data
  const [trendData, setTrendData] = useState<{ day: string; total_net: number; user_net: number; org_net: number }[]>([]);
  // Insight data
  const [costCenterData, setCostCenterData] = useState<BillingCostCenterBreakdown[]>([]);
  const [repoData, setRepoData] = useState<BillingRepositoryBreakdown[]>([]);

  const tableRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const insightsRef = useRef<HTMLDivElement>(null);

  // Billing is billed by calendar month, so a selected month is the honest
  // window — and the only basis on which this page can agree with Billing and
  // License & AI Credits, which are both keyed by month.
  const activePeriod = mode === "month" && period ? period : null;
  const windowParam = useMemo<[string, string]>(
    () => (activePeriod ? ["period", activePeriod] : ["days", String(days)]),
    [activePeriod, days],
  );
  const windowLabel = activePeriod ? periodLabel(activePeriod) : `last ${days} days`;
  const exportSlug = activePeriod ?? `${days}d`;

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    p.set(...windowParam);
    p.set("page", String(page));
    p.set("pageSize", "50");
    p.set("sort", sort);
    p.set("sortDir", sortDir);
    if (search) p.set("search", search);
    if (selectedProducts.length) p.set("product", selectedProducts.join(","));
    if (selectedOrgs.length) p.set("organization", selectedOrgs.join(","));
    if (selectedCostCenter) p.set("costCenter", selectedCostCenter);
    if (chargeScope) p.set("chargeScope", chargeScope);
    // Merge scope params
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => p.set(k, v));
    return p;
  }, [windowParam, page, sort, sortDir, search, selectedProducts, selectedOrgs, selectedCostCenter, chargeScope, buildScopeParams]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = buildParams();
      const trendParams = new URLSearchParams();
      trendParams.set(...windowParam);
      trendParams.set("groupBy", "daily");
      if (chargeScope) trendParams.set("chargeScope", chargeScope);
      if (selectedProducts.length) trendParams.set("product", selectedProducts.join(","));
      if (selectedOrgs.length) trendParams.set("organization", selectedOrgs.join(","));
      if (selectedCostCenter) trendParams.set("costCenter", selectedCostCenter);
      if (search) trendParams.set("username", search);
      // Merge scope params into trend/insight requests
      const scopeParams = buildScopeParams();
      scopeParams.forEach((v, k) => trendParams.set(k, v));

      const costCenterParams = new URLSearchParams();
      costCenterParams.set(...windowParam);
      costCenterParams.set("groupBy", "costCenter");
      scopeParams.forEach((v, k) => costCenterParams.set(k, v));
      if (selectedProducts.length) costCenterParams.set("product", selectedProducts.join(","));
      if (selectedOrgs.length) costCenterParams.set("organization", selectedOrgs.join(","));
      if (chargeScope) costCenterParams.set("chargeScope", chargeScope);

      const repoParams = new URLSearchParams();
      repoParams.set(...windowParam);
      repoParams.set("groupBy", "repository");
      scopeParams.forEach((v, k) => repoParams.set(k, v));
      if (selectedProducts.length) repoParams.set("product", selectedProducts.join(","));
      if (selectedOrgs.length) repoParams.set("organization", selectedOrgs.join(","));
      if (chargeScope) repoParams.set("chargeScope", chargeScope);

      const [usageRes, trendRes, ccRes, repoRes] = await Promise.all([
        fetch(`/api/billing/usage?${params.toString()}`),
        fetch(`/api/billing/usage/summary?${trendParams.toString()}`),
        fetch(`/api/billing/usage/summary?${costCenterParams.toString()}`),
        fetch(`/api/billing/usage/summary?${repoParams.toString()}`),
      ]);
      const usageData = await usageRes.json();
      if (usageData.enabled === false) { setEnabled(false); return; }

      setRecords(usageData.records || []);
      setPagination(usageData.pagination || { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
      setFilterOptions(usageData.filterOptions || { products: [], skus: [], organizations: [], costCenters: [] });

      const trendJson = await trendRes.json();
      if (trendJson.data) {
        // Build daily trend from aggregate data
        const dayMap = new Map<string, { day: string; total_net: number; user_net: number; org_net: number }>();
        for (const d of trendJson.data) {
          const existing = dayMap.get(d.day) || { day: d.day, total_net: 0, user_net: 0, org_net: 0 };
          existing.total_net += d.total_net;
          if (d.charge_scope === "user") existing.user_net += d.total_net;
          else existing.org_net += d.total_net;
          dayMap.set(d.day, existing);
        }
        setTrendData(Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day)));
      }

      const ccJson = await ccRes.json();
      setCostCenterData(ccJson.data || []);

      const repoJson = await repoRes.json();
      setRepoData(repoJson.data || []);
    } catch (err) {
      console.error("Failed to load metered usage:", err);
    } finally {
      setLoading(false);
    }
  }, [buildParams, windowParam, chargeScope, selectedProducts, selectedOrgs, selectedCostCenter, search, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Reset page when filters change (including scope)
  useEffect(() => { setPage(1); }, [search, selectedProducts, selectedOrgs, selectedCostCenter, chargeScope, sort, sortDir, hasFilter, selectedEntTeams, selectedOrgTeams, scopeOrgs]);

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
    { key: "applied_cost_per_quantity", label: "Cost/Unit" },
    { key: "gross_amount", label: "Gross Amount" },
    { key: "discount_amount", label: "Discount" },
    { key: "net_amount", label: "Net Amount" },
    { key: "organization", label: "Organization" },
    { key: "repository", label: "Repository" },
    { key: "username", label: "Username" },
    { key: "workflow_path", label: "Workflow Path" },
    { key: "cost_center_name", label: "Cost Center" },
    { key: "charge_scope", label: "Charge Scope" },
  ], []);

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Metered Usage" description="Detailed metered usage records by product, org, and repository" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <DollarSign className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-sm">Enable billing in <code className="text-xs bg-[hsl(var(--accent))] px-1 py-0.5 rounded">dashboard-config.json</code>.</p>
        </div>
      </div>
    );
  }

  const SortHeader = ({ col, label }: { col: string; label: string }) => (
    <th
      scope="col"
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
      <PageHeader title="Metered Usage" description="Detailed metered usage records by product, org, and repository">
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/usage",
            extraParams: buildParams(),
            columns: csvColumns,
            dataExtractor: (json) => json.records,
            filename: `metered-usage-${exportSlug}`,
            metadata: {
              reportName: "Metered Usage Report",
              dateRange: activePeriod ? periodLabel(activePeriod) : `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          pdf={{
            sectionRefs: [chartRef, insightsRef, tableRef],
            title: "Metered Usage Report",
            filename: `metered-usage-${exportSlug}`,
            metadata: {
              reportName: "Metered Usage Report",
              dateRange: activePeriod ? periodLabel(activePeriod) : `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          isReady={!loading && records.length > 0}
        />
      </PageHeader>

      {/* Polite live region for screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {!loading && `Updated: ${pagination.totalItems} metered usage records, ${windowLabel}`}
      </div>

      {/* Filter Bar */}
      <div className="rounded-xl border bg-[hsl(var(--card))] p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <label htmlFor="metered-search" className="sr-only">Search product, SKU, org, or user</label>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
            <input
              id="metered-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search product, SKU, org, user..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border bg-transparent text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]/20"
            />
          </div>

          {/* Product filter */}
          <label htmlFor="metered-product-filter" className="sr-only">Filter by product</label>
          <select
            id="metered-product-filter"
            className="rounded-lg border bg-transparent px-3 py-2 text-sm"
            value={selectedProducts[0] || ""}
            onChange={(e) => setSelectedProducts(e.target.value ? [e.target.value] : [])}
          >
            <option value="">All Products</option>
            {filterOptions.products.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          {/* Org filter */}
          <label htmlFor="metered-org-filter" className="sr-only">Filter by organization</label>
          <select
            id="metered-org-filter"
            className="rounded-lg border bg-transparent px-3 py-2 text-sm"
            value={selectedOrgs[0] || ""}
            onChange={(e) => setSelectedOrgs(e.target.value ? [e.target.value] : [])}
          >
            <option value="">All Organizations</option>
            {filterOptions.organizations.map(o => <option key={o} value={o}>{o}</option>)}
          </select>

          {/* Cost Center filter */}
          {filterOptions.costCenters.length > 0 && (
            <>
              <label htmlFor="metered-costcenter-filter" className="sr-only">Filter by cost center</label>
              <select
                id="metered-costcenter-filter"
                className="rounded-lg border bg-transparent px-3 py-2 text-sm"
                value={selectedCostCenter}
                onChange={(e) => setSelectedCostCenter(e.target.value)}
              >
                <option value="">All Cost Centers</option>
                {filterOptions.costCenters.map(cc => <option key={cc} value={cc}>{cc}</option>)}
              </select>
            </>
          )}

          {/* Charge Scope toggle */}
          <div className="flex rounded-lg border overflow-hidden">
            {[
              { value: "", label: "All" },
              { value: "user", label: "👤 User" },
              { value: "org", label: "🏢 Org" },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setChargeScope(opt.value as ChargeScope | "")}
                className={`px-3 py-2 text-xs font-medium transition-colors ${
                  chargeScope === opt.value
                    ? "bg-[hsl(var(--primary))] text-white"
                    : "hover:bg-[hsl(var(--accent))]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Clear filters */}
          {(search || selectedProducts.length || selectedOrgs.length || selectedCostCenter || chargeScope) && (
            <button
              onClick={() => { setSearch(""); setSelectedProducts([]); setSelectedOrgs([]); setSelectedCostCenter(""); setChargeScope(""); }}
              className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] flex items-center gap-1"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Usage Trend Chart */}
      {trendData.length > 0 && (
        <div ref={chartRef} className="rounded-xl border bg-[hsl(var(--card))] p-6">
          <h2 className="text-lg font-semibold mb-1">Usage Trend</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Daily net cost for current filters</p>
          <BillingCostTrendChart data={trendData} />
        </div>
      )}

      {/* Summary row */}
      <div className="flex items-center gap-4 text-sm text-[hsl(var(--muted-foreground))]">
        <span>{safeNum(pagination.totalItems).toLocaleString()} records</span>
        <span>·</span>
        <span>Page {pagination.page} of {pagination.totalPages || 1}</span>
      </div>

      {/* Data Table */}
      <div ref={tableRef} className="rounded-xl border bg-[hsl(var(--card))] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Metered Usage Records — {windowLabel}</caption>
            <thead className="border-b bg-[hsl(var(--accent))]/30">
              <tr>
                <SortHeader col="date" label="Date" />
                <SortHeader col="product" label="Product" />
                <SortHeader col="sku" label="SKU" />
                <SortHeader col="quantity" label="Qty" />
                <th scope="col" className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Unit</th>
                <SortHeader col="gross_amount" label="Gross" />
                <SortHeader col="discount_amount" label="Discount" />
                <SortHeader col="net_amount" label="Net" />
                <SortHeader col="organization" label="Org" />
                <SortHeader col="username" label="User" />
                <th scope="col" className="px-3 py-3 text-left text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider">Scope</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {loading ? (
                <tr><td colSpan={11} className="px-3 py-12 text-center text-[hsl(var(--muted-foreground))]">Loading...</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-12 text-center text-[hsl(var(--muted-foreground))]">No records found</td></tr>
              ) : (
                records.map((r, i) => {
                  const badge = CHARGE_SCOPE_BADGE[r.charge_scope] || CHARGE_SCOPE_BADGE.org;
                  return (
                    <tr key={i} className="hover:bg-[hsl(var(--accent))]/20 transition-colors">
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-xs">{r.date}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-medium">{r.product}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-xs text-[hsl(var(--muted-foreground))]">{r.sku}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right">{safeNum(r.quantity).toLocaleString()}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-xs">{r.unit_type}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right">{fmtCurrency(r.gross_amount)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right text-emerald-600 dark:text-emerald-400">{r.discount_amount > 0 ? `-${fmtCurrency(r.discount_amount)}` : "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right font-semibold">{fmtCurrency(r.net_amount)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.organization || "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{r.username || "—"}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.color}`}>
                          {badge.label}
                        </span>
                      </td>
                    </tr>
                  );
                })
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

      {/* Insight Charts: Cost Center & Repository Breakdown */}
      {(costCenterData.length > 0 || repoData.length > 0) && (
        <div ref={insightsRef} className="grid gap-6 lg:grid-cols-2">
          {costCenterData.length > 0 && (
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h2 className="text-lg font-semibold mb-1">Cost by Cost Center</h2>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Spending distribution across cost centers</p>
              <BillingCostCenterChart data={costCenterData} />
            </div>
          )}
          {repoData.length > 0 && (
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h2 className="text-lg font-semibold mb-1">Top Repositories by Cost</h2>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Highest-spending repositories</p>
              <BillingRepoBreakdownChart data={repoData} limit={15} />
            </div>
          )}
        </div>
      )}

      {/* Org-Level Charges Info */}
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 p-6">
        <h2 className="text-lg font-semibold mb-3 text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          About Org-Level Charges
        </h2>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">
          The following charges are billed at the <strong>organization level</strong> and are <em>not</em> attributed to specific users:
        </p>
        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          {[
            { name: "GitHub Actions", desc: "Compute minutes by runner type, storage" },
            { name: "Codespaces", desc: "Compute hours, storage" },
            { name: "Packages", desc: "Storage, data transfer" },
            { name: "Git LFS", desc: "Storage, bandwidth" },
          ].map(item => (
            <div key={item.name} className="rounded-lg bg-white/50 dark:bg-white/5 p-3 border">
              <p className="font-medium text-sm">{item.name}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
