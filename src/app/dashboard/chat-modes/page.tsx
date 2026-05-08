"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS, FEATURE_LABELS } from "@/lib/constants";
import { formatNumber } from "@/lib/utils";
import Link from "next/link";
import { Sparkles, Bot, MessageSquare, Terminal } from "lucide-react";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableHeader } from "@/components/tables/SortableHeader";
import { ExportMenu } from "@/components/ui/ExportMenu";
import type { CSVColumn } from "@/lib/export/csv";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  Legend,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────

interface FeatureRow {
  feature: string;
  interactions: number;
  acceptances: number;
  locAdded: number;
}

interface AdoptionDay {
  day: string;
  agentUsers: number;
  chatUsers: number;
  cliUsers: number;
  totalUsers: number;
}

interface KPIs {
  totalInteractions: number;
  totalActivity: number;
  topFeature: string;
  agentAdoptionPct: number;
  chatAdoptionPct: number;
  cliAdoptionPct: number;
}

interface FeaturesData {
  dailyTrend: Record<string, number | string>[];
  featureDistribution: FeatureRow[];
  adoptionTrend: AdoptionDay[];
  kpis: KPIs;
}

// ── Palette for dynamic features ──────────────────────────────────────

const FEATURE_COLORS = [
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#a855f7", // purple
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
];

const featureExportColumns: CSVColumn[] = [
  { key: "feature", label: "Feature", format: (row) => featureLabel(row.feature) },
  { key: "interactions", label: "Interactions" },
  { key: "acceptances", label: "Acceptances" },
  { key: "locAdded", label: "LoC Added" },
];

