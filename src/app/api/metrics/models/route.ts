import { NextRequest, NextResponse } from "next/server";
import { getAllUserMetrics } from "@/lib/db/metrics-repo";
import { getDateRange, datesBetween } from "@/lib/utils";
import { FEATURE_LABELS } from "@/lib/constants";
import { parseScopeFilter, filterByScope } from "@/lib/api/scope-filter";

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
    const days = Number(params.get("days") ?? 7);
    const { start: startDay, end: endDay } = getDateRange(days);

    const scopeFilter = parseScopeFilter(params);
    const userRecords = filterByScope(getAllUserMetrics(startDay, endDay, scopeFilter.enterpriseSlugs), scopeFilter);

    // Model breakdown (total interactions per model)
    const modelMap = new Map<string, number>();
    for (const r of userRecords) {
      for (const m of r.totals_by_model_feature ?? []) {
        modelMap.set(m.model, (modelMap.get(m.model) ?? 0) + (m.user_initiated_interaction_count ?? 0));
      }
    }
    const modelBreakdown = [...modelMap.entries()]
      .map(([model, interactions]) => ({ model, interactions }))
      .sort((a, b) => b.interactions - a.interactions);

    // Model × Feature breakdown
    const mfMap = new Map<string, number>();
    for (const r of userRecords) {
      for (const m of r.totals_by_model_feature ?? []) {
        const key = `${m.model}|||${m.feature}`;
        mfMap.set(key, (mfMap.get(key) ?? 0) + (m.user_initiated_interaction_count ?? 0));
      }
    }
    const modelByFeature = [...mfMap.entries()]
      .map(([key, interactions]) => {
        const [model, feature] = key.split("|||");
        return { model, feature, featureLabel: FEATURE_LABELS[feature] || feature, interactions };
      })
      .sort((a, b) => b.interactions - a.interactions);

    // Model usage trend over time (top 8 models as series)
    const topModels = modelBreakdown.slice(0, 8).map((m) => m.model);
    const byDay = new Map<string, Map<string, number>>();
    for (const r of userRecords) {
      let dayMap = byDay.get(r.day);
      if (!dayMap) { dayMap = new Map(); byDay.set(r.day, dayMap); }
      for (const m of r.totals_by_model_feature ?? []) {
        if (topModels.includes(m.model)) {
          dayMap.set(m.model, (dayMap.get(m.model) ?? 0) + (m.user_initiated_interaction_count ?? 0));
        }
      }
    }
    const allDays = datesBetween(startDay, endDay);
    const modelTrend = allDays.map((day) => {
      const dayMap = byDay.get(day);
      const entry: Record<string, string | number> = { day };
      for (const model of topModels) {
        entry[model] = dayMap?.get(model) ?? 0;
      }
      return entry;
    });

    // Model × Language breakdown
    const mlMap = new Map<string, number>();
    for (const r of userRecords) {
      for (const m of r.totals_by_language_model ?? []) {
        const key = `${m.model}|||${m.language}`;
        mlMap.set(key, (mlMap.get(key) ?? 0) + (m.user_initiated_interaction_count ?? 0));
      }
    }
    const modelByLanguage = [...mlMap.entries()]
      .map(([key, interactions]) => {
        const [model, language] = key.split("|||");
        return { model, language, interactions };
      })
      .sort((a, b) => b.interactions - a.interactions)
      .slice(0, 50);

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
