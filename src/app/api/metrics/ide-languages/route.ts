import { NextResponse } from "next/server";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getIdeBreakdown,
  getIdeTrend,
  getLanguageByFeatureBreakdown,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const daysResult = parseAndClampDays(searchParams.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
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

    // IDE breakdown — all SQL via json_each
    const ideDistribution = getIdeBreakdown(start, end, allowedLogins, enterpriseSlugs).map((r) => ({
      name: r.ide,
      locAdded: r.locAdded,
      locDeleted: r.locDeleted,
      interactions: r.interactions,
      generations: r.generations,
      acceptances: r.acceptances,
    }));

    // IDE trend by day — SQL via json_each
    const trendRows = getIdeTrend(start, end, allowedLogins, enterpriseSlugs);

    // Pivot: group by day → { day, [ide]: interactions }
    const trendMap = new Map<string, Record<string, number>>();
    for (const r of trendRows) {
      const entry = trendMap.get(r.day) ?? {};
      entry[r.ide] = (entry[r.ide] ?? 0) + r.interactions;
      trendMap.set(r.day, entry);
    }
    const ideTrend = Array.from(trendMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, ides]) => ({ day, ...ides }));

    // Language breakdown — SQL via json_each
    const langRows = getLanguageByFeatureBreakdown(start, end, allowedLogins, enterpriseSlugs);
    const languageDistribution = langRows.map((r) => ({
      name: r.language,
      locAdded: r.locAdded,
      locDeleted: r.locDeleted,
      generations: r.generations,
      acceptances: r.acceptances,
    }));

    const allIdes = ideDistribution.map((i) => i.name);

    return NextResponse.json({
      ideDistribution,
      languageDistribution,
      ideTrend,
      allIdes,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
