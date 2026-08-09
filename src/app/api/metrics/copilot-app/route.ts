import { NextRequest, NextResponse } from "next/server";
import { getDateRange, datesBetween, parseAndClampDays } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { countEffectiveEnterprises } from "@/lib/db/metrics-repo";
import {
  getCopilotAppUserSummary,
  getCopilotAppDailyUsage,
  getCopilotAppDailyCodeImpact,
  getCopilotAppModelBreakdown,
  getCopilotAppLanguageBreakdown,
  estimateCopilotAppRowCount,
  getEnterpriseCopilotAppDaily,
  getOrganizationCopilotAppDaily,
  countAggregateEnterprises,
  countOrganizationCopilotAppEnterprises,
} from "@/lib/db/copilot-app-queries";
import type {
  CopilotAppAnalyticsResponse,
  CopilotAppKpis,
  CopilotAppAdoptionTrendPoint,
  CopilotAppCodeImpactPoint,
  CopilotAppAggregateDay,
  CopilotAppDataSource,
} from "@/lib/types/metrics";

const CACHE_HEADERS = { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" };

/** All-zero KPI set used for the `dataSource: "none"` response — no Copilot
 * App evidence exists anywhere in the resolved scope. */
const ZERO_KPIS: CopilotAppKpis = {
  periodActiveUsers: 0,
  appActiveUsers: 0,
  adoptionRate: 0,
  sessions: 0,
  requests: 0,
  prompts: 0,
  promptTokens: 0,
  outputTokens: 0,
  avgTokensPerRequest: 0,
  codeGenerations: 0,
  codeAcceptances: 0,
  locAdded: 0,
  locDeleted: 0,
  locChanged: 0,
};

/** Zero-fill a user-level adoption trend over every calendar day in range,
 * so gaps (days with no rows at all) never silently disappear from charts. */
function zeroFillAdoptionTrend(
  days: string[],
  rows: { day: string; activeUsers: number; sessions: number; requests: number; prompts: number }[],
): CopilotAppAdoptionTrendPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = byDay.get(day);
    return {
      day,
      activeUsers: r?.activeUsers ?? 0,
      sessions: r?.sessions ?? 0,
      requests: r?.requests ?? 0,
      prompts: r?.prompts ?? 0,
    };
  });
}

/** Zero-fill a user-level code-impact trend over every calendar day in range. */
function zeroFillCodeImpactTrend(
  days: string[],
  rows: { day: string; generations: number; acceptances: number; locAdded: number; locDeleted: number }[],
): CopilotAppCodeImpactPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = byDay.get(day);
    return {
      day,
      generations: r?.generations ?? 0,
      acceptances: r?.acceptances ?? 0,
      locAdded: r?.locAdded ?? 0,
      locDeleted: r?.locDeleted ?? 0,
    };
  });
}

/** Aggregate a set of enterprise/org daily rows into period KPIs. The
 * adoption-rate denominator here is `sourceActiveUsers` (App-supported rows
 * only), which is intentionally different from the user-level denominator —
 * see {@link CopilotAppAggregateDay.sourceActiveUsers}. */
function aggregateKpisFromDays(rows: CopilotAppAggregateDay[]): CopilotAppKpis {
  let periodActiveUsers = 0;
  let appActiveUsers = 0;
  let sessions = 0;
  let requests = 0;
  let prompts = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let codeGenerations = 0;
  let codeAcceptances = 0;
  let locAdded = 0;
  let locDeleted = 0;

  for (const r of rows) {
    periodActiveUsers += r.sourceActiveUsers;
    appActiveUsers += r.activeUsers;
    sessions += r.sessions;
    requests += r.requests;
    prompts += r.prompts;
    promptTokens += r.promptTokens;
    outputTokens += r.outputTokens;
    codeGenerations += r.generations;
    codeAcceptances += r.acceptances;
    locAdded += r.locAdded;
    locDeleted += r.locDeleted;
  }

  return {
    periodActiveUsers,
    appActiveUsers,
    adoptionRate: periodActiveUsers > 0 ? (appActiveUsers / periodActiveUsers) * 100 : 0,
    sessions,
    requests,
    prompts,
    promptTokens,
    outputTokens,
    avgTokensPerRequest: requests > 0 ? Math.round(((promptTokens + outputTokens) / requests) * 10) / 10 : 0,
    codeGenerations,
    codeAcceptances,
    locAdded,
    locDeleted,
    locChanged: locAdded + locDeleted,
  };
}

/** Zero-fill an enterprise/org aggregate adoption trend over every calendar
 * day in range — unsupported days (no App evidence) are zero, not omitted. */
