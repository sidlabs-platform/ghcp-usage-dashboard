import { NextResponse } from "next/server";
import { resolveEnterpriseId, getEnterpriseMetrics, getAllOrgMetrics } from "@/lib/db/metrics-repo";
import { getDateRange } from "@/lib/utils";
import type { PullRequestMetrics } from "@/lib/types/metrics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 90);
    const { start, end } = getDateRange(days);
    const eid = resolveEnterpriseId();

    // Try enterprise metrics first, fall back to org metrics
    let records = eid ? getEnterpriseMetrics(eid, start, end) : [];
    let dataSource = "enterprise";
    if (records.length === 0) {
      records = getAllOrgMetrics(start, end);
      dataSource = "org";
    }

    const daily = records.map((d) => {
      const pr: PullRequestMetrics = d.pull_requests ?? {
        total_created: 0,
        total_reviewed: 0,
        total_merged: 0,
        median_minutes_to_merge: null,
        total_suggestions: 0,
        total_applied_suggestions: 0,
        total_created_by_copilot: 0,
        total_reviewed_by_copilot: 0,
        total_merged_created_by_copilot: 0,
        median_minutes_to_merge_copilot_authored: null,
        total_merged_reviewed_by_copilot: 0,
        median_minutes_to_merge_copilot_reviewed: null,
        total_copilot_suggestions: 0,
        total_copilot_applied_suggestions: 0,
      };
      return { day: d.day, ...pr };
    });

    // Aggregate totals
    const totals = daily.reduce(
      (acc, d) => ({
        created: acc.created + d.total_created,
        reviewed: acc.reviewed + d.total_reviewed,
        merged: acc.merged + d.total_merged,
        createdByCopilot: acc.createdByCopilot + d.total_created_by_copilot,
        mergedCopilot: acc.mergedCopilot + d.total_merged_created_by_copilot,
        mergedReviewedByCopilot: acc.mergedReviewedByCopilot + d.total_merged_reviewed_by_copilot,
        suggestions: acc.suggestions + d.total_suggestions,
        appliedSuggestions: acc.appliedSuggestions + d.total_applied_suggestions,
        copilotSuggestions: acc.copilotSuggestions + d.total_copilot_suggestions,
        copilotApplied: acc.copilotApplied + d.total_copilot_applied_suggestions,
      }),
      {
        created: 0, reviewed: 0, merged: 0,
        createdByCopilot: 0, mergedCopilot: 0, mergedReviewedByCopilot: 0,
        suggestions: 0, appliedSuggestions: 0,
        copilotSuggestions: 0, copilotApplied: 0,
      }
    );

    // Average merge times (from days that have a value)
    const humanMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge !== null)
      .map((d) => d.median_minutes_to_merge as number);
    const copilotMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge_copilot_authored !== null)
      .map((d) => d.median_minutes_to_merge_copilot_authored as number);
    const copilotReviewedMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge_copilot_reviewed !== null)
      .map((d) => d.median_minutes_to_merge_copilot_reviewed as number);

    const avgMergeTime = humanMergeTimes.length > 0
      ? humanMergeTimes.reduce((a, b) => a + b, 0) / humanMergeTimes.length
      : null;
    const avgCopilotMergeTime = copilotMergeTimes.length > 0
      ? copilotMergeTimes.reduce((a, b) => a + b, 0) / copilotMergeTimes.length
      : null;
    const avgCopilotReviewedMergeTime = copilotReviewedMergeTimes.length > 0
      ? copilotReviewedMergeTimes.reduce((a, b) => a + b, 0) / copilotReviewedMergeTimes.length
      : null;

    const copilotPct = totals.created > 0
      ? Number(((totals.createdByCopilot / totals.created) * 100).toFixed(1))
      : 0;

    const suggestionRate = totals.suggestions > 0
      ? Number(((totals.appliedSuggestions / totals.suggestions) * 100).toFixed(1))
      : 0;

    return NextResponse.json({
      daily,
      totals,
      avgMergeTime,
      avgCopilotMergeTime,
      avgCopilotReviewedMergeTime,
      copilotPct,
      suggestionRate,
      dataSource,
      hasData: records.length > 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
