import { NextRequest, NextResponse } from "next/server";
import { datesBetween, resolveWindow } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getCompletionDailyTrend,
  getCompletionTotals,
  acceptanceRateFrom,
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
    /** Copilot CLI LoC written directly to files — not "accepted" suggestions. */
    cliLocAdded: number;
    cliLocDeleted: number;
    cliCodeGenerations: number;
    cliLocShare: number;
  };
}

// ── GET handler ───────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const window = resolveWindow(params, 7);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { start: startDay, end: endDay } = window;

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

    // Acceptance rate — completion + CLI (shared definition; see acceptanceRateFrom)
    const acceptanceRate = allDays.map((day) => {
      const r = trendByDay.get(day);
      return { day, rate: r ? acceptanceRateFrom(r) : 0 };
    });

    // Language, feature, model breakdowns — all SQL
    const languageBreakdown = getLanguageBreakdown(startDay, endDay, 15, allowedLogins, enterpriseSlugs);
    const featureBreakdown = getFeatureBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);
    const modelBreakdown = getModelBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs);

    // KPIs — period totals via SQL
    const totals = getCompletionTotals(startDay, endDay, allowedLogins, enterpriseSlugs);
    // Total LoC changed spans every surface: completion (accepted), agent (added + deleted),
    // Copilot App (added + deleted) and the CLI (added + deleted). The CLI was previously
    // absent here, which under-reported total LoC by an order of magnitude on CLI-heavy
    // fleets. It is additive here but never folds into completion-specific KPIs
    // (see completionAcceptanceRate below).
    const totalLocChanged =
      totals.completionAccepted + totals.agentAdded + totals.agentDeleted
      + totals.appAdded + totals.appDeleted + totals.cliAdded + totals.cliDeleted;
    // Denominator shared by every "share of added LoC" KPI, so the surface
    // shares are mutually consistent and sum to 100%.
    const totalLocAdded = totals.completionAccepted + totals.agentAdded + totals.appAdded + totals.cliAdded;

    return NextResponse.json({
      dailyTrend,
      acceptanceRate,
      languageBreakdown,
      featureBreakdown,
      modelBreakdown,
      kpis: {
        totalLocChanged,
        // Completion + CLI ratio — App and agent generations must never leak in here.
        completionAcceptanceRate: acceptanceRateFrom(totals),
        completionLocSuggested: totals.completionSuggested,
        completionLocAccepted: totals.completionAccepted,
        agentLocAdded: totals.agentAdded,
        agentLocDeleted: totals.agentDeleted,
        // Share of "added" LoC across all writing surfaces (completion, agent,
        // Copilot App, CLI). Every writing surface must be in the denominator
        // or the remaining ones inflate each other's apparent share.
        agentLocShare: totalLocAdded > 0 ? (totals.agentAdded / totalLocAdded) * 100 : 0,
        totalCodeGenerations: totals.compGenCount + totals.cliGenCount,
        appLocAdded: totals.appAdded,
        appLocDeleted: totals.appDeleted,
        appCodeGenerations: totals.appGenCount,
        cliLocAdded: totals.cliAdded,
        cliLocDeleted: totals.cliDeleted,
        cliCodeGenerations: totals.cliGenCount,
        cliLocShare: totalLocAdded > 0 ? (totals.cliAdded / totalLocAdded) * 100 : 0,
      },
    } as CodeGenerationResponse, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
