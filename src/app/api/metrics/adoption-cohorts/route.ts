import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { countEffectiveEnterprises } from "@/lib/db/metrics-repo";
import type { TotalsByAIAdoptionPhase } from "@/lib/types/metrics";

/** Phase labels used as fallback when API data is missing labels */
const PHASE_LABELS: Record<number, string> = {
  0: "No cohort",
  1: "Code first",
  2: "Agent first",
  3: "Multi-agent",
};

function buildLoginFilter(logins: string[]): { clause: string; params: string[] } {
  if (logins.length === 0) return { clause: "", params: [] };
  const placeholders = logins.map(() => "?").join(",");
  return { clause: ` AND user_login IN (${placeholders})`, params: logins };
}

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
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
  let latestPhases: TotalsByAIAdoptionPhase[] = [];

  for (const row of rows) {
    const phases: TotalsByAIAdoptionPhase[] = JSON.parse(row.totals_by_ai_adoption_phase || "[]");
    if (phases.length === 0) continue;

    const byPhase: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const p of phases) {
      byPhase[p.phase] = (byPhase[p.phase] || 0) + (p.engaged_users || 0);
    }

    trend.push({
      day: row.day,
      phase0: byPhase[0] || 0,
      phase1: byPhase[1] || 0,
      phase2: byPhase[2] || 0,
      phase3: byPhase[3] || 0,
    });

    latestPhases = phases;
  }

  const totalEngaged = latestPhases.reduce((s, p) => s + (p.engaged_users || 0), 0);
  const distribution = latestPhases.map((p) => ({
    phase: p.phase,
    label: p.label || PHASE_LABELS[p.phase] || `Phase ${p.phase}`,
    count: p.engaged_users || 0,
    percentage: totalEngaged > 0 ? ((p.engaged_users || 0) / totalEngaged) * 100 : 0,
  }));

  // latestDay clarifies that distribution/perPhaseMetrics are a point-in-time snapshot
  const latestDay = rows[rows.length - 1]?.day ?? end;
  return { distribution, trend, perPhaseMetrics: latestPhases, totalEngaged, latestDay };
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
  const lf = buildLoginFilter(allowedLogins ?? []);
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  // Get latest phase per user. Uses ROW_NUMBER to pick exactly one row per
  // user_login (the most recent day), avoiding duplicates in multi-enterprise
  // scenarios where the same login appears under different enterprise_slugs.
  // label is selected deterministically via MIN() so the outer GROUP BY phase
  // always picks a consistent label.
  const rows = db.prepare(`
    SELECT phase, MIN(label) as label, COUNT(*) as user_count FROM (
      SELECT user_login, phase, label FROM (
        SELECT
          u.user_login,
          json_extract(u.ai_adoption_phase, '$.phase') as phase,
          json_extract(u.ai_adoption_phase, '$.label') as label,
          ROW_NUMBER() OVER (PARTITION BY u.user_login ORDER BY u.day DESC) as rn
        FROM user_daily_metrics u
        WHERE u.day >= ? AND u.day <= ?
          AND u.ai_adoption_phase IS NOT NULL${lf.clause}${ef.clause}
      ) WHERE rn = 1
    )
    GROUP BY phase
    ORDER BY phase ASC
  `).all(start, end, ...lf.params, ...ef.params) as { phase: number; label: string; user_count: number }[];

  if (rows.length === 0) return null;

  const totalUsers = rows.reduce((s, r) => s + r.user_count, 0);
  const distribution = rows.map((r) => ({
    phase: r.phase,
    label: r.label || PHASE_LABELS[r.phase] || `Phase ${r.phase}`,
    count: r.user_count,
    percentage: totalUsers > 0 ? (r.user_count / totalUsers) * 100 : 0,
  }));

  // Daily trend from user-level data
  const trendRows = db.prepare(`
    SELECT
      day,
      json_extract(ai_adoption_phase, '$.phase') as phase,
      COUNT(DISTINCT user_login) as user_count
    FROM user_daily_metrics
    WHERE day >= ? AND day <= ?
      AND ai_adoption_phase IS NOT NULL${lf.clause}${ef.clause}
    GROUP BY day, json_extract(ai_adoption_phase, '$.phase')
    ORDER BY day ASC
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
  return { distribution, trend, perPhaseMetrics: [], totalEngaged: totalUsers, latestDay };
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

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
        hasData: false,
        dataAsOf: end,
        daysLoaded: days,
      }, {
        headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
      });
    }

    return NextResponse.json({
      ...result,
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