function aggregateAdoptionTrend(days: string[], rows: CopilotAppAggregateDay[]): CopilotAppAdoptionTrendPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = byDay.get(day);
    return {
      day,
      activeUsers: r?.activeUsers ?? 0,
      sessions: r?.sessions ?? 0,
      requests: r?.requests ?? 0,
      prompts: r?.prompts ?? 0,
    };
  });
}

/** Zero-fill an enterprise/org aggregate code-impact trend over every
 * calendar day in range. */
function aggregateCodeImpactTrend(days: string[], rows: CopilotAppAggregateDay[]): CopilotAppCodeImpactPoint[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = byDay.get(day);
    return {
      day,
      generations: r?.generations ?? 0,
      acceptances: r?.acceptances ?? 0,
      locAdded: r?.locAdded ?? 0,
      locDeleted: r?.locDeleted ?? 0,
    };
  });
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);
    const allDays = datesBetween(start, end);

    const scope = parseScopeFilter(params);
    const allowedLogins = scope.allowedLogins ? Array.from(scope.allowedLogins) : undefined;
    const { enterpriseSlugs } = scope;

    // Row-count guard — bounds the same three json_each-heavy query shapes
    // (dedicated totals, App feature rows, adopter roster) used below.
    const estimate = estimateCopilotAppRowCount(start, end, allowedLogins, enterpriseSlugs);
    if (estimate.exceeds) {
      return NextResponse.json(
        {
          error: `Result set too large (${estimate.count.toLocaleString()} rows) for Copilot App analytics. Try a narrower date range or add filters.`,
        },
        { status: 400 },
      );
    }

    // Precise user-level source, tried first. `supportedRows` reflects App
    // *availability* (including explicit zero activity), not positive usage —
    // see getCopilotAppUserSummary's supportedRows doc.
    const userSummary = getCopilotAppUserSummary(start, end, allowedLogins, enterpriseSlugs);

    if (userSummary.supportedRows > 0) {
      const adoptionRows = getCopilotAppDailyUsage(start, end, allowedLogins, enterpriseSlugs);
      const codeImpactRows = getCopilotAppDailyCodeImpact(start, end, allowedLogins, enterpriseSlugs);

      const response: CopilotAppAnalyticsResponse = {
        hasCopilotAppData: true,
        dataSource: "users",
        capabilities: { adopters: true, scopedFiltering: true, modelBreakdown: true, languageBreakdown: true },
        kpis: {
          periodActiveUsers: userSummary.periodActiveUsers,
          appActiveUsers: userSummary.appActiveUsers,
          adoptionRate: userSummary.adoptionRate,
          sessions: userSummary.sessions,
          requests: userSummary.requests,
          prompts: userSummary.prompts,
          promptTokens: userSummary.promptTokens,
          outputTokens: userSummary.outputTokens,
          avgTokensPerRequest: userSummary.avgTokensPerRequest,
          codeGenerations: userSummary.codeGenerations,
          codeAcceptances: userSummary.codeAcceptances,
          locAdded: userSummary.locAdded,
          locDeleted: userSummary.locDeleted,
          locChanged: userSummary.locChanged,
        },
        adoptionTrend: zeroFillAdoptionTrend(allDays, adoptionRows),
        codeImpactTrend: zeroFillCodeImpactTrend(allDays, codeImpactRows),
        modelBreakdown: getCopilotAppModelBreakdown(start, end, allowedLogins, enterpriseSlugs),
        languageBreakdown: getCopilotAppLanguageBreakdown(start, end, allowedLogins, enterpriseSlugs),
      };

      return NextResponse.json(response, { headers: CACHE_HEADERS });
    }

    // No per-user App evidence in scope. Consider the enterprise/org aggregate
    // fallback — but only for scopes where it is safe/well-defined:
    //   - never for a team-scoped filter (aggregate tables can't be sliced by team)
    //   - never when a filter resolved to zero effective users (would silently
    //     ignore the filter and leak unscoped aggregate data)
    //   - never for an ambiguous multi-enterprise scope (aggregate rows would
    //     double-count across enterprises)
    const isZeroEffectiveUserScope =
      scope.hasFilter && scope.allowedLogins !== undefined && scope.allowedLogins.size === 0;

    // `countEffectiveEnterprises` (metrics-repo.ts) only ever looks at
    // `user_daily_metrics`, so when user-level metrics are disabled/empty it
    // reports 0 even though a single enterprise/org aggregate row with App
    // evidence exists — which would otherwise make the fallback impossible to
    // reach. `countAggregateEnterprises` derives the same ambiguity signal
    // directly from the aggregate source (date-range-aware, App-evidence-only)
    // instead. Combine both with Math.max rather than summing: the two counts
    // describe overlapping evidence for the same scope (not additive
    // populations), and by the time this code runs `userSummary.supportedRows`
    // is already known to be 0, so the user-level count reflects enterprises
    // with *some* user-day data but no App evidence — taking the larger of the
    // two conservatively still blocks the fallback whenever either source sees
    // more than one candidate enterprise, while unblocking it when only one
    // source has evidence at all (e.g. user metrics fully disabled, count 0,
    // aggregate count 1).
    const effectiveUserEnterprises = countEffectiveEnterprises(enterpriseSlugs);
    const effectiveAggregateEnterprises = countAggregateEnterprises(start, end, enterpriseSlugs);
    const effectiveEnterprises = Math.max(effectiveUserEnterprises, effectiveAggregateEnterprises);

    // When exactly one organization is selected, also fold in App evidence
    // that lives only in `org_daily_metrics` — `countAggregateEnterprises`
    // (above) reads `enterprise_daily_metrics` only, so a selected org whose
    // App evidence exists solely at the org level (no matching enterprise or
    // user rows) would otherwise leave `effectiveEnterprises` at 0 and make
    // the org fallback below unreachable even though exactly one
    // organization is unambiguously selected. See
    // {@link countOrganizationCopilotAppEnterprises}'s doc for the full
    // rationale, including why a count > 1 here still blocks the fallback.
    // This widened count is scoped to the org-fallback gate only — the
    // enterprise fallback gate (`canUseEnterpriseFallback` below) still uses
    // the unwidened `effectiveEnterprises`.
    const orgEffectiveEnterprises =
      scope.selectedOrgs.length === 1
        ? Math.max(
            effectiveEnterprises,
            countOrganizationCopilotAppEnterprises(scope.selectedOrgs[0], start, end, enterpriseSlugs),
          )
        : effectiveEnterprises;

    const canUseOrgFallback =
      !isZeroEffectiveUserScope &&
      scope.selectedTeams.length === 0 &&
      scope.selectedOrgs.length === 1 &&
      orgEffectiveEnterprises === 1;
    // Unlike the org fallback, an explicit enterprise-only selection (via
    // `enterprises=`, which sets `scope.hasFilter = true` without touching
    // `selectedTeams`/`selectedOrgs`/`allowedLogins`) narrows ambiguity rather
    // than creating it, so it must not block this fallback — only an active
    // team or org filter should.
    const canUseEnterpriseFallback =
      !isZeroEffectiveUserScope &&
      scope.selectedTeams.length === 0 &&
      scope.selectedOrgs.length === 0 &&
      effectiveEnterprises === 1;

    let aggregateRows: CopilotAppAggregateDay[] = [];
    let aggregateSource: CopilotAppDataSource = "none";

    if (canUseOrgFallback) {
      const rows = getOrganizationCopilotAppDaily(scope.selectedOrgs[0], start, end, enterpriseSlugs);
      if (rows.length > 0) {
        aggregateRows = rows;
        aggregateSource = "organization";
      }
    }
    if (aggregateRows.length === 0 && canUseEnterpriseFallback) {
      const rows = getEnterpriseCopilotAppDaily(start, end, enterpriseSlugs);
      if (rows.length > 0) {
        aggregateRows = rows;
        aggregateSource = "enterprise";
      }
    }

    if (aggregateRows.length > 0) {
      const response: CopilotAppAnalyticsResponse = {
        hasCopilotAppData: true,
        dataSource: aggregateSource,
        capabilities: { adopters: false, scopedFiltering: false, modelBreakdown: false, languageBreakdown: false },
        kpis: aggregateKpisFromDays(aggregateRows),
        adoptionTrend: aggregateAdoptionTrend(allDays, aggregateRows),
        codeImpactTrend: aggregateCodeImpactTrend(allDays, aggregateRows),
        modelBreakdown: [],
        languageBreakdown: [],
      };

      return NextResponse.json(response, { headers: CACHE_HEADERS });
    }

    // No Copilot App evidence anywhere in the resolved scope — stable,
    // all-zero legacy response rather than an error, per backward-compat rules.
    const noneResponse: CopilotAppAnalyticsResponse = {
      hasCopilotAppData: false,
      dataSource: "none",
      capabilities: { adopters: false, scopedFiltering: false, modelBreakdown: false, languageBreakdown: false },
      kpis: ZERO_KPIS,
      adoptionTrend: zeroFillAdoptionTrend(allDays, []),
      codeImpactTrend: zeroFillCodeImpactTrend(allDays, []),
      modelBreakdown: [],
      languageBreakdown: [],
    };

    return NextResponse.json(noneResponse, { headers: CACHE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
