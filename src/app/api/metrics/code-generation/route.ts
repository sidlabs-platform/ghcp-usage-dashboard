import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween } from "@/lib/utils";

// ── Response shape ────────────────────────────────────────────────────

export interface CodeGenerationResponse {
  dailyTrend: { day: string; completionSuggested: number; completionAccepted: number; agentAdded: number; agentDeleted: number }[];
  acceptanceRate: { day: string; rate: number }[];
  languageBreakdown: { language: string; locAdded: number; locSuggested: number }[];
  featureBreakdown: { feature: string; locAdded: number; interactions: number; acceptances: number }[];
  modelBreakdown: { model: string; interactions: number }[];
  kpis: {
    totalLocChanged: number;
    completionAcceptanceRate: number;
    completionLocSuggested: number;
    completionLocAccepted: number;
    agentLocAdded: number;
    agentLocDeleted: number;
    agentLocShare: number;
    totalCodeGenerations: number;
  };
}

// ── GET handler ───────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    const { resolveEnterpriseId, getAllUserMetrics } = await import("@/lib/db/metrics-repo");
    const { extractCompletionMetrics, extractAgentMetrics } = await import("@/lib/aggregation/separate-metrics");

    const defaultRange = getDateRange(90);
    const startDay = params.get("startDay") || defaultRange.start;
    const endDay = params.get("endDay") || defaultRange.end;

    // Use user-level data — it always has totals_by_feature
    const userRecords = getAllUserMetrics(startDay, endDay);

    // Group by day
    const byDay = new Map<string, typeof userRecords>();
    for (const r of userRecords) {
      const arr = byDay.get(r.day) ?? [];
      arr.push(r);
      byDay.set(r.day, arr);
    }

    const allDays = datesBetween(startDay, endDay);

    // Daily trend — separated completion vs agent
    const dailyTrend = allDays.map((day) => {
      const dayRecords = byDay.get(day) || [];
      let compSuggested = 0, compAccepted = 0, agentAdded = 0, agentDeleted = 0;
      for (const r of dayRecords) {
        const comp = extractCompletionMetrics(r.totals_by_feature || []);
        const agent = extractAgentMetrics(r.totals_by_feature || []);
        compSuggested += comp.locSuggested;
        compAccepted += comp.locAccepted;
        agentAdded += agent.locAdded;
        agentDeleted += agent.locDeleted;
      }
      return { day, completionSuggested: compSuggested, completionAccepted: compAccepted, agentAdded, agentDeleted };
    });

    // Acceptance rate — completion only
    const acceptanceRate = allDays.map((day) => {
      const dayRecords = byDay.get(day) || [];
      let gen = 0, acc = 0;
      for (const r of dayRecords) {
        const comp = extractCompletionMetrics(r.totals_by_feature || []);
        gen += comp.codeGenCount;
        acc += comp.codeAcceptCount;
      }
      return { day, rate: gen > 0 ? (acc / gen) * 100 : 0 };
    });

    // Language breakdown
    const langMap = new Map<string, { locAdded: number; locSuggested: number }>();
    for (const r of userRecords) {
      for (const lf of r.totals_by_language_feature ?? []) {
        const prev = langMap.get(lf.language) ?? { locAdded: 0, locSuggested: 0 };
        prev.locAdded += lf.loc_added_sum;
        prev.locSuggested += lf.loc_suggested_to_add_sum;
        langMap.set(lf.language, prev);
      }
    }
    const languageBreakdown = [...langMap.entries()]
      .map(([language, v]) => ({ language, ...v }))
      .sort((a, b) => b.locAdded - a.locAdded)
      .slice(0, 15);

    // Feature breakdown
    const featMap = new Map<string, { locAdded: number; interactions: number; acceptances: number }>();
    for (const r of userRecords) {
      for (const f of r.totals_by_feature ?? []) {
        const prev = featMap.get(f.feature) ?? { locAdded: 0, interactions: 0, acceptances: 0 };
        prev.locAdded += f.loc_added_sum;
        prev.interactions += f.code_generation_activity_count;
        prev.acceptances += f.code_acceptance_activity_count;
        featMap.set(f.feature, prev);
      }
    }
    const featureBreakdown = [...featMap.entries()]
      .map(([feature, v]) => ({ feature, ...v }))
      .sort((a, b) => b.locAdded - a.locAdded);

    // Model breakdown
    const modelMap = new Map<string, number>();
    for (const r of userRecords) {
      for (const m of r.totals_by_model_feature ?? []) {
        modelMap.set(m.model, (modelMap.get(m.model) ?? 0) + m.user_initiated_interaction_count);
      }
    }
    const modelBreakdown = [...modelMap.entries()]
      .map(([model, interactions]) => ({ model, interactions }))
      .sort((a, b) => b.interactions - a.interactions);

    // KPIs — separated completion vs agent
    let compSuggestedTotal = 0, compAcceptedTotal = 0, compGenTotal = 0, compAcceptCountTotal = 0;
    let agentLocAddedTotal = 0, agentLocDeletedTotal = 0;
    for (const r of userRecords) {
      const comp = extractCompletionMetrics(r.totals_by_feature || []);
      const agent = extractAgentMetrics(r.totals_by_feature || []);
      compSuggestedTotal += comp.locSuggested;
      compAcceptedTotal += comp.locAccepted;
      compGenTotal += comp.codeGenCount;
      compAcceptCountTotal += comp.codeAcceptCount;
      agentLocAddedTotal += agent.locAdded;
      agentLocDeletedTotal += agent.locDeleted;
    }

    const totalLocChanged = compAcceptedTotal + agentLocAddedTotal + agentLocDeletedTotal;

    return NextResponse.json({
      dailyTrend,
      acceptanceRate,
      languageBreakdown,
      featureBreakdown,
      modelBreakdown,
      kpis: {
        totalLocChanged,
        completionAcceptanceRate: compGenTotal > 0 ? (compAcceptCountTotal / compGenTotal) * 100 : 0,
        completionLocSuggested: compSuggestedTotal,
        completionLocAccepted: compAcceptedTotal,
        agentLocAdded: agentLocAddedTotal,
        agentLocDeleted: agentLocDeletedTotal,
        agentLocShare: (compAcceptedTotal + agentLocAddedTotal) > 0
          ? (agentLocAddedTotal / (compAcceptedTotal + agentLocAddedTotal)) * 100 : 0,
        totalCodeGenerations: compGenTotal,
      },
    } as CodeGenerationResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}