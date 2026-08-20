"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton, KPISkeleton } from "@/components/states/ChartSkeleton";
import { Section } from "@/components/ui/Section";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { CHART_COLORS } from "@/lib/constants";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { OverviewData } from "@/lib/types/metrics";

const ActiveUsersTrendChart = dynamic(
  () => import("@/components/charts/ActiveUsersTrendChart").then(m => ({ default: m.ActiveUsersTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const AcceptanceRateChart = dynamic(
  () => import("@/components/charts/AcceptanceRateChart").then(m => ({ default: m.AcceptanceRateChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const ChatModeDonutChart = dynamic(
  () => import("@/components/charts/ChatModeDonutChart").then(m => ({ default: m.ChatModeDonutChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const FeatureUsageStackedChart = dynamic(
  () => import("@/components/charts/FeatureUsageStackedChart").then(m => ({ default: m.FeatureUsageStackedChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const CLIvsIDEChart = dynamic(
  () => import("@/components/charts/CLIvsIDEChart").then(m => ({ default: m.CLIvsIDEChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
import {
  Users,
  CheckSquare,
  KeyRound,
  Activity,
  ShieldAlert,
  TrendingDown,
  Sparkles,
  DollarSign,
  Zap,
  Link,
} from "lucide-react";
import NextLink from "next/link";

/** Format a USD amount for display, e.g. 1234.5 → "$1,235" */
function formatCost(v: number | null): string {
  if (v === null) return "—";
  return "$" + Math.round(v).toLocaleString();
}

export default function DashboardOverview() {
  const { mode, days, startDate, endDate } = useDateRange();
  const { hasFilter, buildScopeParams, clearAll } = useScope();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<{
    summary?: {
      totalOpenAlerts: number;
      criticalAlerts: number;
      overallFixRate: number;
      fixedLast30d: number;
      autofixAdoptionRate: number;
    };
  } | null>(null);
  const [securityEnabled, setSecurityEnabled] = useState(false);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const securityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((config) => {
        const enabled =
          config?.metrics?.codeScanning?.enabled ||
          config?.metrics?.dependabot?.enabled ||
          config?.metrics?.secretScanning?.enabled;
        setSecurityEnabled(enabled);
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (mode === "preset") {
      params.set("days", String(days));
    } else {
      params.set("startDate", startDate);
      params.set("endDate", endDate);
    }
    const scopeParams = buildScopeParams();
    scopeParams.forEach((value, key) => params.set(key, value));

    fetch(`/api/metrics/overview?${params}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.error) setError(json.error);
        else { setData(json); setError(null); }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));

    if (securityEnabled) {
      fetch(`/api/security/overview?${params}`)
        .then((res) => { if (res.ok) return res.json(); })
        .then((json) => { if (json) setSecurityData(json); })
        .catch(() => {});
    } else {
      setSecurityData(null);
    }
  }, [mode, days, startDate, endDate, buildScopeParams, securityEnabled]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return (
      <div>
        <PageHeader title="Overview" description="Loading metrics..." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => <KPISkeleton key={i} />)}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <ChartSkeleton key={i} />)}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Overview" description="GitHub Copilot usage across your enterprise" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <Activity className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            Error loading data
          </h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            {error}
          </p>
          <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            If metrics have not been synced yet, click the Sync button in the header.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Overview" description="GitHub Copilot usage across your enterprise" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <Activity className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            No data available
          </h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            {hasFilter
              ? "No data matches the current filters."
              : "Click the Sync button in the header to fetch metrics from GitHub."}
          </p>
          {hasFilter && (
            <button
              type="button"
              onClick={clearAll}
              className="mt-4 rounded-md border border-[hsl(var(--border))] px-3 py-1.5 text-sm font-medium text-[hsl(var(--foreground))] transition-colors hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>
    );
  }

  const { kpis, activeUsersTrend, acceptanceRateTrend, chatModes, featureUsage, cliVsIde } = data;
  const dailyTrendValues = data.dailyTrendValues ?? [];
  const isFiltered = data.filtered || hasFilter;

  const chatModeDonutData = [
    { name: "Ask",     value: chatModes.ask,     color: CHART_COLORS.ask },
    { name: "Edit",    value: chatModes.edit,    color: CHART_COLORS.edit },
    { name: "Plan",    value: chatModes.plan,    color: CHART_COLORS.plan },
    { name: "Agent",   value: chatModes.agent,   color: CHART_COLORS.agent },
    { name: "Custom",  value: chatModes.custom,  color: CHART_COLORS.custom },
    { name: "Unknown", value: chatModes.unknown, color: CHART_COLORS.unknown },
  ].filter((d) => d.value > 0);

  // Show inactive-seat ratio only when not filtered (seat data is enterprise-wide)
  const inactiveSeats  = isFiltered ? null : (kpis.inactiveSeats ?? 0);
  const totalSeats     = isFiltered ? null : (kpis.totalSeats ?? 0);
  const inactivePct    = totalSeats && totalSeats > 0 ? Math.round(((inactiveSeats ?? 0) / totalSeats) * 100) : null;

  const licenseUtil    = isFiltered ? null : kpis.licenseUtilization;

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`GitHub Copilot usage metrics — ${data.daysLoaded} days loaded (as of ${data.dataAsOf})`}
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, ...(securityData?.summary ? [securityRef] : []), chartsRef],
            title: "Executive Overview",
            filename: `overview-report-${days}d`,
            metadata: {
              reportName: "Executive Overview",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* ── KPI Row: ≤6 cards, answering the 4 program-owner questions ── */}
      {/* Call sites where accent should become value-derived (TODO for MetricCard wiring):
          1. Completion Acceptance — threshold already wired below (good ≥70, bad <40)
          2. License Utilization  — threshold already wired below (good ≥80, bad <60)
          3. Inactive Seats       — intentionally neutral (absolute count, no universal threshold)
          4. Active Users         — neutral (count metric, no good/bad direction)
      */}
      <Section title="Program Health">
        <div
          ref={kpiRef}
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        >
          {/* 1. Active Users — answers "Are we getting value?" */}
          <MetricCard
            title="Active Users"
            value={kpis.periodActiveUsers ?? 0}
            icon={<Users className="h-4 w-4" />}
            subtitle={`DAU ${kpis.dailyActiveUsers} · Period total`}
            accent="blue"
            stagger={1}
            trend={dailyTrendValues}
          />

          {/* 2. Completion Acceptance — answers "Are we getting value?" */}
          <MetricCard
            title="Acceptance Rate"
            value={kpis.completionAcceptanceRate ?? 0}
            format="percent"
            icon={<CheckSquare className="h-4 w-4" />}
            subtitle="Completion events accepted"
            thresholds={{ good: 70, bad: 40, higherIsBetter: true }}
            stagger={2}
          />

          {/* 3. License Utilization — answers "Who isn't using it?" */}
          <MetricCard
            title="License Utilization"
            value={licenseUtil ?? 0}
            format="percent"
            icon={<KeyRound className="h-4 w-4" />}
            subtitle={
              licenseUtil === null
                ? "N/A when filtered"
                : `${totalSeats ?? 0} total seats`
            }
            thresholds={{ good: 80, bad: 60, higherIsBetter: true }}
            stagger={3}
          />

          {/* 4. Inactive Seats — answers "Who isn't using it?" */}
          <MetricCard
            title="Inactive Seats"
            value={inactiveSeats ?? 0}
            icon={<Users className="h-4 w-4" />}
            subtitle={
              inactiveSeats === null
                ? "N/A when filtered"
                : inactivePct !== null
                ? `${inactivePct}% of total — no activity 30 d`
                : "No seat data"
            }
            accent="amber"
            stagger={4}
          />

          {/* 5. Monthly Net Cost — answers "What is it costing us?" */}
          <MetricCard
            title="Monthly Net Cost"
            value={formatCost(kpis.monthlyNetCost ?? null)}
            format="raw"
            icon={<DollarSign className="h-4 w-4" />}
            subtitle={
              kpis.billingAvailable
                ? `Est. based on last ${days} days`
                : "Sync billing data to see cost"
            }
            accent="teal"
            stagger={5}
          />

          {/* 6. AI Credits Used — answers "What is it costing us?" */}
          <MetricCard
            title="AI Credits Used"
            value={kpis.aiCreditsConsumed !== null && kpis.aiCreditsConsumed !== undefined
              ? kpis.aiCreditsConsumed
              : 0}
            icon={<Zap className="h-4 w-4" />}
            subtitle={
              kpis.aiCreditsConsumed
                ? `Last ${days} days`
                : "No usage data yet"
            }
            accent="violet"
            stagger={6}
          />
        </div>
      </Section>

      {/* ── Security summary — promoted above charts (#100) ── */}
      {securityData?.summary && (
        <Section title="Security Overview">
          <div ref={securityRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Open Alerts"
              value={securityData.summary.totalOpenAlerts}
              icon={<ShieldAlert className="h-4 w-4" />}
              subtitle={`${securityData.summary.criticalAlerts} critical`}
              thresholds={{ good: 0, bad: 10, higherIsBetter: false }}
            />
            <MetricCard
              title="Fix Rate"
              value={securityData.summary.overallFixRate}
              format="percent"
              icon={<TrendingDown className="h-4 w-4" />}
              subtitle={`${securityData.summary.fixedLast30d} fixed last 30d`}
              thresholds={{ good: 70, bad: 30, higherIsBetter: true }}
            />
            <MetricCard
              title="Autofix Adoption"
              value={securityData.summary.autofixAdoptionRate}
              format="percent"
              icon={<Sparkles className="h-4 w-4" />}
              subtitle="Copilot Autofix"
              thresholds={{ good: 50, bad: 10, higherIsBetter: true }}
            />
            <NextLink
              href="/dashboard/security"
              className="flex items-center justify-center rounded-xl border border-dashed border-[hsl(var(--border))] p-6 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] transition-colors gap-2"
            >
              <Link className="h-4 w-4" />
              View Full Security Dashboard
            </NextLink>
          </div>
        </Section>
      )}

      {/* ── Charts ── */}
      <Section title="Trends & Analytics">
        <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2 animate-fade-in-up">
          <ActiveUsersTrendChart data={activeUsersTrend} />
          <AcceptanceRateChart data={acceptanceRateTrend} />
          <ChatModeDonutChart data={chatModeDonutData} />
          <FeatureUsageStackedChart data={featureUsage} />
          <div className="lg:col-span-2">
            <CLIvsIDEChart data={cliVsIde} />
          </div>
        </div>
      </Section>
    </div>
  );
}
