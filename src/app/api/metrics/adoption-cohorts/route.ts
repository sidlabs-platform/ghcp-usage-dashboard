import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { resolveWindow } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { countEffectiveEnterprises, getPhaseDeveloperCounts } from "@/lib/db/metrics-repo";
import { parsePhaseTotals, phaseLabel, phaseNumberSql } from "@/lib/metrics/adoption-phase";
import type { TotalsByAIAdoptionPhase } from "@/lib/types/metrics";

/** Resolved adoption phase per user row, shared by every user-level query here. */
const USER_PHASE_SQL = phaseNumberSql("u.ai_adoption_phase");

function buildLoginFilter(logins: string[], alias = ""): { clause: string; params: string[] } {
  if (logins.length === 0) return { clause: "", params: [] };
  const placeholders = logins.map(() => "?").join(",");
  return { clause: ` AND ${alias}user_login IN (${placeholders})`, params: logins };
}

function buildEnterpriseFilter(slugs?: string[], alias = ""): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND ${alias}enterprise_slug IN (${placeholders})`, params: slugs };
}

/**
 * Distinct users per adoption phase across the whole window, from user-level data.
 *
 * The August 2026 impact-dashboard update counts every user active anywhere in
 * the 28-day window rather than only those active on its final day — a report
 * ending on a weekend or holiday otherwise showed sharply depressed counts.
 * Returns `null` when no per-user phase data exists, so callers can fall back to
 * the enterprise last-day snapshot.
 */
function getWindowPhaseCounts(
  start: string,
  end: string,
  enterpriseSlugs?: string[],
): Record<number, number> | null {
  const rows = getPhaseDeveloperCounts(start, end, { enterpriseSlugs });
  if (rows.length === 0) return null;

  const byPhase: Record<number, number> = {};
  for (const r of rows) byPhase[Number(r.phase)] = r.developers;
  return byPhase;
}

/**
 * Aggregate adoption phase distribution from enterprise-level totals_by_ai_adoption_phase.
 * Returns the latest day's breakdown + daily trend from the stored JSON array.
 */
function getEnterpriseAdoptionCohorts(
  start: string,
  end: string,
  enterpriseSlugs?: string[],
) {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  const rows = db.prepare(`
    SELECT day, totals_by_ai_adoption_phase
    FROM enterprise_daily_metrics
    WHERE day >= ? AND day <= ?${ef.clause}
      AND totals_by_ai_adoption_phase IS NOT NULL
      AND totals_by_ai_adoption_phase != '[]'
    ORDER BY day ASC
  `).all(start, end, ...ef.params) as { day: string; totals_by_ai_adoption_phase: string }[];

  if (rows.length === 0) return null;

  const trend: { day: string; phase0: number; phase1: number; phase2: number; phase3: number }[] = [];
  // Parallel trend of absolute PRs merged per phase (June 2026 API addition).
  const mergedTrend: { day: string; phase0: number; phase1: number; phase2: number; phase3: number }[] = [];
  let latestPhases: TotalsByAIAdoptionPhase[] = [];
  let hasMergeData = false;

  for (const row of rows) {
    const phases = parsePhaseTotals(row.totals_by_ai_adoption_phase);
    if (phases.length === 0) continue;

    const byPhase: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const mergedByPhase: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let dayHasMerge = false;
    for (const p of phases) {
      byPhase[p.phase] = (byPhase[p.phase] || 0) + (p.engaged_users || 0);
      if (typeof p.total_pull_requests_merged === "number") {
        hasMergeData = true;
        dayHasMerge = true;
        mergedByPhase[p.phase] = (mergedByPhase[p.phase] || 0) + p.total_pull_requests_merged;
      }
    }

    trend.push({
      day: row.day,
      phase0: byPhase[0] || 0,
      phase1: byPhase[1] || 0,
      phase2: byPhase[2] || 0,
      phase3: byPhase[3] || 0,
    });

    if (dayHasMerge) {
      mergedTrend.push({
        day: row.day,
        phase0: mergedByPhase[0] || 0,
        phase1: mergedByPhase[1] || 0,
        phase2: mergedByPhase[2] || 0,
        phase3: mergedByPhase[3] || 0,
      });
    }

    latestPhases = phases;
  }

  // Prefer window-wide distinct user counts over the last-day snapshot; the
  // enterprise JSON only carries `engaged_users` for the day it was reported.
  const windowCounts = getWindowPhaseCounts(start, end, enterpriseSlugs);
  const countBasis: "window" | "snapshot" = windowCounts ? "window" : "snapshot";

  const countForPhase = (p: { phase: number; engaged_users?: number }) =>
    windowCounts ? (windowCounts[p.phase] ?? 0) : (p.engaged_users || 0);

  // A phase can appear in the window without being present on the final day
  // (nobody in it was active that day). Union both sources so those developers
  // are still counted, otherwise the distribution silently drops them.
  const distributionPhases: { phase: number; label?: string; engaged_users?: number }[] = [
    ...latestPhases,
  ];
  if (windowCounts) {
    const seen = new Set(latestPhases.map((p) => p.phase));
    for (const key of Object.keys(windowCounts)) {
      const phase = Number(key);
      if (!seen.has(phase)) {
        distributionPhases.push({ phase, engaged_users: 0 });
      }
    }
    distributionPhases.sort((a, b) => a.phase - b.phase);
  }

  const totalEngaged = distributionPhases.reduce((s, p) => s + countForPhase(p), 0);
  const distribution = distributionPhases.map((p) => {
    const count = countForPhase(p);
    return {
      phase: p.phase,
      label: phaseLabel(p.phase),
      count,
      percentage: totalEngaged > 0 ? (count / totalEngaged) * 100 : 0,
    };
  });

  // Absolute PRs-merged distribution by phase (delivery impact per cohort).
  const totalMerged = latestPhases.reduce(
    (s, p) => s + (typeof p.total_pull_requests_merged === "number" ? p.total_pull_requests_merged : 0),
    0,
  );
  const mergedDistribution = latestPhases.map((p) => {
    const merged = typeof p.total_pull_requests_merged === "number" ? p.total_pull_requests_merged : 0;
    return {
      phase: p.phase,
      label: phaseLabel(p.phase),
      count: merged,
      percentage: totalMerged > 0 ? (merged / totalMerged) * 100 : 0,
    };
  });

  // latestDay clarifies that perPhaseMetrics averages are a point-in-time snapshot.
  // Distribution counts follow `countBasis` — window-wide when user-level phase
  // data is available, otherwise the latest day's `engaged_users`.
  const latestDay = rows[rows.length - 1]?.day ?? end;
  return {
    distribution,
    trend,
    perPhaseMetrics: latestPhases,
    totalEngaged,
    mergedDistribution,
    mergedTrend,
    totalMerged,
    hasMergeData,
    latestDay,
    countBasis,
  };
}

/**
 * Users active in the window who carry no `ai_adoption_phase` at all.
 *
 * The API only assigns a phase to users who met its engagement criteria, so the
 * cohort counts are a strict subset of the active-user count shown elsewhere on
 * the dashboard. Left unreported, the two disagree by exactly this number while
 * the cohort percentages still sum to 100% — which reads as one of the figures
 * being wrong rather than as two different populations.
 */
function getUnclassifiedUserCount(
  start: string,
  end: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
): { classified: number; unclassified: number; totalActive: number } {
  const db = getDb();
  const lf = buildLoginFilter(allowedLogins ?? [], "u.");
  const ef = buildEnterpriseFilter(enterpriseSlugs, "u.");

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT LOWER(u.user_login)) AS total_active,
      COUNT(DISTINCT CASE
        WHEN u.ai_adoption_phase IS NOT NULL AND ${USER_PHASE_SQL} IS NOT NULL
        THEN LOWER(u.user_login)
      END) AS classified
    FROM user_daily_metrics u
    WHERE u.day BETWEEN ? AND ?${lf.clause}${ef.clause}
  `).get(start, end, ...lf.params, ...ef.params) as
    | { total_active: number; classified: number }
    | undefined;

  const totalActive = row?.total_active ?? 0;
  const classified = row?.classified ?? 0;
  return {
    classified,
    totalActive,
    unclassified: Math.max(0, totalActive - classified),
  };
}

