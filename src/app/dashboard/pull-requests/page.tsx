"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { ScopeFilter } from "@/components/filters/ScopeFilter";
import { ChartSkeleton } from "@/components/states/ChartSkeleton";
import { useDateRange } from "@/contexts/DateRangeContext";
import { useScope } from "@/contexts/ScopeContext";
import { ExportMenu } from "@/components/ui/ExportMenu";

const PRActivityChart = dynamic(
  () => import("@/components/charts/PRActivityChart").then(m => ({ default: m.PRActivityChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
const MergeTimeChart = dynamic(
  () => import("@/components/charts/MergeTimeChart").then(m => ({ default: m.MergeTimeChart })),
  { ssr: false, loading: () => <ChartSkeleton /> }
);
import Link from "next/link";
import { GitPullRequest, GitMerge, Bot, Clock, Eye, CheckCircle } from "lucide-react";
import { formatMinutes } from "@/lib/utils";

interface PRDay {
  day: string;
  total_created: number;
  total_reviewed: number;
  total_merged: number;
  median_minutes_to_merge: number | null;
  median_minutes_to_merge_copilot_authored: number | null;
  median_minutes_to_merge_copilot_reviewed: number | null;
  total_created_by_copilot: number;
  total_merged_reviewed_by_copilot: number;
  total_suggestions: number;
  total_applied_suggestions: number;
}

interface PRData {
  daily: PRDay[];
  totals: {
    created: number;
    reviewed: number;
    merged: number;
    createdByCopilot: number;
    mergedCopilot: number;
    mergedReviewedByCopilot: number;
    suggestions: number;
    appliedSuggestions: number;
    copilotSuggestions: number;
    copilotApplied: number;
  };
  avgMergeTime: number | null;
  avgCopilotMergeTime: number | null;
  avgCopilotReviewedMergeTime: number | null;
  copilotPct: number;
  suggestionRate: number;
  hasData?: boolean;
  dataSource?: string;
}

export default function PullRequestsPage() {
  const { days } = useDateRange();
  const { selectedOrgs } = useScope();
  const [data, setData] = useState<PRData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const kpiRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

  const fetchData= useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    if (selectedOrgs.length > 0) params.set("orgs", selectedOrgs.join(","));

    fetch(`/api/metrics/pull-requests?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [days, selectedOrgs]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Pull Request Impact" description="Copilot-authored and reviewed pull request impact metrics" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-[hsl(var(--muted))]/50" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <PageHeader title="Pull Request Impact" description="Copilot-authored and reviewed pull request impact metrics" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
        </div>
      </div>
    );
  }

  if (!data.hasData) {
    return (
      <div>
        <PageHeader title="Pull Request Impact" description="Copilot-authored and reviewed pull request impact metrics" />
        <div className="flex h-64 flex-col items-center justify-center gap-3 text-sm text-[hsl(var(--muted-foreground))]">
          <GitPullRequest className="h-10 w-10 opacity-40" />
          <div className="text-center">
            <p className="font-medium">No pull request data available</p>
            <p className="mt-1 max-w-md">
              Enterprise-level PR metrics have not been synced yet. Try running a sync with{" "}
              <code className="rounded bg-[hsl(var(--muted))] px-1 py-0.5 text-xs">POST /api/sync?resync=true</code>{" "}
              to re-fetch aggregate data.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const mergeTimeData = data.daily.map((d) => ({
    day: d.day,
    humanMinutes: d.median_minutes_to_merge,
    copilotMinutes: d.median_minutes_to_merge_copilot_authored,
    copilotReviewedMinutes: d.median_minutes_to_merge_copilot_reviewed,
  }));

  const copilotReviewedPct = data.totals.merged > 0
    ? Number(((data.totals.mergedReviewedByCopilot / data.totals.merged) * 100).toFixed(1))
    : 0;

  return (
    <div>
      <PageHeader
        title="Pull Request Impact"
        description="Copilot-authored and reviewed pull request impact metrics"
      >
        <ExportMenu
          pdf={{
            sectionRefs: [kpiRef, chartsRef],
            title: "Pull Request Impact",
            filename: `pull-requests-report-${days}d`,
            metadata: {
              reportName: "Pull Request Impact",
              dateRange: `Last ${days} days`,
              orgs: selectedOrgs.length > 0 ? selectedOrgs.join(", ") : undefined,
            },
          }}
          isReady={!!data}
        />
      </PageHeader>

      <ScopeFilter orgOnly />

      <div ref={kpiRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
        <MetricCard
          title="PRs Created"
          value={data.totals.created}
          icon={<GitPullRequest className="h-4 w-4" />}
          subtitle="Total in period"
        />
        <MetricCard
          title="PRs Merged"
          value={data.totals.merged}
          icon={<GitMerge className="h-4 w-4" />}
          subtitle="Total in period"
        />
        <MetricCard
          title="Copilot-authored"
          value={data.copilotPct}
          format="percent"
          icon={<Bot className="h-4 w-4" />}
          subtitle={`${data.totals.createdByCopilot} of ${data.totals.created} PRs`}
        />
        <MetricCard
          title="Copilot-reviewed"
          value={copilotReviewedPct}
          format="percent"
          icon={<Eye className="h-4 w-4" />}
          subtitle={`${data.totals.mergedReviewedByCopilot} merged with review`}
        />
        <MetricCard
          title="Avg Merge Time"
          value={data.avgMergeTime !== null ? formatMinutes(data.avgMergeTime) : "N/A"}
          format="raw"
          icon={<Clock className="h-4 w-4" />}
          subtitle={data.avgCopilotMergeTime !== null ? `Copilot-authored: ${formatMinutes(data.avgCopilotMergeTime)}` : "Copilot-authored: N/A"}
        />
        <MetricCard
          title="Reviewed Merge Time"
          value={data.avgCopilotReviewedMergeTime !== null ? formatMinutes(data.avgCopilotReviewedMergeTime) : "N/A"}
          format="raw"
          icon={<CheckCircle className="h-4 w-4" />}
          subtitle="Copilot-reviewed PRs"
        />
      </div>

      <div ref={chartsRef} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PRActivityChart data={data.daily} />
        <MergeTimeChart data={mergeTimeData} />
      </div>

      {/* Related Analytics */}
      <section className="mt-8 pt-6 border-t">
        <h2 className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Related Analytics</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/dashboard/code-generation" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Code Generation →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/users" className="text-sm text-[hsl(var(--primary))] hover:underline">
            User Explorer →
          </Link>
          <span className="text-[hsl(var(--border))]">·</span>
          <Link href="/dashboard/teams" className="text-sm text-[hsl(var(--primary))] hover:underline">
            Team Analytics →
          </Link>
        </div>
      </section>
    </div>
  );
}
