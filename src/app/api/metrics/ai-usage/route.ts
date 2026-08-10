import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween, parseAndClampDays } from "@/lib/utils";
import { FEATURE_LABELS } from "@/lib/constants";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
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

/** Rolling distinct-user counts for a single day. */
export interface ActiveUsersTrendPoint {
  day: string;
  daily: number;
  weekly: number;
  monthly: number;
}

/** Completion vs agent lines-of-code for a single day. */
export interface LocTrendPoint {
  day: string;
  completionSuggested: number;
  completionAccepted: number;
  agentAdded: number;
  agentDeleted: number;
}

/** Completion-only acceptance for a single day. */
export interface AcceptanceTrendPoint {
  day: string;
  suggested: number;
  accepted: number;
  /** Event-count ratio (accepted/generated) as a percentage. */
  rate: number;
}

/** Per-editor activity totals for the selected range. */
export interface IdeBreakdownRow {
  ide: string;
  interactions: number;
  locAdded: number;
  acceptances: number;
  generations: number;
}

/** Per-feature activity totals for the selected range. */
export interface FeatureBreakdownRow {
  feature: string;
  featureLabel: string;
  locAdded: number;
  interactions: number;
  acceptances: number;
}

/** Per-language lines-of-code totals for the selected range. */
export interface LanguageBreakdownRow {
  language: string;
  locAdded: number;
  locSuggested: number;
}

/** Headline numbers shown as KPI cards. */
export interface AiUsageKpis {
  monthlyActiveUsers: number;
  avgDailyActiveUsers: number;
  /** DAU/MAU stickiness as a percentage. */
  stickiness: number;
  /** Completion-only acceptance rate, excluding agent activity. */
  completionAcceptanceRate: number;
  completionLocAccepted: number;
  agentLocAdded: number;
  totalInteractions: number;
}

export interface AiUsageResponse {
  activeUsersTrend: ActiveUsersTrendPoint[];
  locTrend: LocTrendPoint[];
  acceptanceTrend: AcceptanceTrendPoint[];
  ideBreakdown: IdeBreakdownRow[];
  featureBreakdown: FeatureBreakdownRow[];
  languageBreakdown: LanguageBreakdownRow[];
  kpis: AiUsageKpis;
}

// ── GET handler ───────────────────────────────────────────────────────

async function handler(request: NextRequest) {
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
    // Average over every day in the range — days with no activity are absent
    // from rollingRows and must still count as zero, or sparse periods inflate the average.
    const avgDailyActiveUsers = activeUsersTrend.length > 0
      ? activeUsersTrend.reduce((s, d) => s + d.daily, 0) / activeUsersTrend.length
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
    console.error("Failed to build AI usage metrics", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
