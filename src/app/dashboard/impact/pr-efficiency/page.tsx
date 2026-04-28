"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Clock, Bot, Eye, TrendingDown, GitPullRequest } from "lucide-react";
import { formatMinutes, formatNumber } from "@/lib/utils";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

interface PREfficiencyDaily {
  day: string;
  medianMergeMinutes: number;
  medianMergeCopilotAuthored: number;
  medianMergeCopilotReviewed: number;
  totalPrs: number;
  copilotAuthoredPrs: number;
  copilotReviewedPrs: number;
}

interface PREfficiencyKpis {
  avgMergeMinutes: number;
  avgMergeCopilotAuthored: number;
  avgMergeCopilotReviewed: number;
  copilotAuthoredPercent: number;
  copilotReviewedPercent: number;
  totalPrs: number;
}

interface ImpactData {
  days: number;
  start: string;
  end: string;
  prEfficiency?: {
    daily: PREfficiencyDaily[];
    kpis: PREfficiencyKpis;
  };
}

const PAGE_TITLE = "PR Efficiency";
const PAGE_DESCRIPTION =
  "Merge-time trends for all PRs vs. Copilot-authored and Copilot-reviewed PRs";

export default function PREfficiencyPage() {
  const { days } = useDateRange();
  const { buildScopeParams } = useScope();
  const [data, setData] = useState<ImpactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
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
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8">
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
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.prEfficiency) {
    return (
      <div>
        <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION} />
        <div className="flex h-64 items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
          PR efficiency data is not available
        </div>
      </div>
    );
  }

  const { kpis, daily } = data.prEfficiency;

  const timeSavedExists =
    kpis.avgMergeMinutes > 0 &&
    kpis.avgMergeCopilotAuthored > 0 &&
    kpis.avgMergeMinutes - kpis.avgMergeCopilotAuthored > 0;

  const timeSavedValue = timeSavedExists
    ? `${Math.round(kpis.avgMergeMinutes - kpis.avgMergeCopilotAuthored)} min/PR`
    : "N/A";

  return (
    <div>
      <PageHeader title={PAGE_TITLE} description={PAGE_DESCRIPTION}>
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: PAGE_TITLE,
            filename: `pr-efficiency-report-${days}d`,
            metadata: {
              reportName: PAGE_TITLE,
              dateRange: `Last ${days} days`,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter />

      <div
        ref={kpiRef}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 mb-8"
      >
        <MetricCard
          title="Avg Merge Time"
          value={formatMinutes(kpis.avgMergeMinutes)}
          format="raw"
          icon={<Clock className="h-4 w-4" />}
        />
        <MetricCard
          title="Copilot-Authored"
          value={formatMinutes(kpis.avgMergeCopilotAuthored)}
          format="raw"
          icon={<Bot className="h-4 w-4" />}
          subtitle={`${kpis.copilotAuthoredPercent.toFixed(1)}% of PRs`}
        />
        <MetricCard
          title="Copilot-Reviewed"
          value={formatMinutes(kpis.avgMergeCopilotReviewed)}
          format="raw"
          icon={<Eye className="h-4 w-4" />}
        />
        <MetricCard
          title="Time Saved"
          value={timeSavedValue}
          format="raw"
          icon={<TrendingDown className="h-4 w-4" />}
          subtitle="Per Copilot-authored PR"
        />
        <MetricCard
          title="Total PRs"
          value={kpis.totalPrs}
          format="number"
          icon={<GitPullRequest className="h-4 w-4" />}
        />
      </div>

      <div ref={chartsRef}>
        <Card>
          <CardHeader>
            <CardTitle>Daily Merge Time Trends</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={380}>
              <LineChart data={daily}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} />
                <YAxis
                  tick={{ fontSize: 12 }}
                  label={{
                    value: "Minutes",
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 12 },
                  }}
                />
                <Tooltip
                  formatter={(value: number) => [
                    formatMinutes(value),
                    undefined,
                  ]}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="medianMergeMinutes"
                  name="All PRs"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="medianMergeCopilotAuthored"
                  name="Copilot-Authored"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="medianMergeCopilotReviewed"
                  name="Copilot-Reviewed"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