/**
 * Aggregate adoption phase distribution from user-level ai_adoption_phase.
 * Used when enterprise-level data is unavailable or when filters are active.
 */
function getUserAdoptionCohorts(
  start: string,
  end: string,
  allowedLogins?: string[],
  enterpriseSlugs?: string[],
) {
  const db = getDb();
  const lf = buildLoginFilter(allowedLogins ?? [], "u.");
  const ef = buildEnterpriseFilter(enterpriseSlugs, "u.");

  // Get latest phase per user. Uses ROW_NUMBER to pick exactly one row per
  // user_login (the most recent day), avoiding duplicates in multi-enterprise
  // scenarios where the same login appears under different enterprise_slugs.
  // The phase is resolved to an integer in SQL via the shared expression, since
  // the stored JSON carries it either as a number or as a display string.
  const rows = db.prepare(`
    SELECT phase, COUNT(*) as user_count FROM (
      SELECT user_login, phase FROM (
        SELECT
          u.user_login,
          ${USER_PHASE_SQL} as phase,
          ROW_NUMBER() OVER (PARTITION BY u.user_login ORDER BY u.day DESC) as rn
        FROM user_daily_metrics u
        WHERE u.day >= ? AND u.day <= ?
          AND u.ai_adoption_phase IS NOT NULL${lf.clause}${ef.clause}
      ) WHERE rn = 1
    )
    WHERE phase IS NOT NULL
    GROUP BY phase
    ORDER BY phase ASC
  `).all(start, end, ...lf.params, ...ef.params) as { phase: number; user_count: number }[];

  if (rows.length === 0) return null;

  const totalUsers = rows.reduce((s, r) => s + r.user_count, 0);
  const distribution = rows.map((r) => ({
    phase: r.phase,
    label: phaseLabel(r.phase),
    count: r.user_count,
    percentage: totalUsers > 0 ? (r.user_count / totalUsers) * 100 : 0,
  }));

  // Daily trend from user-level data
  const trendRows = db.prepare(`
    SELECT
      u.day as day,
      ${USER_PHASE_SQL} as phase,
      COUNT(DISTINCT u.user_login) as user_count
    FROM user_daily_metrics u
    WHERE u.day >= ? AND u.day <= ?
      AND u.ai_adoption_phase IS NOT NULL${lf.clause}${ef.clause}
    GROUP BY u.day, phase
    HAVING phase IS NOT NULL
    ORDER BY u.day ASC
  `).all(start, end, ...lf.params, ...ef.params) as { day: string; phase: number; user_count: number }[];

  const trendMap = new Map<string, { day: string; phase0: number; phase1: number; phase2: number; phase3: number }>();
  for (const r of trendRows) {
    let entry = trendMap.get(r.day);
    if (!entry) {
      entry = { day: r.day, phase0: 0, phase1: 0, phase2: 0, phase3: 0 };
      trendMap.set(r.day, entry);
    }
    const key = `phase${r.phase}` as keyof typeof entry;
    if (key in entry && key !== "day") {
      (entry as unknown as Record<string, number>)[key] = r.user_count;
    }
  }

  const trend = Array.from(trendMap.values()).sort((a, b) => a.day.localeCompare(b.day));

  // latestDay: the most recent day contributing to the distribution snapshot.
  // Note: distribution counts each user once (latest phase in range);
  // trend counts distinct users per day per phase, so daily totals may differ.
  const latestDay = trendRows.length > 0 ? trendRows[trendRows.length - 1].day : end;
  // User-level (per-user) reports do not carry PR-merge counts per adoption
  // phase, so merge-by-phase delivery metrics are unavailable in this path.
  return {
    distribution,
    trend,
    perPhaseMetrics: [],
    totalEngaged: totalUsers,
    mergedDistribution: [],
    mergedTrend: [],
    totalMerged: 0,
    hasMergeData: false,
    latestDay,
    // This path already counts each user once across the whole range.
    countBasis: "window" as const,
  };
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const window = resolveWindow(params, 28);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { days, start, end } = window;

    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const hasFilter = filter.selectedTeams.length > 0 || filter.selectedOrgs.length > 0;
    const allowedLoginsArray = filter.allowedLogins ? Array.from(filter.allowedLogins) : undefined;

    // In multi-enterprise setups, enterprise_daily_metrics has one row per
    // enterprise per day — using it directly would produce duplicate trend
    // entries and only the last enterprise's distribution. Fall back to
    // user-level aggregation (same pattern as overview/cli/pull-requests routes).
    const isMultiEnterprise = !hasFilter && countEffectiveEnterprises(enterpriseSlugs) > 1;

    // Guard: if a scope filter resolved to zero matching users, return empty
    // instead of silently dropping the filter and leaking unscoped data.
    if (hasFilter && allowedLoginsArray && allowedLoginsArray.length === 0) {
      return NextResponse.json({
        distribution: [],
        trend: [],
        perPhaseMetrics: [],
        totalEngaged: 0,
        mergedDistribution: [],
        mergedTrend: [],
        totalMerged: 0,
        hasMergeData: false,
        countBasis: "window",
        classified: 0,
        unclassified: 0,
        totalActive: 0,
        hasData: false,
        dataAsOf: end,
        daysLoaded: days,
      }, {
        headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
      });
    }

    let result;

    if (hasFilter || isMultiEnterprise) {
      // Filtered or multi-enterprise: always aggregate from user-level data
      result = getUserAdoptionCohorts(start, end, allowedLoginsArray, enterpriseSlugs);
    } else {
      // Try enterprise-level first, fall back to user-level
      result = getEnterpriseAdoptionCohorts(start, end, enterpriseSlugs);
      if (!result) {
        result = getUserAdoptionCohorts(start, end, undefined, enterpriseSlugs);
      }
    }

    if (!result) {
      return NextResponse.json({
        distribution: [],
        trend: [],
        perPhaseMetrics: [],
        totalEngaged: 0,
        mergedDistribution: [],
        mergedTrend: [],
        totalMerged: 0,
        hasMergeData: false,
        countBasis: "window",
        classified: 0,
        unclassified: 0,
        totalActive: 0,
        hasData: false,
        dataAsOf: end,
        daysLoaded: days,
      }, {
        headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
      });
    }

    return NextResponse.json({
      ...result,
      // Cohort counts only ever cover users the API assigned a phase to. Report
      // the active population and the unclassified remainder alongside them so a
      // reader can reconcile this page against the overview's active-user count
      // instead of concluding one of the two is wrong.
      ...getUnclassifiedUserCount(start, end, allowedLoginsArray, enterpriseSlugs),
      hasData: true,
      dataAsOf: end,
      daysLoaded: days,
      filtered: hasFilter || !!enterpriseSlugs,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
