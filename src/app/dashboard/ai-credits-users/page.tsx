"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { Zap, Users, AlertTriangle, Wallet, Search } from "lucide-react";
import { safeNum } from "@/lib/utils";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { PremiumRequestUserSummary } from "@/lib/types/billing";

interface PremiumKPIs {
  totalRequests: number;
  usersOverQuota: number;
  totalUsers: number;
  totalNet: number;
  totalAiCredits: number;
  totalAicGross: number;
}

type SortKey =
  | "username"
  | "organization"
  | "total_aic_quantity"
  | "within_quota"
  | "over_quota"
  | "quota_limit"
  | "utilization_pct"
  | "total_aic_gross";

const fmtCurrency = (v: number) =>
  safeNum(v).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCredits = (v: number) => safeNum(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function AiCreditsUsersPage() {
  const { days } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs: scopeOrgs } = useScope();

  const [kpis, setKpis] = useState<PremiumKPIs | null>(null);
  const [userSummary, setUserSummary] = useState<PremiumRequestUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("total_aic_quantity");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const kpiRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    p.set("days", String(days));
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => p.set(k, v));
    return p;
  }, [days, buildScopeParams]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/billing/premium/summary?${buildParams().toString()}`);
      const data = await res.json();
      if (data.enabled === false) {
        setEnabled(false);
        return;
      }
      setEnabled(true);
      setKpis(data.kpis || null);
      setUserSummary(data.userSummary || []);
    } catch (err) {
      console.error("Failed to load AI credits per user:", err);
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text columns default to ascending, numeric columns to descending.
      setSortDir(key === "username" || key === "organization" ? "asc" : "desc");
    }
  };

  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? userSummary.filter(
          (u) =>
            u.username.toLowerCase().includes(q) ||
            (u.organization || "").toLowerCase().includes(q)
        )
      : userSummary;

    const sorted = [...filtered].sort((a, b) => {
      let cmp: number;
      if (sortKey === "username" || sortKey === "organization") {
        cmp = (a[sortKey] || "").localeCompare(b[sortKey] || "");
      } else {
        cmp = safeNum(a[sortKey]) - safeNum(b[sortKey]);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [userSummary, search, sortKey, sortDir]);

  const csvColumns = useMemo(() => [
    { key: "username", label: "User" },
    { key: "organization", label: "Organization" },
    { key: "total_aic_quantity", label: "AI Credits" },
    { key: "within_quota", label: "Within Quota" },
    { key: "over_quota", label: "Over Quota" },
    { key: "quota_limit", label: "Quota Limit" },
    { key: "utilization_pct", label: "Utilization %" },
    { key: "total_aic_gross", label: "Cost (USD)" },
  ], []);

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="AI Credits by User" description="AI credits consumed by every user, sortable by any column" />
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
        <PageHeader title="AI Credits by User" description="AI credits consumed by every user, sortable by any column" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const hasData = userSummary.length > 0;

  const SortHeader = ({ col, label, align = "left" }: { col: SortKey; label: string; align?: "left" | "right" }) => (
    <th
      className={`px-4 py-3 ${align === "right" ? "text-right" : "text-left"} text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider select-none`}
      aria-sort={sortKey === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => handleSort(col)}
        className={`flex items-center gap-1 uppercase tracking-wider cursor-pointer hover:text-[hsl(var(--foreground))] focus:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--primary))]/40 rounded ${align === "right" ? "justify-end w-full" : ""}`}
      >
        {label}
        {sortKey === col && <span>{sortDir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );

  return (
    <div className="space-y-8">
      <PageHeader title="AI Credits by User" description="AI credits consumed by every user, sortable by any column">
        <ExportMenu
          csv={{
            fetchUrl: "/api/billing/premium/summary",
            extraParams: buildParams(),
            columns: csvColumns,
            dataExtractor: (json) => json.userSummary,
            filename: `ai-credits-by-user-${days}d`,
            metadata: {
              reportName: "AI Credits by User",
              dateRange: `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          pdf={{
            sectionRefs: [kpiRef, tableRef],
            title: "AI Credits by User",
            filename: `ai-credits-by-user-${days}d`,
            metadata: {
              reportName: "AI Credits by User",
              dateRange: `Last ${days} days`,
              ...(hasFilter && { teams: [...selectedEntTeams, ...selectedOrgTeams].join(", "), orgs: scopeOrgs.join(", ") }),
            },
          }}
          isReady={hasData}
        />
      </PageHeader>

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

      {hasData && (
        <>
          <div ref={kpiRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Total AI Credits"
              value={fmtCredits(kpis?.totalAiCredits || kpis?.totalRequests || 0)}
              format="raw"
              icon={<Zap className="h-4 w-4" />}
              subtitle={`Last ${days} days`}
              accent="violet"
            />
            <MetricCard
              title="Users"
              value={kpis?.totalUsers ?? userSummary.length}
              icon={<Users className="h-4 w-4" />}
              subtitle="With AI credit usage"
              accent="blue"
            />
            <MetricCard
              title="Users Over Quota"
              value={kpis?.usersOverQuota ?? 0}
              icon={<AlertTriangle className="h-4 w-4" />}
              subtitle="Exceeded monthly quota"
              accent="amber"
            />
            <MetricCard
              title="Total Cost"
              value={fmtCurrency(kpis?.totalAicGross || kpis?.totalNet || 0)}
              format="raw"
              icon={<Wallet className="h-4 w-4" />}
              subtitle="AI credit billed cost"
              accent="green"
            />
          </div>

          <div ref={tableRef} className="rounded-xl border bg-[hsl(var(--card))] overflow-hidden">
            <div className="px-6 py-4 border-b flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold">AI Credits Consumed by User</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  {displayRows.length} of {userSummary.length} users — click any column header to sort
                </p>
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[hsl(var(--muted-foreground))]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search user or org..."
                  className="w-full pl-9 pr-3 py-2 rounded-lg border bg-transparent text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--primary))]/20"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-[hsl(var(--accent))]/30">
                  <tr>
                    <SortHeader col="username" label="User" />
                    <SortHeader col="organization" label="Org" />
                    <SortHeader col="total_aic_quantity" label="AI Credits" align="right" />
                    <SortHeader col="within_quota" label="Within Quota" align="right" />
                    <SortHeader col="over_quota" label="Over Quota" align="right" />
                    <SortHeader col="quota_limit" label="Quota Limit" align="right" />
                    <SortHeader col="utilization_pct" label="Utilization" align="right" />
                    <SortHeader col="total_aic_gross" label="Cost" align="right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[hsl(var(--border))]">
                  {displayRows.map((u) => {
                    const util = safeNum(u.utilization_pct);
                    const utilColor = util > 100
                      ? "text-red-600 dark:text-red-400"
                      : util > 80
                        ? "text-yellow-600 dark:text-yellow-400"
                        : "text-emerald-600 dark:text-emerald-400";
                    return (
                      <tr key={`${u.username}::${u.organization || ""}`} className="hover:bg-[hsl(var(--accent))]/20 transition-colors">
                        <td className="px-4 py-2.5 font-medium">{u.username}</td>
                        <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))]">{u.organization || "—"}</td>
                        <td className="px-4 py-2.5 text-right font-semibold">{fmtCredits(u.total_aic_quantity || u.total_requests)}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-600 dark:text-emerald-400">{fmtCredits(u.within_quota)}</td>
                        <td className="px-4 py-2.5 text-right text-red-600 dark:text-red-400">{safeNum(u.over_quota) > 0 ? fmtCredits(u.over_quota) : "—"}</td>
                        <td className="px-4 py-2.5 text-right text-[hsl(var(--muted-foreground))]">{safeNum(u.quota_limit) > 0 ? fmtCredits(u.quota_limit) : "—"}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${utilColor}`}>{util > 0 ? `${util.toFixed(1)}%` : "—"}</td>
                        <td className="px-4 py-2.5 text-right font-semibold">{fmtCurrency(u.total_aic_gross || u.total_net)}</td>
                      </tr>
                    );
                  })}
                  {displayRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-[hsl(var(--muted-foreground))]">
                        No users match &ldquo;{search}&rdquo;.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
