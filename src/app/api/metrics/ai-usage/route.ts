import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween, parseAndClampDays } from "@/lib/utils";
import { FEATURE_LABELS } from "@/lib/constants";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import {
  getCompletionDailyTrend,
  getCompletionTotals,
  getActiveUsersRollingTrend,
  getIdeBreakdown,
  getFeatureBreakdown,
  getLanguageBreakdown,
  estimateRowCount,
} from "@/lib/db/aggregation-queries";

// ── Response shape ────────────────────────────────────────────────────

export interface AiUsageResponse {
  activeUsersTrend: { day: string; daily: number; weekly: number; monthly: number }[];
  locTrend: { day: string; completionSuggested: number; completionAccepted: number; agentAdded: number; agentDeleted: number }[];
  acceptanceTrend: { day: string; suggested: number; accepted: number; rate: number }[];
  ideBreakdown: { ide: string; interactions: number; locAdded: number; acceptances: number; generations: number }[];
  featureBreakdown: { feature: string; featureLabel: string; locAdded: number; interactions: number; acceptances: number }[];
  languageBreakdown: { language: string; locAdded: number; locSuggested: number }[];
  kpis: {
    monthlyActiveUsers: number;
    avgDailyActiveUsers: number;
    stickiness: number;
    completionAcceptanceRate: number;
    completionLocAccepted: number;
    agentLocAdded: number;
    totalInteractions: number;
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

    const allDays = datesBetween(startDay, endDay);

    // ── Active / engaged users (rolling DAU / WAU / MAU) ──────────────
    const rollingRows = getActiveUsersRollingTrend(startDay, endDay, allowedLogins, enterpriseSlugs);
    const rollingByDay = new Map(rollingRows.map((r) => [r.day, r]));
    const activeUsersTrend = allDays.map((day) => {
      const r = rollingByDay.get(day);
      return {
        day,
        daily: r?.daily ?? 0,
        weekly: r?.weekly ?? 0,
        monthly: r?.monthly ?? 0,
      };
    });

    // ── LOC completion vs agent trend ─────────────────────────────────
    const trendRows = getCompletionDailyTrend(startDay, endDay, allowedLogins, enterpriseSlugs);
    const trendByDay = new Map(trendRows.map((r) => [r.day, r]));
    const locTrend = allDays.map((day) => {
      const r = trendByDay.get(day);
      return {
        day,
        completionSuggested: r?.completionSuggested ?? 0,
        completionAccepted: r?.completionAccepted ?? 0,
        agentAdded: r?.agentAdded ?? 0,
        agentDeleted: r?.agentDeleted ?? 0,
      };
    });

    // ── Acceptance rate trend — completion only ───────────────────────
    const acceptanceTrend = allDays.map((day) => {
      const r = trendByDay.get(day);
      const gen = r?.compGenCount ?? 0;
      const acc = r?.compAcceptCount ?? 0;
      return {
        day,
        suggested: r?.completionSuggested ?? 0,
        accepted: r?.completionAccepted ?? 0,
        rate: gen > 0 ? (acc / gen) * 100 : 0,
      };
    });

    // ── IDE / editor breakdown ────────────────────────────────────────
    const ideBreakdown = getIdeBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs).map((r) => ({
      ide: r.ide,
      interactions: r.interactions,
      locAdded: r.locAdded,
      acceptances: r.acceptances,
      generations: r.generations,
    }));

    // ── Feature & language breakdowns ─────────────────────────────────
    const featureBreakdown = getFeatureBreakdown(startDay, endDay, allowedLogins, enterpriseSlugs).map((r) => ({
      ...r,
      featureLabel: FEATURE_LABELS[r.feature] ?? r.feature,
    }));
    const languageBreakdown = getLanguageBreakdown(startDay, endDay, 15, allowedLogins, enterpriseSlugs);

    // ── KPIs ──────────────────────────────────────────────────────────
    const totals = getCompletionTotals(startDay, endDay, allowedLogins, enterpriseSlugs);
    const dailyCounts = rollingRows.map((r) => r.daily);
    const avgDailyActiveUsers = dailyCounts.length > 0
      ? dailyCounts.reduce((s, n) => s + n, 0) / dailyCounts.length
      : 0;
    // Latest rolling 30-day window count (MAU) within the selected range
    const monthlyActiveUsers = rollingRows.length > 0
      ? rollingRows[rollingRows.length - 1].monthly
      : 0;
    const totalInteractions = featureBreakdown.reduce((s, f) => s + f.interactions, 0);

    return NextResponse.json({
      activeUsersTrend,
      locTrend,
      acceptanceTrend,
      ideBreakdown,
      featureBreakdown,
      languageBreakdown,
      kpis: {
        monthlyActiveUsers,
        avgDailyActiveUsers,
        stickiness: monthlyActiveUsers > 0 ? (avgDailyActiveUsers / monthlyActiveUsers) * 100 : 0,
        completionAcceptanceRate: totals.compGenCount > 0 ? (totals.compAcceptCount / totals.compGenCount) * 100 : 0,
        completionLocAccepted: totals.completionAccepted,
        agentLocAdded: totals.agentAdded,
        totalInteractions,
      },
    } satisfies AiUsageResponse, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
