import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween, parseAndClampDays } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getCompletionDailyTrend,
  getCompletionTotals,
  getLanguageBreakdown,
  getFeatureBreakdown,
  getModelBreakdown,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";

// ── Response shape ────────────────────────────────────────────────────

export interface CodeGenerationResponse {
  dailyTrend: {
    day: string;
    completionSuggested: number;
    completionAccepted: number;
    agentAdded: number;
    agentDeleted: number;
    appAdded: number;
    appDeleted: number;
  }[];
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
    appLocAdded: number;
    appLocDeleted: number;
    appCodeGenerations: number;
  };
}

// ── GET handler ───────────────────────────────────────────────────────

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

    // All aggregation in SQL — no getAllUserMetrics()
    const allDays = datesBetween(startDay, endDay);

    // Daily completion vs agent trend
    const trendRows = getCompletionDailyTrend(startDay, endDay, allowedLogins, enterpriseSlugs);
    const trendByDay = new Map(trendRows.map((r) => [r.day, r]));

    const dailyTrend = allDays.map((day) => {
      const r = trendByDay.get(day);
      return {
        day,
        completionSuggested: r?.completionSuggested ?? 0,
        completionAccepted: r?.completionAccepted ?? 0,
        agentAdded: r?.agentAdded ?? 0,
        agentDeleted: r?.agentDeleted ?? 0,
        appAdded: r?.appAdded ?? 0,
        appDeleted: r?.appDeleted ?? 0,
      };
    });

    // Acceptance rate — completion only
    const acceptanceRate = allDays.map((day) => {
      const r = trendByDay.get(day);
      const gen = r?.compGenCount ?? 0;
      const acc = r?.compAcceptCount ?? 0;
      return { day, rate: gen > 0 ? (acc / gen) * 100 : 0 };
    });

    // Language, feature, model breakdowns — all SQL
    const languageBreakdown = getLanguageBreakdown(startDay, endDay, 15, allowedLogins, enterpriseSlugs);
    const featureBreakdown = getFeatureBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);
    const modelBreakdown = getModelBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);

    // KPIs — period totals via SQL
    const totals = getCompletionTotals(startDay, endDay, allowedLogins, enterpriseSlugs);
    // Total LoC changed spans every surface: completion (accepted), agent (added + deleted),
    // and Copilot App (added + deleted) — App activity is additive here but never folds into
    // completion-specific KPIs (see completionAcceptanceRate below).
    const totalLocChanged =
      totals.completionAccepted + totals.agentAdded + totals.agentDeleted + totals.appAdded + totals.appDeleted;

    return NextResponse.json({
      dailyTrend,
      acceptanceRate,
      languageBreakdown,
      featureBreakdown,
      modelBreakdown,
      kpis: {
        totalLocChanged,
        // Completion-only ratio — App generations/acceptances must never leak in here.
        completionAcceptanceRate: totals.compGenCount > 0 ? (totals.compAcceptCount / totals.compGenCount) * 100 : 0,
        completionLocSuggested: totals.completionSuggested,
        completionLocAccepted: totals.completionAccepted,
        agentLocAdded: totals.agentAdded,
        agentLocDeleted: totals.agentDeleted,
        // Share of "added" LoC across all writing surfaces (completion, agent, Copilot App).
        // Copilot App added LoC must be counted in the denominator alongside completion and
        // agent so App activity doesn't silently inflate the agent's apparent share.
        agentLocShare: (totals.completionAccepted + totals.agentAdded + totals.appAdded) > 0
          ? (totals.agentAdded / (totals.completionAccepted + totals.agentAdded + totals.appAdded)) * 100 : 0,
        totalCodeGenerations: totals.compGenCount,
        appLocAdded: totals.appAdded,
        appLocDeleted: totals.appDeleted,
        appCodeGenerations: totals.appGenCount,
      },
    } as CodeGenerationResponse, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
