"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { CHART_COLORS } from "@/lib/constants";

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
import { Users, UserCheck, Bot, Terminal, CreditCard, Activity, Eye, GitPullRequest, ShieldCheck, ShieldAlert, TrendingDown, Sparkles } from "lucide-react";

interface OverviewData {
  kpis: {
    dailyActiveUsers: number;
    weeklyActiveUsers: number;
    monthlyActiveUsers: number;
    agentAdoption: number;
    codingAgentAdoption: number;
    codeReviewAdoption: number;
    cliUsers: number;
    licenseUtilization: number;
    deltas: { dau: number; wau: number };
  };
  activeUsersTrend: { day: string; daily: number; weekly: number; monthly: number }[];
  acceptanceRateTrend: { day: string; suggested: number; accepted: number; rate: number }[];
  chatModes: { ask: number; edit: number; plan: number; agent: number; custom: number };
  featureUsage: { day: string; completions: number; chat: number; agent: number; cli: number }[];
  cliVsIde: { day: string; ideUsers: number; cliUsers: number }[];
  dataAsOf: string;
  daysLoaded: number;
  filtered?: boolean;
}

export default function DashboardOverview() {
  const { days } = useDateRange();
  const { selectedEntTeams, selectedOrgTeams, selectedOrgs, hasFilter, buildScopeParams } = useScope();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<any>(null);
  const [securityEnabled, setSecurityEnabled] = useState(false);

  // Fetch config once
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
    const params = new URLSearchParams({ days: String(days) });
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

    // Fetch security overview separately so failures don't break the main dashboard
    if (securityEnabled) {
      try {
        fetch(`/api/security/overview?days=${days}`)
          .then((res) => { if (res.ok) return res.json(); })
          .then((json) => { if (json) setSecurityData(json); })
          .catch(() => { /* Security metrics may not be available */ });
      } catch { /* Security metrics may not be available */ }
    } else {
      setSecurityData(null);
    }
  }, [days, buildScopeParams, securityEnabled]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading && !data) {
    return (
      <div>
        <PageHeader title="Executive Overview" description="Loading metrics..." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-xl border bg-[hsl(var(--card))] animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-96 rounded-xl border bg-[hsl(var(--card))] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="Executive Overview" description="GitHub Copilot usage across your enterprise" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <Activity className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            {error ? "Error loading data" : "No data available"}
          </h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            {error || "Click the Sync button in the header to fetch metrics from GitHub. This will backfill 90 days of data using the enterprise-1-day API endpoint."}
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { kpis, activeUsersTrend, acceptanceRateTrend, chatModes, featureUsage, cliVsIde } = data;
  const isFiltered = data.filtered || hasFilter;

  const chatModeDonutData = [
    { name: "Ask", value: chatModes.ask, color: CHART_COLORS.ask },
    { name: "Edit", value: chatModes.edit, color: CHART_COLORS.edit },
    { name: "Plan", value: chatModes.plan, color: CHART_COLORS.plan },
    { name: "Agent", value: chatModes.agent, color: CHART_COLORS.agent },
    { name: "Custom", value: chatModes.custom, color: CHART_COLORS.custom },
  ].filter((d) => d.value > 0);

  return (
    <div>
      <PageHeader
        title="Executive Overview"
        description={`GitHub Copilot usage metrics — ${data.daysLoaded} days loaded (as of ${data.dataAsOf})`}
      />

      <ScopeFilter />

      {/* KPI Cards */}
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 ${isFiltered ? "xl:grid-cols-7" : "xl:grid-cols-8"} mb-8`}>
        <MetricCard
          title="Daily Active Users"
          value={kpis.dailyActiveUsers}
          icon={<Users className="h-4 w-4" />}
          delta={kpis.deltas.dau !== 0 ? { value: kpis.deltas.dau } : undefined}
          subtitle="Yesterday"
        />
        <MetricCard
          title="Weekly Active Users"
          value={kpis.weeklyActiveUsers}
          icon={<UserCheck className="h-4 w-4" />}
          delta={kpis.deltas.wau !== 0 ? { value: kpis.deltas.wau } : undefined}
          subtitle="Last 7 days"
        />
        <MetricCard
          title="Monthly Active Users"
          value={kpis.monthlyActiveUsers}
          icon={<Users className="h-4 w-4" />}
          subtitle={isFiltered ? "In selected scope" : "This calendar month"}
        />
        <MetricCard
          title="IDE Agent Adoption"
          value={kpis.agentAdoption}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
          subtitle="% of active users"
        />
        <MetricCard
          title="Coding Agent"
          value={kpis.codingAgentAdoption}
          format="percent"
          icon={<GitPullRequest className="h-4 w-4" />}
          subtitle="% using coding agent"
        />
        <MetricCard
          title="Code Review"
          value={kpis.codeReviewAdoption}
          format="percent"
          icon={<Eye className="h-4 w-4" />}
          subtitle="% with active review"
        />
        <MetricCard
          title="CLI Users"
          value={kpis.cliUsers}
          icon={<Terminal className="h-4 w-4" />}
          subtitle="Yesterday"
        />
        {!isFiltered && (
          <MetricCard
            title="License Utilization"
            value={kpis.licenseUtilization}
            format="percent"
            icon={<CreditCard className="h-4 w-4" />}
            subtitle="Active / total seats"
          />
        )}
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ActiveUsersTrendChart data={activeUsersTrend} />
        <AcceptanceRateChart data={acceptanceRateTrend} />
        <ChatModeDonutChart data={chatModeDonutData} />
        <FeatureUsageStackedChart data={featureUsage} />
        <div className="lg:col-span-2">
          <CLIvsIDEChart data={cliVsIde} />
        </div>
      </div>

      {/* Security Summary */}
      {securityData?.summary && (
        <section className="space-y-4 mt-8">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Security Overview
          </h2>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title="Open Alerts"
              value={securityData.summary.totalOpenAlerts}
              icon={<ShieldAlert className="h-4 w-4" />}
              subtitle={`${securityData.summary.criticalAlerts} critical`}
            />
            <MetricCard
              title="Fix Rate"
              value={securityData.summary.overallFixRate}
              format="percent"
              icon={<TrendingDown className="h-4 w-4" />}
              subtitle={`${securityData.summary.fixedLast30d} fixed last 30d`}
            />
            <MetricCard
              title="Autofix Adoption"
              value={securityData.summary.autofixAdoptionRate}
              format="percent"
              icon={<Sparkles className="h-4 w-4" />}
              subtitle="Copilot Autofix"
            />
            <Link
              href="/dashboard/security"
              className="flex items-center justify-center rounded-xl border border-dashed border-[hsl(var(--border))] p-6 text-sm text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] hover:text-[hsl(var(--foreground))] transition-colors"
            >
              View Full Security Dashboard →
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
