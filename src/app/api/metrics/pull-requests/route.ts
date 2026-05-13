import { NextResponse } from "next/server";
import { resolveEnterpriseId, getEnterpriseMetrics, getAllOrgMetrics, getFilteredOrgMetrics, countEffectiveEnterprises } from "@/lib/db/metrics-repo";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import type { PullRequestMetrics } from "@/lib/types/metrics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const daysResult = parseAndClampDays(searchParams.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);

    // Org-only filtering for PRs (team filtering not available — data is org-level aggregate)
    const orgsParam = searchParams.get("orgs");
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasOrgFilter = selectedOrgs.length > 0;

    const enterprisesParam = searchParams.get("enterprises");
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;

    // Skip enterprise-level data when multiple enterprises exist (would produce duplicate days)
    const isMultiEnterprise = !hasOrgFilter && countEffectiveEnterprises(enterpriseSlugs) > 1;
    const eid = hasOrgFilter || isMultiEnterprise ? null : resolveEnterpriseId(enterpriseSlugs);

    // Try enterprise metrics first, fall back to org metrics
    let records = eid ? getEnterpriseMetrics(start, end, enterpriseSlugs) : [];
    let dataSource = "enterprise";
    if (records.length === 0 || hasOrgFilter) {
      records = hasOrgFilter ? getFilteredOrgMetrics(selectedOrgs, start, end, enterpriseSlugs) : getAllOrgMetrics(start, end, enterpriseSlugs);
      dataSource = hasOrgFilter ? "org-filtered" : "org";
    }

    // Normalize PR fields — older API versions omit fields added later
    const defaults: PullRequestMetrics = {
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

    const daily = records.map((d) => {
      const pr = { ...defaults, ...(d.pull_requests ?? {}) };
      return { day: d.day, ...pr };
    });

    // Aggregate totals (use ?? 0 to guard against any remaining undefined)
    const totals = daily.reduce(
      (acc, d) => ({
        created: acc.created + (d.total_created ?? 0),
        reviewed: acc.reviewed + (d.total_reviewed ?? 0),
        merged: acc.merged + (d.total_merged ?? 0),
        createdByCopilot: acc.createdByCopilot + (d.total_created_by_copilot ?? 0),
        mergedCopilot: acc.mergedCopilot + (d.total_merged_created_by_copilot ?? 0),
        mergedReviewedByCopilot: acc.mergedReviewedByCopilot + (d.total_merged_reviewed_by_copilot ?? 0),
        suggestions: acc.suggestions + (d.total_suggestions ?? 0),
        appliedSuggestions: acc.appliedSuggestions + (d.total_applied_suggestions ?? 0),
        copilotSuggestions: acc.copilotSuggestions + (d.total_copilot_suggestions ?? 0),
        copilotApplied: acc.copilotApplied + (d.total_copilot_applied_suggestions ?? 0),
      }),
      {
        created: 0, reviewed: 0, merged: 0,
        createdByCopilot: 0, mergedCopilot: 0, mergedReviewedByCopilot: 0,
        suggestions: 0, appliedSuggestions: 0,
        copilotSuggestions: 0, copilotApplied: 0,
      }
    );

    // Average merge times (from days that have a numeric value)
    const humanMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge != null)
      .map((d) => d.median_minutes_to_merge as number);
    const copilotMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge_copilot_authored != null)
      .map((d) => d.median_minutes_to_merge_copilot_authored as number);
    const copilotReviewedMergeTimes = daily
      .filter((d) => d.median_minutes_to_merge_copilot_reviewed != null)
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
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
