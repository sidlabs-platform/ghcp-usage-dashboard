"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
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
import { Users, UserCheck, Bot, Terminal, CreditCard, Activity, Eye, GitPullRequest, ShieldAlert, TrendingDown, Sparkles, Code2, Brain, Monitor, Receipt, Calendar, AppWindow } from "lucide-react";

export default function DashboardOverview() {
  const { days } = useDateRange();
  const { hasFilter, buildScopeParams } = useScope();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [securityData, setSecurityData] = useState<any>(null);
  const [securityEnabled, setSecurityEnabled] = useState(false);
  const [pageVisibility, setPageVisibility] = useState<Record<string, boolean>>({});

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const securityRef = useRef<HTMLDivElement>(null);

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
        if (config?.pageVisibility) setPageVisibility(config.pageVisibility);
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 mb-8">
          {Array.from({ length: 9 }).map((_, i) => (
            <KPISkeleton key={i} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <ChartSkeleton key={i} />
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
  const dailyTrendValues = data.dailyTrendValues ?? [];
  const isFiltered = data.filtered || hasFilter;

  const chatModeDonutData= [
    { name: "Ask", value: chatModes.ask, color: CHART_COLORS.ask },
    { name: "Edit", value: chatModes.edit, color: CHART_COLORS.edit },
    { name: "Plan", value: chatModes.plan, color: CHART_COLORS.plan },
    { name: "Agent", value: chatModes.agent, color: CHART_COLORS.agent },
    { name: "Custom", value: chatModes.custom, color: CHART_COLORS.custom },
    { name: "Unknown", value: chatModes.unknown, color: CHART_COLORS.unknown },
  ].filter((d) => d.value > 0);

  return (
    <div>
      <PageHeader
        title="Executive Overview"
        description={`GitHub Copilot usage metrics — ${data.daysLoaded} days loaded (as of ${data.dataAsOf})`}
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef, ...(securityData?.summary ? [securityRef] : [])],
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

      {/* KPI Cards */}
      <Section title="Key Metrics">
        <div ref={kpiRef} className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 ${isFiltered ? "xl:grid-cols-9" : "xl:grid-cols-10"}`}>
          <MetricCard
            title="Period Active Users"
            value={kpis.periodActiveUsers ?? 0}
            icon={<Calendar className="h-4 w-4" />}
            subtitle={`Unique in last ${days} day${days !== 1 ? "s" : ""}`}
            accent="teal"
            stagger={1}
            trend={dailyTrendValues}
          />
          <MetricCard
            title="Daily Active Users"
            value={kpis.dailyActiveUsers}
            icon={<Users className="h-4 w-4" />}
            delta={kpis.deltas.dau !== 0 ? { value: kpis.deltas.dau } : undefined}
            subtitle="Yesterday"
            accent="blue"
            stagger={2}
            trend={dailyTrendValues}
          />
          <MetricCard
            title="Weekly Active Users"
            value={kpis.weeklyActiveUsers}
            icon={<UserCheck className="h-4 w-4" />}
            subtitle={`${days}-day average`}
            accent="violet"
            stagger={3}
            trend={dailyTrendValues}
          />
          <MetricCard
            title="Monthly Active Users"
            value={kpis.monthlyActiveUsers}
            icon={<Users className="h-4 w-4" />}
            subtitle={`${days}-day average`}
            accent="green"
            stagger={4}
          />
          <MetricCard
            title="Agent Adoption"
            value={kpis.agentAdoption}
            format="percent"
            icon={<Bot className="h-4 w-4" />}
            subtitle="% of active users"
            accent="amber"
            stagger={5}
          />
          <MetricCard
            title="Coding Agent"
            value={kpis.codingAgentAdoption}
            format="percent"
            icon={<GitPullRequest className="h-4 w-4" />}
            subtitle="% using coding agent"
            accent="amber"
            stagger={6}
          />
          <MetricCard
            title="Code Review"
            value={kpis.codeReviewAdoption}
            format="percent"
            icon={<Eye className="h-4 w-4" />}
            subtitle="% with active review"
            accent="teal"
            stagger={7}
          />
          <MetricCard
            title="CLI Users"
            value={kpis.cliUsers}
            icon={<Terminal className="h-4 w-4" />}
            subtitle="Yesterday"
            accent="green"
            stagger={8}
          />
          <MetricCard
            title="Copilot App Users"
            value={kpis.copilotAppUsers ?? 0}
            icon={<AppWindow className="h-4 w-4" />}
            subtitle="Yesterday"
            accent="violet"
            stagger={9}
          />
          {!isFiltered && (
            <MetricCard
              title="License Utilization"
              value={kpis.licenseUtilization}
              format="percent"
              icon={<CreditCard className="h-4 w-4" />}
              subtitle="Active / total seats"
              accent="red"
              stagger={10}
            />
          )}
        </div>
      </Section>

      {/* Charts grid */}
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

      {/* Quick Links to Analytics */}
      {(() => {
        const isVisible = (key: string) => Object.keys(pageVisibility).length === 0 || pageVisibility[key] !== false;
        const quickLinks = [
          { href: "/dashboard/code-generation", visKey: "codeGeneration", icon: <Code2 className="h-4 w-4 text-[hsl(var(--primary))]" />, label: "Code Generation", desc: "LoC suggested vs accepted, language breakdown" },
          { href: "/dashboard/chat-modes", visKey: "chatModes", icon: <Sparkles className="h-4 w-4 text-violet-500" />, label: "Copilot Features", desc: "Chat, Agent, and feature adoption trends" },
          { href: "/dashboard/models", visKey: "models", icon: <Brain className="h-4 w-4 text-amber-500" />, label: "Model Statistics", desc: "AI model usage across features and languages" },
          { href: "/dashboard/cli", visKey: "cli", icon: <Terminal className="h-4 w-4 text-emerald-500" />, label: "CLI Analytics", desc: "Session activity, users, and token consumption" },
          { href: "/dashboard/pull-requests", visKey: "pullRequests", icon: <GitPullRequest className="h-4 w-4 text-orange-500" />, label: "Pull Requests", desc: "Copilot-authored and reviewed PR metrics" },
          { href: "/dashboard/teams", visKey: "teams", icon: <Users className="h-4 w-4 text-sky-500" />, label: "Team Analytics", desc: "Adoption and usage leaderboard by team" },
          { href: "/dashboard/ide-languages", visKey: "ideLanguages", icon: <Monitor className="h-4 w-4 text-indigo-500" />, label: "IDE & Languages", desc: "Editor and programming language breakdown" },
          { href: "/dashboard/billing", visKey: "billing", icon: <Receipt className="h-4 w-4 text-rose-500" />, label: "Billing", desc: "Cost summary and spend breakdown" },
          { href: "/dashboard/copilot-app", visKey: "copilotApp", icon: <AppWindow className="h-4 w-4 text-violet-500" />, label: "Copilot App", desc: "Mobile/App adoption, sessions, and code impact" },
        ].filter((l) => isVisible(l.visKey));
        if (quickLinks.length === 0) return null;
        return (
          <Section title="Explore Analytics">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {quickLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="group rounded-xl border p-4 transition-all duration-200 hover:bg-[hsl(var(--accent))] hover:-translate-y-0.5 hover:shadow-[var(--card-hover-shadow)]"
                >
                  <div className="flex items-center gap-2.5 mb-1.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(var(--muted))] group-hover:bg-[hsl(var(--background))] transition-colors">
                      {link.icon}
                    </div>
                    <span className="text-sm font-semibold">{link.label}</span>
                  </div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] leading-relaxed pl-[42px]">{link.desc}</p>
                </Link>
              ))}
            </div>
          </Section>
        );
      })()}

      {/* Security Summary */}
      {securityData?.summary && (
        <Section title="Security Overview">
          <div ref={securityRef} className="grid gap-4 grid-cols-2 lg:grid-cols-4">
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
        </Section>
      )}
    </div>
  );
}
