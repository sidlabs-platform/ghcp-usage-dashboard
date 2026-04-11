"use client";

import { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

const LocTrendChart = dynamic(
  () => import("@/components/charts/LocTrendChart").then(m => ({ default: m.LocTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const LanguageBarChart = dynamic(
  () => import("@/components/charts/LanguageBarChart").then(m => ({ default: m.LanguageBarChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const FeatureBreakdownChart = dynamic(
  () => import("@/components/charts/FeatureBreakdownChart").then(m => ({ default: m.FeatureBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
import { Code2, TrendingUp, FileCode, Percent } from "lucide-react";
import type { CodeGenerationResponse } from "@/app/api/metrics/code-generation/route";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CHART_COLORS } from "@/lib/constants";

export default function CodeGenerationPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<CodeGenerationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    const scopeParams = buildScopeParams();
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/code-generation?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<CodeGenerationResponse>;
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} />;
  if (!data) return <EmptyState />;

  const { kpis, dailyTrend, acceptanceRate, languageBreakdown, featureBreakdown } = data;

  return (
    <div>
      <PageHeader
        title="Code Generation & Activity"
        description="Lines of code, acceptance rates, and feature breakdown across your enterprise"
      />

      <ScopeFilter />

      {/* KPI Cards — separated completion vs agent */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 mb-8">
        <MetricCard
          title="Total LoC Changed"
          value={kpis.totalLocChanged}
          icon={<Code2 className="h-4 w-4" />}
          subtitle="Completion + Agent (90 days)"
        />
        <MetricCard
          title="Completion Acceptance"
          value={kpis.completionAcceptanceRate}
          format="percent"
          icon={<Percent className="h-4 w-4" />}
          subtitle="Code completions only"
        />
        <MetricCard
          title="Completion LoC"
          value={kpis.completionLocAccepted}
          icon={<FileCode className="h-4 w-4" />}
          subtitle={`${kpis.completionLocSuggested.toLocaleString()} suggested`}
        />
        <MetricCard
          title="Agent LoC Added"
          value={kpis.agentLocAdded}
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle={`${kpis.agentLocDeleted.toLocaleString()} deleted by agent`}
        />
        <MetricCard
          title="Agent LoC Share"
          value={kpis.agentLocShare}
          format="percent"
          icon={<TrendingUp className="h-4 w-4" />}
          subtitle="Agent-generated % of total added"
        />
        <MetricCard
          title="Code Generations"
          value={kpis.totalCodeGenerations}
          icon={<FileCode className="h-4 w-4" />}
          subtitle="Completion activities"
        />
      </div>

      {/* Charts — 2-column grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LocTrendChart data={dailyTrend} />

        <Card>
          <CardHeader>
            <CardTitle>Acceptance Rate Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={acceptanceRate} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-[hsl(var(--border))]" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v: string) => v.slice(5)}
                    className="text-[hsl(var(--muted-foreground))]"
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    domain={[0, 100]}
                    tickFormatter={(v: number) => `${v}%`}
                    className="text-[hsl(var(--muted-foreground))]"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      borderColor: "hsl(var(--border))",
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)}%`, "Acceptance Rate"]}
                    labelFormatter={(label: string) => `Date: ${label}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="rate"
                    name="Acceptance Rate"
                    stroke={CHART_COLORS.locAccepted}
                    fill={CHART_COLORS.locAccepted}
                    fillOpacity={0.15}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <LanguageBarChart data={languageBreakdown} title="Top Languages by LoC Added" />

        <FeatureBreakdownChart data={featureBreakdown} />
      </div>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-64 rounded bg-[hsl(var(--muted))] mb-2" />
      <div className="h-4 w-96 rounded bg-[hsl(var(--muted))] mb-8" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl border bg-[hsl(var(--card))] p-6">
            <div className="h-4 w-24 rounded bg-[hsl(var(--muted))] mb-4" />
            <div className="h-8 w-20 rounded bg-[hsl(var(--muted))]" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-96 rounded-xl border bg-[hsl(var(--card))] p-6">
            <div className="h-5 w-40 rounded bg-[hsl(var(--muted))] mb-6" />
            <div className="h-72 rounded bg-[hsl(var(--muted))]/50" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────

function ErrorState({ message }: { message: string }) {
  return (
    <div>
      <PageHeader title="Code Generation & Activity" />
      <div className="flex h-64 items-center justify-center rounded-xl border bg-[hsl(var(--card))] text-sm text-[hsl(var(--muted-foreground))]">
        <div className="text-center">
          <p className="font-medium text-red-500 mb-1">Failed to load metrics</p>
          <p>{message}</p>
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div>
      <PageHeader title="Code Generation & Activity" />
      <div className="flex h-64 items-center justify-center rounded-xl border bg-[hsl(var(--card))] text-sm text-[hsl(var(--muted-foreground))]">
        No data available. Sync enterprise metrics first.
      </div>
    </div>
  );
}
