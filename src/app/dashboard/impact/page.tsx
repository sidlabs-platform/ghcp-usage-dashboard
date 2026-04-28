"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { formatMinutes } from "@/lib/utils";
import {
  Activity,
  TrendingUp,
  Users,
  Zap,
  Shield,
  BarChart3,
  Target,
  Gauge,
} from "lucide-react";

interface ImpactData {
  days: number;
  start: string;
  end: string;
  prEfficiency?: {
    kpis: {
      avgMergeMinutes: number;
      avgMergeCopilotAuthored: number;
      avgMergeCopilotReviewed: number;
      copilotAuthoredPercent: number;
      copilotReviewedPercent: number;
      totalPrs: number;
    };
  };
  agentImpact?: {
    kpis: {
      totalAgentUsers: number;
      totalCodingAgentUsers: number;
      agentLocAdded: number;
      agentLocDeleted: number;
      totalLocAdded: number;
      totalLocDeleted: number;
      agentLocPercent: number;
    };
  };
  licenseUtilization?: {
    kpis: {
      totalSeats: number;
      activeLast30d: number;
      inactiveSeats: number;
      pendingCancellation: number;
      utilizationPercent: number;
    };
  };
  codeReviewImpact?: {
    kpis: {
      totalReviewedByCopilot: number;
      totalSuggestions: number;
      totalAppliedSuggestions: number;
      suggestionAcceptanceRate: number;
      codeReviewActiveUsers: number;
      codeReviewPassiveUsers: number;
    };
  };
  engagementDepth?: {
    averageDepth: number;
    totalUsers: number;
  };
  adoptionFunnel?: {
    totalSeats: number;
    activeUsers: number;
    regularUsers: number;
    powerUsers: number;
  };
  healthScore?: {
    adoptionRate: number;
    acceptanceRate: number;
    featureBreadth: number;
    engagementFrequency: number;
    overallScore: number;
  };
}

const PAGE_TITLE = "Impact Overview";
const PAGE_DESC = "Executive summary of Copilot impact across your organization";

export default function ImpactOverviewPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    const scopeParams = buildScopeParams();
    const params = new URLSearchParams({ days: String(days) });
    scopeParams.forEach((v, k) => params.set(k, v));

    fetch(`/api/metrics/impact?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, buildScopeParams]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  const score = data.healthScore?.overallScore;
  const scoreColor =
    score == null
      ? "text-[hsl(var(--muted-foreground))]"
      : score >= 70
        ? "text-green-500"
        : score >= 40
          ? "text-yellow-500"
          : "text-red-500";

  const funnel = data.adoptionFunnel;
  const funnelMax = funnel?.totalSeats ?? 1;

  const funnelStages = funnel
    ? [
        { label: "Total Seats", value: funnel.totalSeats, color: "bg-blue-500" },
        { label: "Active Users", value: funnel.activeUsers, color: "bg-green-500" },
        { label: "Regular Users", value: funnel.regularUsers, color: "bg-yellow-500" },
        { label: "Power Users", value: funnel.powerUsers, color: "bg-purple-500" },
      ]
    : [];

  const timeSaved =
    data.prEfficiency
      ? Math.max(
          0,
          data.prEfficiency.kpis.avgMergeMinutes -
            data.prEfficiency.kpis.avgMergeCopilotAuthored,
        )
      : null;

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESC}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `impact-overview-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* Health Score Hero */}
      {score != null && (
        <div className="mb-8 flex items-center gap-4 rounded-xl border bg-[hsl(var(--card))] p-6 shadow-sm">
          <Gauge className={`h-10 w-10 ${scoreColor}`} />
          <div>
            <p className="text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Health Score
            </p>
            <p className={`text-4xl font-bold ${scoreColor}`}>
              {Math.round(score)}
              <span className="text-lg font-normal text-[hsl(var(--muted-foreground))]">
                /100
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Adoption Funnel */}
      {funnel && (
        <div
          ref={chartsRef}
          className="mb-8 rounded-xl border bg-[hsl(var(--card))] p-6 shadow-sm"
        >
          <h3 className="mb-4 text-lg font-semibold">Adoption Funnel</h3>
          <div className="space-y-3">
            {funnelStages.map((stage) => {
              const pct = funnelMax > 0 ? (stage.value / funnelMax) * 100 : 0;
              return (
                <div key={stage.label}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span>{stage.label}</span>
                    <span className="font-medium">
                      {stage.value.toLocaleString()} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-6 w-full rounded bg-[hsl(var(--muted))]/30">
                    <div
                      className={`h-6 rounded ${stage.color}`}
                      style={{ width: `${Math.max(pct, 1)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Key Metrics Grid */}
      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-8">
        {data.prEfficiency && (
          <>
            <MetricCard
              title="PR Merge Time"
              value={formatMinutes(data.prEfficiency.kpis.avgMergeMinutes)}
              format="raw"
              icon={<Activity className="h-4 w-4" />}
              subtitle="Average across all PRs"
            />
            <MetricCard
              title="Time Saved"
              value={timeSaved != null ? `${Math.round(timeSaved)}m saved` : "N/A"}
              format="raw"
              icon={<TrendingUp className="h-4 w-4" />}
              subtitle="Copilot-authored vs. all PRs"
            />
          </>
        )}

        {data.agentImpact && (
          <MetricCard
            title="Agent LoC %"
            value={data.agentImpact.kpis.agentLocPercent}
            format="percent"
            icon={<Zap className="h-4 w-4" />}
            subtitle="Lines of code by agent"
          />
        )}

        {data.licenseUtilization && (
          <MetricCard
            title="License Utilization"
            value={data.licenseUtilization.kpis.utilizationPercent}
            format="percent"
            icon={<Target className="h-4 w-4" />}
            subtitle={`${data.licenseUtilization.kpis.activeLast30d} of ${data.licenseUtilization.kpis.totalSeats} seats active`}
          />
        )}

        {data.engagementDepth && (
          <MetricCard
            title="Engagement Depth"
            value={data.engagementDepth.averageDepth.toFixed(1)}
            format="raw"
            icon={<BarChart3 className="h-4 w-4" />}
            subtitle="/5 features used on average"
          />
        )}

        {data.codeReviewImpact && (
          <MetricCard
            title="Code Review Acceptance"
            value={data.codeReviewImpact.kpis.suggestionAcceptanceRate}
            format="percent"
            icon={<Shield className="h-4 w-4" />}
            subtitle={`${data.codeReviewImpact.kpis.totalAppliedSuggestions} of ${data.codeReviewImpact.kpis.totalSuggestions} applied`}
          />
        )}

        {data.healthScore && (
          <MetricCard
            title="Adoption Rate"
            value={data.healthScore.adoptionRate}
            format="percent"
            icon={<Users className="h-4 w-4" />}
            subtitle="Active / total seats"
          />
        )}
      </div>
    </div>
  );
}
