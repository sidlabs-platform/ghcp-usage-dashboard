"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { Receipt, DollarSign, TrendingDown, Building2, Users, Package } from "lucide-react";
import { safeNum } from "@/lib/utils";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { BillingOverviewKPIs, BillingProductBreakdown, BillingOrgBreakdown, BillingUserBreakdown, BillingCostCenterBreakdown } from "@/lib/types/billing";

const BillingCostTrendChart = dynamic(
  () => import("@/components/charts/BillingCostTrendChart").then(m => ({ default: m.BillingCostTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingProductBreakdownChart = dynamic(
  () => import("@/components/charts/BillingProductBreakdownChart").then(m => ({ default: m.BillingProductBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingOrgBreakdownChart = dynamic(
  () => import("@/components/charts/BillingOrgBreakdownChart").then(m => ({ default: m.BillingOrgBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingChargeScopeChart = dynamic(
  () => import("@/components/charts/BillingChargeScopeChart").then(m => ({ default: m.BillingChargeScopeChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingUserBreakdownChart = dynamic(
  () => import("@/components/charts/BillingUserBreakdownChart").then(m => ({ default: m.BillingUserBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const BillingCostCenterChart = dynamic(
  () => import("@/components/charts/BillingCostCenterChart").then(m => ({ default: m.BillingCostCenterChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

interface DailyTrend {
  day: string;
  total_net: number;
  user_net: number;
  org_net: number;
}

const fmtCurrency = (v: number) => {
  const n = safeNum(v);
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`;
};

export default function BillingOverviewPage() {
  const { days } = useDateRange();
  const { hasFilter, buildScopeParams, selectedEntTeams, selectedOrgTeams, selectedOrgs: scopeOrgs } = useScope();
  const [kpis, setKpis] = useState<BillingOverviewKPIs | null>(null);
  const [dailyTrend, setDailyTrend] = useState<DailyTrend[]>([]);
  const [productBreakdown, setProductBreakdown] = useState<BillingProductBreakdown[]>([]);
  const [orgBreakdown, setOrgBreakdown] = useState<BillingOrgBreakdown[]>([]);
  const [userBreakdown, setUserBreakdown] = useState<BillingUserBreakdown[]>([]);
  const [costCenterBreakdown, setCostCenterBreakdown] = useState<BillingCostCenterBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const breakdownRef = useRef<HTMLDivElement>(null);
  const insightsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ days: String(days) });
      const scopeParams = buildScopeParams();
      scopeParams.forEach((v, k) => params.set(k, v));

      const res = await fetch(`/api/billing/overview?${params.toString()}`);
      const data = await res.json();
      if (data.enabled === false) {
        setEnabled(false);
        return;
      }
      setKpis(data.kpis);
      setDailyTrend(data.dailyTrend || []);
      setProductBreakdown(data.productBreakdown || []);
      setOrgBreakdown(data.orgBreakdown || []);
      setUserBreakdown(data.userBreakdown || []);
      setCostCenterBreakdown(data.costCenterBreakdown || []);
    } catch (err) {
      console.error("Failed to load billing overview:", err);
    } finally {
      setLoading(false);
    }
  }, [days, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (!enabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Billing" description="Enterprise billing reports" />
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <Receipt className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-xl font-semibold mb-2">Billing reports are disabled</p>
          <p className="text-sm max-w-md mx-auto">
            Enable billing in <code className="text-xs bg-[hsl(var(--accent))] px-1 py-0.5 rounded">dashboard-config.json</code> and
            ensure your token has &quot;Enterprise administration&quot; permissions.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Billing" description="Enterprise billing reports" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const hasData = kpis && (kpis.totalNet > 0 || kpis.totalGross > 0);

  const scopeLabel = hasFilter
    ? `Filtered: ${[...selectedEntTeams, ...selectedOrgTeams, ...scopeOrgs].join(", ")}`
    : undefined;

  return (
    <div className="space-y-8">
      <PageHeader title="Billing" description="Enterprise billing overview — metered usage and cost analytics">
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef, breakdownRef, insightsRef],
            title: "Billing Overview",
            filename: `billing-overview-${days}d`,
            metadata: {
              reportName: "Billing Overview",
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
          📊 Showing filtered results: <strong>{scopeLabel}</strong>
        </div>
      )}

      {!hasData && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <Receipt className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-xl font-semibold mb-2">No billing data {hasFilter ? "for this filter" : "yet"}</p>
          <p className="text-sm mb-4 max-w-md mx-auto">
            {hasFilter
              ? "Try adjusting your team/org filter or date range."
              : "Billing data will appear after a sync. Trigger a sync from the header to fetch billing reports from GitHub."}
          </p>
        </div>
      )}

      {hasData && kpis && (
        <>
          {/* KPI Cards */}
          <div ref={kpiRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Total Net Cost"
              value={fmtCurrency(kpis.totalNet)}
              format="raw"
              icon={<DollarSign className="h-4 w-4" />}
              subtitle={`Last ${days} days`}
            />
            <MetricCard
              title="Total Gross"
              value={fmtCurrency(kpis.totalGross)}
              format="raw"
              icon={<Receipt className="h-4 w-4" />}
              subtitle={`Discount: ${fmtCurrency(kpis.totalDiscount)}`}
            />
            <MetricCard
              title="User-Level Charges"
              value={fmtCurrency(kpis.userChargesNet)}
              format="raw"
              icon={<Users className="h-4 w-4" />}
              subtitle="Copilot seats, premium requests"
            />
            <MetricCard
              title="Org-Level Charges"
              value={fmtCurrency(kpis.orgChargesNet)}
              format="raw"
              icon={<Building2 className="h-4 w-4" />}
              subtitle="Actions, Packages, Codespaces, LFS"
            />
          </div>

          {/* Charts Row */}
          <div ref={chartsRef} className="grid gap-6 lg:grid-cols-3">
            {/* Cost Trend — takes 2 columns */}
            <div className="lg:col-span-2">
              <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
                <h3 className="text-lg font-semibold mb-1">Cost Trend</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                  Daily net cost breakdown: <span className="text-blue-500">● User</span> vs <span className="text-emerald-500">● Org</span>
                </p>
                <BillingCostTrendChart data={dailyTrend} />
              </div>
            </div>

            {/* User vs Org Split */}
            <div>
              <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
                <h3 className="text-lg font-semibold mb-1">Charge Scope Split</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">User vs organization charges</p>
                <BillingChargeScopeChart userNet={kpis.userChargesNet} orgNet={kpis.orgChargesNet} />
              </div>
            </div>
          </div>

          {/* Breakdown Section */}
          <div ref={breakdownRef} className="grid gap-6 lg:grid-cols-2">
            {/* By Product */}
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Cost by Product</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500 inline-block" /> User</span>
                {" · "}
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /> Org</span>
              </p>
              <BillingProductBreakdownChart data={productBreakdown} />
            </div>

            {/* By Organization */}
            <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
              <h3 className="text-lg font-semibold mb-1">Cost by Organization</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Top organizations by net cost</p>
              <BillingOrgBreakdownChart data={orgBreakdown} />
            </div>
          </div>

          {/* New Insights: Top Users & Cost Centers */}
          <div ref={insightsRef} className="grid gap-6 lg:grid-cols-2">
            {/* Top Users/Spenders */}
            {userBreakdown.length > 0 && (
              <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
                <h3 className="text-lg font-semibold mb-1">Top Spenders</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Users with highest net cost</p>
                <BillingUserBreakdownChart data={userBreakdown} limit={15} />
              </div>
            )}

            {/* Cost Center Breakdown */}
            {costCenterBreakdown.length > 0 && (
              <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
                <h3 className="text-lg font-semibold mb-1">Cost by Cost Center</h3>
                <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">Spending distribution across cost centers</p>
                <BillingCostCenterChart data={costCenterBreakdown} />
              </div>
            )}
          </div>

          {/* Charge Scope Legend */}
          <div className="rounded-xl border bg-[hsl(var(--card))] p-6">
            <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Package className="h-5 w-5" />
              Understanding Charge Scopes
            </h3>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 p-4">
                <h4 className="font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-2 mb-2">
                  <Users className="h-4 w-4" /> User-Level Charges
                </h4>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  Billed per individual user. Includes <strong>GitHub Copilot</strong> seat licenses
                  and <strong>Premium Requests</strong> (AI model usage beyond included quota).
                </p>
              </div>
              <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 p-4">
                <h4 className="font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-2 mb-2">
                  <Building2 className="h-4 w-4" /> Org-Level Charges
                </h4>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  Billed to the organization, not individual users. Includes <strong>Actions</strong> (compute &amp; storage),
                  <strong> Codespaces</strong>, <strong>Packages</strong>, <strong>Git LFS</strong>,
                  <strong> Shared Storage</strong>, and <strong>Advanced Security</strong>.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
