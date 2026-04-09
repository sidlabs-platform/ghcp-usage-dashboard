"use client";

import { useEffect, useState, useMemo } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CHART_COLORS, FEATURE_LABELS } from "@/lib/constants";
import { formatNumber } from "@/lib/utils";
import { Sparkles, Bot, MessageSquare, Terminal } from "lucide-react";
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
  codeGen: number;
  codeAccept: number;
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

function featureLabel(f: string): string {
  return FEATURE_LABELS[f] ?? f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Page Component ────────────────────────────────────────────────────

export default function CopilotFeaturesPage() {
  const [data, setData] = useState<FeaturesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/metrics/chat-modes")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Derive top features for the stacked area chart
  const topFeatures = useMemo(() => {
    if (!data) return [];
    return data.featureDistribution
      .filter((f) => f.interactions > 0)
      .slice(0, 7)
      .map((f) => f.feature);
  }, [data]);

  if (loading) {
    return (
      <div>
        <PageHeader
          title="Copilot Features"
          description="Feature-level usage breakdown across code completions, chat modes, agent, and CLI"
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
          description="Feature-level usage breakdown across code completions, chat modes, agent, and CLI"
        />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const { kpis, featureDistribution, adoptionTrend, dailyTrend } = data;

  // Bar chart data (horizontal): top 10 features by interactions+codeGen
  const barData = featureDistribution.slice(0, 10).map((f) => ({
    name: featureLabel(f.feature),
    interactions: f.interactions,
    codeGen: f.codeGen,
  }));
  const barHeight = Math.max(300, barData.length * 36 + 40);

  return (
    <div>
      <PageHeader
        title="Copilot Features"
        description="Feature-level usage breakdown across code completions, chat modes, agent, and CLI"
      />

      {/* ── KPI Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
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
          icon={<MessageSquare className="h-4 w-4" />}
          subtitle="Users with agent activity"
        />
        <MetricCard
          title="Chat Adoption"
          value={kpis.chatAdoptionPct}
          format="percent"
          icon={<Terminal className="h-4 w-4" />}
          subtitle="Users with chat activity"
        />
      </div>

      {/* ── Feature Distribution + Daily Trend ────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-6">
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
                    dataKey="codeGen"
                    name="Code Generations"
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
      <Card className="mb-6">
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
      <Card>
        <CardHeader>
          <CardTitle>Feature Detail</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <th className="pb-3 pr-4 font-medium">Feature</th>
                  <th className="pb-3 pr-4 font-medium text-right">Interactions</th>
                  <th className="pb-3 pr-4 font-medium text-right">Code Generations</th>
                  <th className="pb-3 pr-4 font-medium text-right">Acceptances</th>
                  <th className="pb-3 font-medium text-right">LoC Added</th>
                </tr>
              </thead>
              <tbody>
                {featureDistribution.map((f) => (
                  <tr key={f.feature} className="border-b last:border-0">
                    <td className="py-2.5 pr-4 font-medium">{featureLabel(f.feature)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(f.interactions)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(f.codeGen)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(f.codeAccept)}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatNumber(f.locAdded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
