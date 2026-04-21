import { NextResponse } from "next/server";
import { getDateRange } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getFeatureBreakdown,
  getFeatureDailyTrend,
  getAdoptionDailyTrend,
  getAdoptionStats,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);

    const scopeFilter = parseScopeFilter(searchParams);
    const allowedLogins = scopeFilter.allowedLogins ? Array.from(scopeFilter.allowedLogins) : undefined;
    const { enterpriseSlugs } = scopeFilter;

    // Row-count guard
    const estimate = estimateRowCount(start, end, allowedLogins, enterpriseSlugs);
    if (estimate.exceeds) {
      return NextResponse.json(
        { error: `Result set too large (${estimate.count.toLocaleString()} rows). Try a narrower date range or add filters.` },
        { status: 400 },
      );
    }

    // ── Feature breakdown via SQL json_each ──────────────────────────
    const featureDistribution = getFeatureBreakdown(start, end, allowedLogins, enterpriseSlugs);

    // ── Daily feature trend via SQL json_each ─────────────────────────
    const dailyRows = getFeatureDailyTrend(start, end, allowedLogins, enterpriseSlugs);

    // Pivot: group by day → { day, [feature]: interactions }
    const dailyMap = new Map<string, Record<string, number>>();
    for (const r of dailyRows) {
      const entry = dailyMap.get(r.day) ?? {};
      entry[r.feature] = (entry[r.feature] ?? 0) + r.interactions;
      dailyMap.set(r.day, entry);
    }
    const dailyTrend = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, feats]) => ({ day, ...feats }));

    // ── Adoption trend via SQL structured columns ─────────────────────
    const adoptionTrend = getAdoptionDailyTrend(start, end, allowedLogins, enterpriseSlugs);

    // ── KPIs via SQL ──────────────────────────────────────────────────
    const adoption = getAdoptionStats(start, end, allowedLogins, enterpriseSlugs);
    const totalInteractions = featureDistribution.reduce((s, f) => s + f.interactions, 0);
    const totalActivity = featureDistribution.reduce((s, f) => s + f.interactions + f.acceptances, 0);
    const topFeature = featureDistribution.length > 0 ? featureDistribution[0].feature : "N/A";
    const totalUniqueUsers = adoption.totalUsers || 1;

    const kpis = {
      totalInteractions,
      totalActivity,
      topFeature,
      agentAdoptionPct: Number(((adoption.agentUsers / totalUniqueUsers) * 100).toFixed(1)),
      chatAdoptionPct: Number((((adoption.totalUsers - adoption.cliUsers) / totalUniqueUsers) * 100).toFixed(1)),
      cliAdoptionPct: Number(((adoption.cliUsers / totalUniqueUsers) * 100).toFixed(1)),
    };

    return NextResponse.json({ dailyTrend, featureDistribution, adoptionTrend, kpis }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
