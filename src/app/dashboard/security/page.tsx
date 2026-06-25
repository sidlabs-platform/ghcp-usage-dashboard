"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ShieldCheck, ShieldAlert, Bug, Key, Sparkles, TrendingDown } from "lucide-react";
import { safeNum } from "@/lib/utils";
import { ExportMenu } from "@/components/ui/ExportMenu";

const SecurityTrendChart = dynamic(
  () => import("@/components/charts/SecurityTrendChart").then(m => ({ default: m.SecurityTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const SeverityBreakdownChart = dynamic(
  () => import("@/components/charts/SeverityBreakdownChart").then(m => ({ default: m.SeverityBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const AutofixInsightChart = dynamic(
  () => import("@/components/charts/AutofixInsightChart").then(m => ({ default: m.AutofixInsightChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

interface SecurityOverviewData {
  overview: {
    codeScanning: { totalOpen: number; criticalOpen: number; highOpen: number; fixedLast30d: number; openedLast30d: number; autofixAvailable: number; autofixCommitted: number; mttrDays: number | null; fixRate: number } | null;
    dependabot: { totalOpen: number; criticalOpen: number; highOpen: number; fixedLast30d: number; openedLast30d: number; mttrDays: number | null; fixRate: number; topEcosystems: { ecosystem: string; count: number }[] } | null;
    secretScanning: { totalOpen: number; resolvedLast30d: number; openedLast30d: number; mttrDays: number | null; resolutionBreakdown: Record<string, number> } | null;
  };
  summary: {
    totalOpenAlerts: number;
    criticalAlerts: number;
    highAlerts: number;
    fixedLast30d: number;
    openedLast30d: number;
    overallFixRate: number;
    trendDirection: "up" | "down" | "flat";
    autofixAdoptionRate: number;
  };
  mttrFormatted: { codeScanning: string; dependabot: string; secretScanning: string };
}

interface CategoryData {
  enabled: boolean;
  daily: { day: string; opened: number; fixed: number; resolved?: number; total_open: number }[];
  fixRate: number;
  severity: { severity: string; count: number; color: string }[];
  trend: "up" | "down" | "flat";
  mttr: number | null;
  mttrFormatted: string;
  autofix?: { rate: number; totalAvailable: number; totalCommitted: number };
  topEcosystems?: { ecosystem: string; count: number }[];
}

export default function SecurityPage() {
  const { days } = useDateRange();
  const { selectedOrgs } = useScope();
  const [overview, setOverview] = useState<SecurityOverviewData | null>(null);
  const [csData, setCsData] = useState<CategoryData | null>(null);
  const [depData, setDepData] = useState<CategoryData | null>(null);
  const [ssData, setSsData] = useState<CategoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clear polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const kpiRef = useRef<HTMLDivElement>(null);
  const csRef = useRef<HTMLElement>(null);
  const depRef = useRef<HTMLElement>(null);
  const ssRef = useRef<HTMLElement>(null);

  const fetchData= useCallback(async () => {
    setLoading(true);
    try {
      // When an org is selected, use scope=org&scopeId=<org>
      const scopeParams = selectedOrgs.length === 1
        ? `&scope=org&scopeId=${encodeURIComponent(selectedOrgs[0])}`
        : "";

      const [overviewRes, csRes, depRes, ssRes] = await Promise.all([
        fetch(`/api/security/overview?days=${days}${scopeParams}`),
        fetch(`/api/security/code-scanning?days=${days}${scopeParams}`),
        fetch(`/api/security/dependabot?days=${days}${scopeParams}`),
        fetch(`/api/security/secret-scanning?days=${days}${scopeParams}`),
      ]);

      setOverview(await overviewRes.json());
      setCsData(await csRes.json());
      setDepData(await depRes.json());
      setSsData(await ssRes.json());
    } catch (err) {
      console.error("Failed to load security data:", err);
    } finally {
      setLoading(false);
    }
  }, [days, selectedOrgs]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const triggerSync = useCallback(async () => {
    setSyncing(true);
    setSyncStatus("Starting security data sync...");
    try {
      await fetch("/api/security/sync", { method: "POST" });
      setSyncStatus("Sync in progress — this may take a few minutes for the initial sync...");
      // Poll sync status
      pollIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/security/sync");
          const data = await res.json();
          if (!data.syncing) {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            setSyncing(false);
            setSyncStatus("Sync complete! Loading data...");
            await fetchData();
            setSyncStatus(null);
          }
        } catch {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setSyncing(false);
          setSyncStatus("Sync may still be running. Refresh the page to check.");
        }
      }, 5000);
    } catch (err) {
      setSyncing(false);
      setSyncStatus("Failed to start sync. Check server logs.");
    }
  }, [fetchData]);

  // Determine if we have any actual data
  const hasData = (csData?.enabled && csData?.daily?.length > 0) ||
    (depData?.enabled && depData?.daily?.length > 0) ||
    (ssData?.enabled && ssData?.daily?.length > 0);
  const anyEnabled = csData?.enabled || depData?.enabled || ssData?.enabled;

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Security" description="Code scanning, Dependabot, and secret scanning alert trends" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  const summary = overview?.summary;

  return (
    <div className="space-y-8">
      <PageHeader title="Security" description="Code scanning, Dependabot, and secret scanning alert trends">
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, csRef, depRef, ssRef],
            title: "Security Dashboard",
            filename: `security-report-${days}d`,
            metadata: {
              reportName: "Security Dashboard",
              dateRange: `Last ${days} days`,
              orgs: selectedOrgs.length > 0 ? selectedOrgs.join(", ") : undefined,
            },
          }}
          isReady={hasData}
        />
      </PageHeader>

      <ScopeFilter orgOnly />

      {/* Sync status banner */}
      {syncStatus && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950 p-4 text-sm flex items-center gap-2">
          {syncing && <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {syncStatus}
        </div>
      )}

      {/* No data state — prompt to sync */}
      {!loading && anyEnabled && !hasData && !syncing && (
        <div className="text-center py-16 text-[hsl(var(--muted-foreground))]">
          <ShieldCheck className="h-16 w-16 mx-auto mb-4 opacity-40" />
          <p className="text-xl font-semibold mb-2">No security data yet</p>
          <p className="text-sm mb-6 max-w-md mx-auto">
            Security metrics are enabled but no data has been synced. Run a sync to fetch
            code scanning, Dependabot, and secret scanning alerts from GitHub.
          </p>
          <button
            onClick={triggerSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-lg bg-[hsl(var(--primary))] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            Sync Security Data
          </button>
          <p className="text-xs mt-3 text-[hsl(var(--muted-foreground))]">
            You can also trigger this via the main Sync button or POST /api/security/sync
          </p>
        </div>
      )}

      {/* KPI Cards — only show when we have data */}
      {hasData && (
      <div ref={kpiRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Open Alerts"
          value={summary?.totalOpenAlerts || 0}
          icon={<ShieldAlert className="h-4 w-4" />}
          subtitle={`${summary?.trendDirection === "down" ? "↓ Trending down" : summary?.trendDirection === "up" ? "↑ Trending up" : "→ Stable"}`}
        />
        <MetricCard
          title="Critical Alerts"
          value={summary?.criticalAlerts || 0}
          icon={<ShieldCheck className="h-4 w-4" />}
          subtitle={`${summary?.highAlerts || 0} high severity`}
        />
        <MetricCard
          title="Fix Rate"
          value={summary?.overallFixRate || 0}
          format="percent"
          icon={<TrendingDown className="h-4 w-4" />}
          subtitle={`${summary?.fixedLast30d || 0} fixed last 30d`}
        />
        <MetricCard
          title="Autofix Adoption"
          value={summary?.autofixAdoptionRate || 0}
          format="percent"
          icon={<Sparkles className="h-4 w-4" />}
          subtitle="Copilot Autofix usage"
        />
      </div>
      )}

      {/* Data sections — only show when we have data */}
      {hasData && (<>

      {/* Code Scanning Section */}
      {csData?.enabled && (
        <section ref={csRef} className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Bug className="h-5 w-5" /> Code Scanning
            <span className="text-sm font-normal text-[hsl(var(--muted-foreground))]">
              MTTR: {csData.mttrFormatted} · Fix Rate: {safeNum(csData.fixRate).toFixed(1)}%
            </span>
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <SecurityTrendChart
              title="Code Scanning Alerts Over Time"
              data={csData.daily.map(d => ({ day: d.day, opened: d.opened, fixed: d.fixed, total_open: d.total_open }))}
            />
            <div className="grid gap-4">
              <SeverityBreakdownChart data={csData.severity} />
              {csData.autofix && (
                <AutofixInsightChart
                  available={csData.autofix.totalAvailable}
                  committed={csData.autofix.totalCommitted}
                  rate={csData.autofix.rate}
                />
              )}
            </div>
          </div>
        </section>
      )}

      {/* Dependabot Section */}
      {depData?.enabled && (
        <section ref={depRef} className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" /> Dependabot
            <span className="text-sm font-normal text-[hsl(var(--muted-foreground))]">
              MTTR: {depData.mttrFormatted} · Fix Rate: {safeNum(depData.fixRate).toFixed(1)}%
            </span>
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <SecurityTrendChart
              title="Dependabot Alerts Over Time"
              data={depData.daily.map(d => ({ day: d.day, opened: d.opened, fixed: d.fixed, total_open: d.total_open }))}
            />
            <SeverityBreakdownChart data={depData.severity} />
          </div>
          {depData.topEcosystems && depData.topEcosystems.length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-2 text-[hsl(var(--muted-foreground))]">Top Vulnerable Ecosystems</h3>
              <div className="flex gap-3 flex-wrap">
                {depData.topEcosystems.map(e => (
                  <span key={e.ecosystem} className="inline-flex items-center gap-1.5 rounded-full bg-[hsl(var(--accent))] px-3 py-1 text-sm">
                    <span className="font-medium">{e.ecosystem}</span>
                    <span className="text-[hsl(var(--muted-foreground))]">{e.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Secret Scanning Section */}
      {ssData?.enabled && (
        <section ref={ssRef} className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Key className="h-5 w-5" /> Secret Scanning
            <span className="text-sm font-normal text-[hsl(var(--muted-foreground))]">
              MTTR: {ssData.mttrFormatted} · Fix Rate: {safeNum(ssData.fixRate).toFixed(1)}%
            </span>
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <SecurityTrendChart
              title="Secret Scanning Alerts Over Time"
              data={ssData.daily.map(d => ({ day: d.day, opened: d.opened, fixed: d.resolved || 0, total_open: d.total_open }))}
              fixedLabel="Resolved"
            />
            <SeverityBreakdownChart data={ssData.severity || []} />
          </div>
        </section>
      )}

      </>)}

      {/* Empty state — metrics disabled */}
      {!anyEnabled && (
        <div className="text-center py-12 text-[hsl(var(--muted-foreground))]">
          <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="text-lg font-medium">No security metrics enabled</p>
          <p className="text-sm">Enable code scanning, Dependabot, or secret scanning in dashboard-config.json</p>
        </div>
      )}
    </div>
  );
}
