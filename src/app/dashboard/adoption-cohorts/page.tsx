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
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Users, TrendingUp, Code2, Bot, Layers } from "lucide-react";
import type { CohortDistributionData } from "@/components/charts/CohortDistributionChart";
import type { CohortTrendDataPoint } from "@/components/charts/CohortTrendChart";
import type { TotalsByAIAdoptionPhase } from "@/lib/types/metrics";

const CohortDistributionChart = dynamic(
  () => import("@/components/charts/CohortDistributionChart").then((m) => ({ default: m.CohortDistributionChart })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const CohortTrendChart = dynamic(
  () => import("@/components/charts/CohortTrendChart").then((m) => ({ default: m.CohortTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface AdoptionCohortsData {
  distribution: CohortDistributionData[];
  trend: CohortTrendDataPoint[];
  perPhaseMetrics: TotalsByAIAdoptionPhase[];
  totalEngaged: number;
  hasData: boolean;
  dataAsOf: string;
  daysLoaded: number;
  latestDay?: string;
}

const PHASE_ICONS: Record<number, typeof Users> = {
  0: Users,
  1: Code2,
  2: Bot,
  3: Layers,
};

const PHASE_ACCENTS: Record<number, "blue" | "green" | "amber" | "violet" | "red" | "teal"> = {
  0: "amber",
  1: "blue",
  2: "violet",
  3: "teal",
};

export default function AdoptionCohortsPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<AdoptionCohortsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const controller = new AbortController();
    const params = new URLSearchParams({ days: String(days) });
    const scopeParams = buildScopeParams();
    scopeParams.forEach((value, key) => params.set(key, value));

    fetch(`/api/metrics/adoption-cohorts?${params}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (json.error) setError(json.error);
        else { setData(json); setError(null); }
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [days, buildScopeParams]);

  useEffect(() => {
    const cleanup = fetchData();
    return cleanup;
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div>
        <PageHeader title="AI Adoption Cohorts" description="Loading cohort data..." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => <KPISkeleton key={i} />)}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartSkeleton />
          <ChartSkeleton />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader title="AI Adoption Cohorts" description="AI adoption maturity phases" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <TrendingUp className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error loading data</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">{error}</p>
        </div>
      </div>
    );
  }

  if (!data || !data.hasData) {
    return (
      <div>
        <PageHeader title="AI Adoption Cohorts" description="AI adoption maturity phases" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <TrendingUp className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h3 className="text-lg font-semibold mb-2">No adoption cohort data available</h3>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            Adoption cohort data will appear after your next sync. This feature requires data from
            the latest GitHub Copilot usage metrics API (announced May 2026).
          </p>
        </div>
      </div>
    );
  }

  const { distribution, trend, perPhaseMetrics, totalEngaged } = data;

  return (
    <div>
      <PageHeader
        title="AI Adoption Cohorts"
        description={`AI adoption maturity phases — ${data.daysLoaded} days · Distribution snapshot: ${data.latestDay ?? data.dataAsOf}`}
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "AI Adoption Cohorts",
            filename: `adoption-cohorts-${days}d`,
            metadata: {
              reportName: "AI Adoption Cohorts",
              dateRange: `Last ${days} days`,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* KPI Cards — one per phase */}
      <Section title="Phase Distribution">
        <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <MetricCard
            title="Total Engaged"
            value={totalEngaged}
            icon={<Users className="h-4 w-4" />}
            subtitle={`${data.daysLoaded}-day window`}
            accent="teal"
            stagger={1}
          />
          {distribution.map((d, i) => {
            const Icon = PHASE_ICONS[d.phase] ?? Users;
            return (
              <MetricCard
                key={d.phase}
                title={d.label}
                value={d.count}
                icon={<Icon className="h-4 w-4" />}
                subtitle={`${d.percentage.toFixed(1)}% of engaged`}
                accent={PHASE_ACCENTS[d.phase] ?? "blue"}
                stagger={(Math.min(i + 2, 11)) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11}
              />
            );
          })}
        </div>
      </Section>

      {/* Charts */}
      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2 mt-6">
        <CohortDistributionChart data={distribution} />
        <CohortTrendChart data={trend} />
      </div>

      {/* Per-phase metrics table */}
      {perPhaseMetrics.length > 0 && (
        <Section title="Per-Phase Averages" className="mt-6">
          <div className="overflow-x-auto rounded-xl border bg-[hsl(var(--card))]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <th className="px-4 py-3 font-medium">Phase</th>
                  <th className="px-4 py-3 font-medium text-right">Engaged Users</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Interactions</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Code Gen</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Acceptance</th>
                  <th className="px-4 py-3 font-medium text-right">Avg LoC Added</th>
                  <th className="px-4 py-3 font-medium text-right">Avg PRs Created</th>
                  <th className="px-4 py-3 font-medium text-right">Avg PRs Merged</th>
                  <th className="px-4 py-3 font-medium text-right">Avg Merge Time</th>
                </tr>
              </thead>
              <tbody>
                {perPhaseMetrics.map((p) => (
                  <tr key={p.phase} className="border-b last:border-0 hover:bg-[hsl(var(--accent))]">
                    <td className="px-4 py-3 font-medium">
                      {p.label || `Phase ${p.phase}`}
                    </td>
                    <td className="px-4 py-3 text-right">{p.engaged_users?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.user_initiated_interaction_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.code_generation_activity_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.code_acceptance_activity_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.loc_added_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.pull_requests_created_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.pull_requests_merged_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {p.median_minutes_to_merge_avg != null
                        ? `${p.median_minutes_to_merge_avg.toFixed(0)} min`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
