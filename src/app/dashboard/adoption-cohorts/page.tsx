"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton, KPISkeleton } from "@/components/states/ChartSkeleton";
import { Section } from "@/components/ui/Section";
import { useDateRangeParams } from "@/hooks/useDateRangeParams";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Users, TrendingUp, Code2, Bot, Layers, GitMerge } from "lucide-react";
import type { CohortDistributionData } from "@/components/charts/CohortDistributionChart";
import type { CohortMergedData } from "@/components/charts/CohortMergedChart";
import type { CohortTrendDataPoint } from "@/components/charts/CohortTrendChart";
import type { RoiResponse, TotalsByAIAdoptionPhase } from "@/lib/types/metrics";
import { RoiSection } from "@/components/sections/RoiSection";

const CohortDistributionChart = dynamic(
  () => import("@/components/charts/CohortDistributionChart").then((m) => ({ default: m.CohortDistributionChart })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const CohortTrendChart = dynamic(
  () => import("@/components/charts/CohortTrendChart").then((m) => ({ default: m.CohortTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const CohortMergedChart = dynamic(
  () => import("@/components/charts/CohortMergedChart").then((m) => ({ default: m.CohortMergedChart })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface AdoptionCohortsData {
  distribution: CohortDistributionData[];
  trend: CohortTrendDataPoint[];
  perPhaseMetrics: TotalsByAIAdoptionPhase[];
  totalEngaged: number;
  mergedDistribution: CohortMergedData[];
  mergedTrend: CohortTrendDataPoint[];
  totalMerged: number;
  hasMergeData: boolean;
  hasData: boolean;
  dataAsOf: string;
  daysLoaded: number;
  latestDay?: string;
  countBasis?: "window" | "snapshot";
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
  const { buildParams, dateLabel, filenameSuffix } = useDateRangeParams();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<AdoptionCohortsData | null>(null);
  const [roi, setRoi] = useState<RoiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  const mergedRef = useRef<HTMLDivElement>(null);
  const roiRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const controller = new AbortController();
    const params = buildParams(buildScopeParams());

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

    // ROI is supplementary — a failure here hides the section rather than
    // taking down the whole page.
    fetch(`/api/metrics/roi?${params}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((json: RoiResponse & { error?: string }) => {
        setRoi(json.error ? null : json);
      })
      .catch(() => setRoi(null));

    return () => controller.abort();
  }, [buildParams, buildScopeParams]);

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
          <h2 className="text-lg font-semibold mb-2">Error loading data</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">{error}</p>
        </div>
      </div>
    );
  }

  if (!data || !data.hasData || data.distribution.length === 0) {
    return (
      <div>
        <PageHeader title="AI Adoption Cohorts" description="AI adoption maturity phases" />
        <ScopeFilter />
        <div className="rounded-xl border bg-[hsl(var(--card))] p-12 text-center">
          <TrendingUp className="h-12 w-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
          <h2 className="text-lg font-semibold mb-2">No adoption cohort data available</h2>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md mx-auto">
            Adoption cohort data will appear after your next sync. This feature requires data from
            the latest GitHub Copilot usage metrics API (announced May 2026).
          </p>
        </div>
      </div>
    );
  }

  const { distribution, trend, perPhaseMetrics, totalEngaged, mergedDistribution, mergedTrend, totalMerged, hasMergeData } = data;

  return (
    <div>
      <PageHeader
        title="AI Adoption Cohorts"
        description={
          data.countBasis === "snapshot"
            ? `AI adoption maturity phases — ${data.daysLoaded} days · Counts as of ${data.latestDay ?? data.dataAsOf}`
            : `AI adoption maturity phases — ${data.daysLoaded} days · Counts include every user active in the window`
        }
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef, mergedRef, roiRef],
            title: "AI Adoption Cohorts",
            filename: `adoption-cohorts-${filenameSuffix}`,
            metadata: {
              reportName: "AI Adoption Cohorts",
              dateRange: dateLabel,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* Polite live region for screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {!loading && data && `Updated: ${data.totalEngaged} engaged users, last ${data.daysLoaded} days`}
      </div>

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
                subtitle={`Phase ${d.phase} · ${d.percentage.toFixed(1)}% of engaged`}
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

      {/* Delivery impact — total PRs merged by adoption phase (June 2026 API addition) */}
      {hasMergeData && (
        <Section
          title="Delivery Impact by Phase"
          description="Total pull requests merged by each adoption cohort — absolute throughput, not per-user averages."
          className="mt-6"
        >
          <div ref={mergedRef}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
              <MetricCard
                title="Total PRs Merged"
                value={totalMerged}
                icon={<GitMerge className="h-4 w-4" />}
                subtitle={`${data.daysLoaded}-day window`}
                accent="green"
                stagger={1}
              />
              {mergedDistribution
                .filter((d) => d.count > 0)
                .map((d, i) => {
                  const Icon = PHASE_ICONS[d.phase] ?? Users;
                  return (
                    <MetricCard
                      key={d.phase}
                      title={`${d.label} — Merged`}
                      value={d.count}
                      icon={<Icon className="h-4 w-4" />}
                      subtitle={`${d.percentage.toFixed(1)}% of merged`}
                      accent={PHASE_ACCENTS[d.phase] ?? "blue"}
                      stagger={(Math.min(i + 2, 11)) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11}
                    />
                  );
                })}
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <CohortMergedChart data={mergedDistribution} />
              <CohortTrendChart
                data={mergedTrend}
                title="PRs Merged Trend by Phase"
                valueLabel="PRs merged"
              />
            </div>
          </div>
        </Section>
      )}

      {/* Potential ROI — spend vs. pull request output by adoption depth */}
      {roi?.hasData && (
        <div ref={roiRef}>
          <RoiSection data={roi} />
        </div>
      )}

      {/* Per-phase metrics table */}
      {perPhaseMetrics.length > 0 && (
        <Section title="Per-Phase Metrics" className="mt-6">
          <div className="overflow-x-auto rounded-xl border bg-[hsl(var(--card))]">
            <table className="w-full text-sm">
              <caption className="sr-only">Per-Phase Metrics — AI adoption cohort averages and totals</caption>
              <thead>
                <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                  <th scope="col" className="px-4 py-3 font-medium">Phase</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Engaged Users</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg Interactions</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg Code Gen</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg Acceptance</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg LoC Added</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg PRs Created</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg PRs Merged</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Total PRs Merged</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Avg Merge Time</th>
                </tr>
              </thead>
              <tbody>
                {perPhaseMetrics.map((p) => (
                  <tr key={p.phase} className="border-b last:border-0 hover:bg-[hsl(var(--accent))]">
                    <td className="px-4 py-3 font-medium">
                      {p.label}
                      <span className="ml-2 text-xs text-[hsl(var(--muted-foreground))]">
                        Phase {p.phase}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">{p.engaged_users?.toLocaleString() ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.user_initiated_interaction_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.code_generation_activity_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.code_acceptance_activity_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.loc_added_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.pull_requests_created_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{p.pull_requests_merged_avg?.toFixed(1) ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      {typeof p.total_pull_requests_merged === "number"
                        ? p.total_pull_requests_merged.toLocaleString()
                        : "—"}
                    </td>
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
