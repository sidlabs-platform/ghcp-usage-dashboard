"use client";

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ActiveUsersTrendChart } from "@/components/charts/ActiveUsersTrendChart";
import { AcceptanceRateChart } from "@/components/charts/AcceptanceRateChart";
import { ChatModeDonutChart } from "@/components/charts/ChatModeDonutChart";
import { FeatureUsageStackedChart } from "@/components/charts/FeatureUsageStackedChart";
import { CLIvsIDEChart } from "@/components/charts/CLIvsIDEChart";
import { CHART_COLORS } from "@/lib/constants";
import { Users, UserCheck, Bot, Terminal, CreditCard, Activity } from "lucide-react";

interface OverviewData {
  kpis: {
    dailyActiveUsers: number;
    weeklyActiveUsers: number;
    monthlyActiveUsers: number;
    agentAdoption: number;
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

interface FilterOptions {
  enterpriseTeams: { slug: string; name: string; memberCount: number }[];
  orgTeams: { slug: string; name: string; orgSlug: string; memberCount: number }[];
  orgs: { slug: string; name: string }[];
}

export default function DashboardOverview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterOptions>({ enterpriseTeams: [], orgTeams: [], orgs: [] });
  const [selectedEntTeams, setSelectedEntTeams] = useState<string[]>([]);
  const [selectedOrgTeams, setSelectedOrgTeams] = useState<string[]>([]);
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);

  // Fetch filter options once
  useEffect(() => {
    fetch("/api/filters")
      .then((res) => res.json())
      .then((json) => { if (!json.error) setFilters(json); })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: "90" });
    const allTeams = [...selectedEntTeams, ...selectedOrgTeams];
    if (allTeams.length > 0) params.set("teams", allTeams.join(","));
    if (selectedOrgs.length > 0) params.set("orgs", selectedOrgs.join(","));

    fetch(`/api/metrics/overview?${params}`)
      .then((res) => res.json())
      .then((json) => {
        if (json.error) setError(json.error);
        else { setData(json); setError(null); }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedEntTeams, selectedOrgTeams, selectedOrgs]);

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
        <ScopeFilter
          enterpriseTeams={filters.enterpriseTeams}
          orgTeams={filters.orgTeams}
          orgs={filters.orgs}
          selectedEnterpriseTeams={selectedEntTeams}
          selectedOrgTeams={selectedOrgTeams}
          selectedOrgs={selectedOrgs}
          onEnterpriseTeamsChange={setSelectedEntTeams}
          onOrgTeamsChange={setSelectedOrgTeams}
          onOrgsChange={setSelectedOrgs}
        />
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
  const isFiltered = data.filtered;

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

      <ScopeFilter
        enterpriseTeams={filters.enterpriseTeams}
        orgTeams={filters.orgTeams}
        orgs={filters.orgs}
        selectedEnterpriseTeams={selectedEntTeams}
        selectedOrgTeams={selectedOrgTeams}
        selectedOrgs={selectedOrgs}
        onEnterpriseTeamsChange={setSelectedEntTeams}
        onOrgTeamsChange={setSelectedOrgTeams}
        onOrgsChange={setSelectedOrgs}
      />

      {/* KPI Cards */}
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 ${isFiltered ? "xl:grid-cols-5" : "xl:grid-cols-6"} mb-8`}>
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
          title="Agent Adoption"
          value={kpis.agentAdoption}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
          subtitle="% of active users"
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
    </div>
  );
}
