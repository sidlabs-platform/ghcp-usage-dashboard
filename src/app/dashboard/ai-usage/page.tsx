"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRangeParams } from "@/hooks/useDateRangeParams";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Users, Activity, Percent, FileCode, Bot, MousePointerClick } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import type { AiUsageResponse } from "@/app/api/metrics/ai-usage/route";

const ActiveUsersTrendChart = dynamic(
  () => import("@/components/charts/ActiveUsersTrendChart").then(m => ({ default: m.ActiveUsersTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const LocTrendChart = dynamic(
  () => import("@/components/charts/LocTrendChart").then(m => ({ default: m.LocTrendChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const AcceptanceRateChart = dynamic(
  () => import("@/components/charts/AcceptanceRateChart").then(m => ({ default: m.AcceptanceRateChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const IdeBreakdownChart = dynamic(
  () => import("@/components/charts/IdeBreakdownChart").then(m => ({ default: m.IdeBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const FeatureBreakdownChart = dynamic(
  () => import("@/components/charts/FeatureBreakdownChart").then(m => ({ default: m.FeatureBreakdownChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const LanguageBarChart = dynamic(
  () => import("@/components/charts/LanguageBarChart").then(m => ({ default: m.LanguageBarChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);

export default function AiUsagePage() {
  const { buildParams, dateLabel, filenameSuffix } = useDateRangeParams();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);
  // Guards against a slow earlier request overwriting a newer selection's data
  const requestIdRef = useRef(0);

  const fetchData = useCallback(() => {
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    setLoading(true);
    const params = buildParams(buildScopeParams());

    fetch(`/api/metrics/ai-usage?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<AiUsageResponse>;
      })
      .then((d) => {
        if (requestId !== requestIdRef.current) return;
        setData(d);
        setError(null);
      })
      .catch((err) => {
        if (err.name === "AbortError" || requestId !== requestIdRef.current) return;
        setError(err.message);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });

    return () => controller.abort();
  }, [buildParams, buildScopeParams]);

  useEffect(() => fetchData(), [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title="AI Usage" description="Rolled-up view of Copilot AI activity, lines of code, acceptance, and editors" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {["a", "b", "c", "d", "e", "f"].map((k) => (
            <div key={k} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {["chart-a", "chart-b"].map((k) => <ChartSkeleton key={k} />)}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="AI Usage" description="Rolled-up view of Copilot AI activity, lines of code, acceptance, and editors" />
        <div className="flex h-64 items-center justify-center rounded-xl border bg-[hsl(var(--card))] text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const {
    kpis,
    activeUsersTrend,
    locTrend,
    acceptanceTrend,
    ideBreakdown,
    featureBreakdown,
    languageBreakdown,
  } = data;

  const hasData =
    activeUsersTrend.some((d) => d.daily > 0) ||
    locTrend.some((d) => d.completionAccepted > 0 || d.agentAdded > 0) ||
    ideBreakdown.length > 0;

  return (
    <div>
      <PageHeader
        title="AI Usage"
        description="Rolled-up view of Copilot AI activity, lines of code, acceptance, and editors"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "AI Usage",
            filename: `ai-usage-report-${filenameSuffix}`,
            metadata: {
              reportName: "AI Usage",
              dateRange: dateLabel,
              teams: buildScopeParams().get("teams") || undefined,
              orgs: buildScopeParams().get("orgs") || undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {hasData ? (
        <>
          {/* KPI Cards */}
          <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
            <MetricCard
              title="Monthly Active Users"
              value={kpis.monthlyActiveUsers}
              icon={<Users className="h-4 w-4" />}
              accent="blue"
              subtitle="Distinct users (30d window)"
            />
            <MetricCard
              title="Avg Daily Active"
              value={Math.round(kpis.avgDailyActiveUsers)}
              icon={<Activity className="h-4 w-4" />}
              accent="teal"
              subtitle={`Average DAU · ${dateLabel}`}
            />
            <MetricCard
              title="Engagement (DAU/MAU)"
              value={kpis.stickiness}
              format="percent"
              icon={<Activity className="h-4 w-4" />}
              accent="violet"
              subtitle="Stickiness ratio"
            />
            <MetricCard
              title="Completion Acceptance"
              value={kpis.completionAcceptanceRate}
              format="percent"
              icon={<Percent className="h-4 w-4" />}
              accent="green"
              subtitle="Code completions only"
            />
            <MetricCard
              title="Completion LoC"
              value={kpis.completionLocAccepted}
              icon={<FileCode className="h-4 w-4" />}
              accent="blue"
              subtitle="Accepted lines (completion)"
            />
            <MetricCard
              title="Agent LoC Added"
              value={kpis.agentLocAdded}
              icon={<Bot className="h-4 w-4" />}
              accent="amber"
              subtitle="Lines written by agent"
            />
          </div>

          {/* Charts */}
          <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <ActiveUsersTrendChart data={activeUsersTrend} />
            <AcceptanceRateChart data={acceptanceTrend} />
            <LocTrendChart data={locTrend} />
            <IdeBreakdownChart data={ideBreakdown.map((d) => ({ ide: d.ide, interactions: d.interactions, locAdded: d.locAdded }))} />
            <FeatureBreakdownChart data={featureBreakdown} />
            <LanguageBarChart data={languageBreakdown} title="Top Languages by LoC Added" />
          </div>

          {/* Total interactions footnote */}
          <div className="mt-4 flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
            <MousePointerClick className="h-3.5 w-3.5" />
            <span>{formatNumber(kpis.totalInteractions)} total user-initiated interactions in this period</span>
          </div>
        </>
      ) : (
        <div className="mt-6 flex h-64 items-center justify-center rounded-xl border bg-[hsl(var(--card))] text-sm text-[hsl(var(--muted-foreground))]">
          No AI usage data available for the selected range and filters.
        </div>
      )}

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h2 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/code-generation" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Code Generation →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/adoption-cohorts" className="text-sm text-[hsl(var(--primary))] hover:underline">
            AI Adoption →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/models" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Model Statistics →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/ide-languages" className="text-sm text-[hsl(var(--primary))] hover:underline">
            IDE & Languages →
          </Link>
        </div>
      </section>
    </div>
  );
}
