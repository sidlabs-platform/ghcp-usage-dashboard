"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Users, TrendingUp, BarChart3, Zap, Gauge } from "lucide-react";

interface ImpactData {
  days: number;
  start: string;
  end: string;
  healthScore?: {
    adoptionRate: number;
    acceptanceRate: number;
    featureBreadth: number;
    engagementFrequency: number;
    overallScore: number;
  };
}

const PAGE_TITLE = "Health Score";
const PAGE_DESC = "Copilot program health score and its component metrics";

const COMPONENTS = [
  {
    key: "adoptionRate" as const,
    label: "Adoption Rate",
    weight: 30,
    icon: <Users className="h-4 w-4" />,
    color: "bg-blue-500",
  },
  {
    key: "acceptanceRate" as const,
    label: "Acceptance Rate",
    weight: 25,
    icon: <TrendingUp className="h-4 w-4" />,
    color: "bg-green-500",
  },
  {
    key: "featureBreadth" as const,
    label: "Feature Breadth",
    weight: 25,
    icon: <BarChart3 className="h-4 w-4" />,
    color: "bg-yellow-500",
  },
  {
    key: "engagementFrequency" as const,
    label: "Engagement Frequency",
    weight: 20,
    icon: <Zap className="h-4 w-4" />,
    color: "bg-purple-500",
  },
];

export default function HealthScorePage() {
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
          {Array.from({ length: 5 }).map((_, i) => (
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

  const hs = data.healthScore;

  if (!hs) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESC} />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <Gauge className="h-10 w-10 opacity-40" />
          <div className="text-center">
            <p className="font-medium">Health score data is not available</p>
            <p className="mt-1 max-w-md">
              Health score metrics have not been computed yet. Run a sync to
              generate the data.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const score = Math.round(hs.overallScore);
  const scoreColor =
    score >= 70
      ? "text-green-500"
      : score >= 40
        ? "text-yellow-500"
        : "text-red-500";
  const scoreBorder =
    score >= 70
      ? "border-green-500/30"
      : score >= 40
        ? "border-yellow-500/30"
        : "border-red-500/30";

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESC}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `health-score-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      {/* Overall Score */}
      <Card className={`mb-8 ${scoreBorder}`}>
        <CardContent className="flex items-center gap-6 p-8">
          <Gauge className={`h-14 w-14 ${scoreColor}`} />
          <div>
            <p className="text-sm font-medium text-[hsl(var(--muted-foreground))]">
              Overall Health Score
            </p>
            <p className={`text-5xl font-bold ${scoreColor}`}>
              {score}
              <span className="text-2xl font-normal text-[hsl(var(--muted-foreground))]">
                /100
              </span>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Component Scores */}
      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8"
      >
        {COMPONENTS.map((comp) => (
          <MetricCard
            key={comp.key}
            title={comp.label}
            value={hs[comp.key]}
            format="percent"
            icon={comp.icon}
            subtitle={`Weight: ${comp.weight}%`}
          />
        ))}
      </div>

      {/* How the score is calculated */}
      <div ref={chartsRef}>
        <Card>
          <CardHeader>
            <CardTitle>How the score is calculated</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {COMPONENTS.map((comp) => {
              const val = hs[comp.key];
              return (
                <div key={comp.key}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{comp.label}</span>
                    <span className="text-[hsl(var(--muted-foreground))]">
                      {val.toFixed(1)}% × {comp.weight}% ={" "}
                      {((val * comp.weight) / 100).toFixed(1)} pts
                    </span>
                  </div>
                  <div className="h-4 w-full rounded bg-[hsl(var(--muted))]/30">
                    <div
                      className={`h-4 rounded ${comp.color}`}
                      style={{ width: `${Math.min(val, 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <div className="mt-4 border-t pt-4 text-xs text-[hsl(var(--muted-foreground))]">
              Score = (Adoption × 0.30) + (Acceptance × 0.25) + (Feature
              Breadth × 0.25) + (Engagement × 0.20)
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
