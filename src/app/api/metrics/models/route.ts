import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween, parseAndClampDays } from "@/lib/utils";
import { FEATURE_LABELS } from "@/lib/constants";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getModelBreakdown,
  getModelByFeatureBreakdown,
  getModelTrend,
  getModelByLanguageBreakdown,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";

export interface ModelStatsResponse {
  modelBreakdown: { model: string; interactions: number }[];
  modelByFeature: { model: string; feature: string; featureLabel: string; interactions: number }[];
  modelTrend: { day: string; [model: string]: string | number }[];
  modelByLanguage: { model: string; language: string; interactions: number }[];
  kpis: {
    totalModels: number;
    totalInteractions: number;
    topModel: string;
    topModelPct: number;
  };
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start: startDay, end: endDay } = getDateRange(days);

    const scopeFilter = parseScopeFilter(params);
    const allowedLogins = scopeFilter.allowedLogins ? Array.from(scopeFilter.allowedLogins) : undefined;
    const { enterpriseSlugs } = scopeFilter;

    // Row-count guard
    const estimate = estimateRowCount(startDay, endDay, allowedLogins, enterpriseSlugs);
    if (estimate.exceeds) {
      return NextResponse.json(
        { error: `Result set too large (${estimate.count.toLocaleString()} rows). Try a narrower date range or add filters.` },
        { status: 400 },
      );
    }

    // All aggregation done in SQL via json_each — no getAllUserMetrics()
    const modelBreakdown = getModelBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);

    const modelByFeatureRaw = getModelByFeatureBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);
    const modelByFeature = modelByFeatureRaw.map((r) => ({
      ...r,
      featureLabel: FEATURE_LABELS[r.feature] || r.feature,
    }));

    // Model trend: top 8 models as series
    const topModels = modelBreakdown.slice(0, 8).map((m) => m.model);
    const trendRows = getModelTrend(startDay, endDay, topModels, allowedLogins, enterpriseSlugs);

    // Pivot trend rows into { day, model1: count, model2: count, ... }
    const allDays = datesBetween(startDay, endDay);
    const trendByDay = new Map<string, Record<string, number>>();
    for (const r of trendRows) {
      const dayMap = trendByDay.get(r.day) ?? {};
      dayMap[r.model] = r.interactions;
      trendByDay.set(r.day, dayMap);
    }
    const modelTrend = allDays.map((day) => {
      const dayMap = trendByDay.get(day);
      const entry: Record<string, string | number> = { day };
      for (const model of topModels) {
        entry[model] = dayMap?.[model] ?? 0;
      }
      return entry;
    });

    const modelByLanguage = getModelByLanguageBreakdown(startDay, endDay, 50, allowedLogins, enterpriseSlugs);

    // KPIs
    const totalInteractions = modelBreakdown.reduce((s, m) => s + m.interactions, 0);
    const topModel = modelBreakdown[0];

    return NextResponse.json({
      modelBreakdown,
      modelByFeature,
      modelTrend,
      modelByLanguage,
      kpis: {
        totalModels: modelBreakdown.length,
        totalInteractions,
        topModel: topModel?.model ?? "N/A",
        topModelPct: totalInteractions > 0 && topModel
          ? (topModel.interactions / totalInteractions) * 100 : 0,
      },
    } as ModelStatsResponse, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
