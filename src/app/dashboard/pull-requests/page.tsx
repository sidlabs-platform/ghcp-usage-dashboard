"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/PageHeader";
import { MetricCard } from "@/components/cards/MetricCard";
import { PRActivityChart } from "@/components/charts/PRActivityChart";
import { MergeTimeChart } from "@/components/charts/MergeTimeChart";
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
}

export default function PullRequestsPage() {
  const [data, setData] = useState<PRData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/metrics/pull-requests")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div>
        <PageHeader title="Pull Request Impact" description="PR activity, merge times, and Copilot contribution" />
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
        <PageHeader title="Pull Request Impact" description="PR activity, merge times, and Copilot contribution" />
        <div className="flex h-64 items-center justify-center text-sm text-red-500">
          {error ?? "Failed to load data"}
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
        description="PR activity, merge times, and Copilot contribution"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 mb-8">
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PRActivityChart data={data.daily} />
        <MergeTimeChart data={mergeTimeData} />
      </div>
    </div>
  );
}