function featureLabel(f: string): string {
  return FEATURE_LABELS[f] ?? f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Page Component ────────────────────────────────────────────────────

export default function CopilotFeaturesPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<FeaturesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const adoptionRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const fetchData= useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/chat-modes?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Derive top features for the stacked area chart
  const topFeatures = useMemo(() => {
    if (!data) return [];
    return data.featureDistribution
      .filter((f) => f.interactions > 0)
      .slice(0, 7)
      .map((f) => f.feature);
  }, [data]);

  type FeatureSortField = "feature" | "interactions" | "acceptances" | "locAdded";
  const { sortedData: sortedFeatures, sortField: featureSortField, sortAsc: featureSortAsc, handleSort: handleFeatureSort } = useTableSort<FeatureRow, FeatureSortField>(data?.featureDistribution ?? [], "interactions");

  if (loading) {
    return (
      <div>
        <PageHeader
          title="Copilot Features"
          description="Chat, Agent, CLI, and code review feature adoption and trends"
        />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          Loading feature metrics…
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader
          title="Copilot Features"
          description="Chat, Agent, CLI, and code review feature adoption and trends"
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const { kpis, featureDistribution, adoptionTrend, dailyTrend } = data;

  // Bar chart data(horizontal): top 10 features by interactions + acceptances
  const barData = featureDistribution.slice(0, 10).map((f) => ({
    name: featureLabel(f.feature),
    interactions: f.interactions,
    acceptances: f.acceptances,
  }));
  const barHeight = Math.max(300, barData.length * 36 + 40);

  return (
    <div>
      <PageHeader
        title="Copilot Features"
        description="Chat, Agent, CLI, and code review feature adoption and trends"
      >
        <ExportMenu
          csv={{
            fetchUrl: "/api/metrics/chat-modes",
            extraParams: new URLSearchParams({ days: String(days), ...Object.fromEntries(buildScopeParams()) }),
            columns: featureExportColumns,
            dataExtractor: (json) => json.featureDistribution ?? [],
            filename: `features-export-${days}d`,
            metadata: {
              reportName: "Copilot Features",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          pdf={{
            sectionRefs: [kpiRef, chartsRef, adoptionRef, tableRef],
            title: "Copilot Features",
            filename: `features-report-${days}d`,
            metadata: {
              reportName: "Copilot Features",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* ── KPI Cards─────────────────────────────────────────────── */}
      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        <MetricCard
          title="Total Interactions"
          value={kpis.totalInteractions}
          icon={<Sparkles className="h-4 w-4" />}
          subtitle="User-initiated across all features"
        />
        <MetricCard
          title="Top Feature"
          value={featureLabel(kpis.topFeature)}
          icon={<Bot className="h-4 w-4" />}
          subtitle="By total activity"
        />
        <MetricCard
          title="Agent Adoption"
          value={kpis.agentAdoptionPct}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
          subtitle="Users with agent activity"
        />
        <MetricCard
          title="Chat Adoption"
          value={kpis.chatAdoptionPct}
          format="percent"
          icon={<MessageSquare className="h-4 w-4" />}
          subtitle="Users with chat activity"
        />
      </div>

      {/* ── Feature Distribution + Daily Trend ────────────────────── */}
      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
        {/* Horizontal bar chart */}
        <Card>
          <CardHeader>
            <CardTitle>Feature Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ height: barHeight }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={barData}
                  layout="vertical"
                  margin={{ top: 5, right: 20, bottom: 5, left: 100 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 12 }}
                    className="text-[hsl(var(--muted-foreground))]"
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    width={95}
                    className="text-[hsl(var(--muted-foreground))]"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => value.toLocaleString()}
                  />
                  <Legend />
                  <Bar
                    dataKey="interactions"
                    name="Interactions"
                    fill={CHART_COLORS.primary}
                    radius={[0, 4, 4, 0]}
                  />
                  <Bar
                    dataKey="acceptances"
                    name="Acceptances"
                    fill={CHART_COLORS.completions}
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Stacked area chart of top features */}
        <Card>
          <CardHeader>
            <CardTitle>Daily Feature Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={barHeight}>
              <AreaChart data={dailyTrend} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
                <XAxis
                  dataKey="day"
                  tickFormatter={formatDate}
                  tick={{ fontSize: 12 }}
                  className="text-[hsl(var(--muted-foreground))]"
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  className="text-[hsl(var(--muted-foreground))]"
                  tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
                />
                <Tooltip
                  labelFormatter={(label) => `Date: ${label}`}
                  formatter={(value: number, name: string) => [
                    value.toLocaleString(),
                    featureLabel(name),
                  ]}
                />
                <Legend formatter={(value) => featureLabel(value)} />
                {topFeatures.map((feat, i) => (
                  <Area
                    key={feat}
                    type="monotone"
                    dataKey={feat}
                    name={feat}
                    stackId="1"
                    fill={FEATURE_COLORS[i % FEATURE_COLORS.length]}
                    fillOpacity={0.4}
                    stroke={FEATURE_COLORS[i % FEATURE_COLORS.length]}
                    strokeWidth={1.5}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* ── Adoption Trend ────────────────────────────────────────── */}
      <Card ref={adoptionRef} className="mb-6">
        <CardHeader>
          <CardTitle>Adoption Trend (Unique Users / Day)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={adoptionTrend} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDate}
                tick={{ fontSize: 12 }}
                className="text-[hsl(var(--muted-foreground))]"
              />
              <YAxis tick={{ fontSize: 12 }} className="text-[hsl(var(--muted-foreground))]" />
              <Tooltip
                labelFormatter={(label) => `Date: ${label}`}
                formatter={(value: number, name: string) => [value.toLocaleString(), name]}
              />
              <Legend />
              <Line type="monotone" dataKey="agentUsers" name="Agent Users" stroke={CHART_COLORS.agent} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="chatUsers" name="Chat Users" stroke={CHART_COLORS.chat} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="cliUsers" name="CLI Users" stroke={CHART_COLORS.cli} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="totalUsers" name="Total Users" stroke={CHART_COLORS.primary} strokeWidth={2} dot={false} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* ── Feature Detail Table ──────────────────────────────────── */}
      <Card ref={tableRef}>
        <CardHeader>
          <CardTitle>Feature Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <SortableHeader label="Feature" field={"feature" as FeatureSortField} sortField={featureSortField} sortAsc={featureSortAsc} onSort={handleFeatureSort} />
                  <SortableHeader label="Interactions" field={"interactions" as FeatureSortField} sortField={featureSortField} sortAsc={featureSortAsc} onSort={handleFeatureSort} align="right" />
                  <SortableHeader label="Acceptances" field={"acceptances" as FeatureSortField} sortField={featureSortField} sortAsc={featureSortAsc} onSort={handleFeatureSort} align="right" />
                  <SortableHeader label="LoC Added" field={"locAdded" as FeatureSortField} sortField={featureSortField} sortAsc={featureSortAsc} onSort={handleFeatureSort} align="right" last />
                </tr>
              </thead>
              <tbody>
                {sortedFeatures.map((f) => (
                  <tr key={f.feature} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 font-medium">{featureLabel(f.feature)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(f.interactions)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(f.acceptances)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatNumber(f.locAdded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h3 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h3>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/cli" className="text-sm text-[hsl(var(--primary))] hover:underline">
            CLI Analytics →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/code-generation" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Code Generation →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/users" className="text-sm text-[hsl(var(--primary))] hover:underline">
            User Explorer →
          </Link>
        </div>
      </section>
    </div>
  );
}
