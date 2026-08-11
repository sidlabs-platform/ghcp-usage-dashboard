import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import {
  countEffectiveEnterprises,
  getPhaseCostFromBilling,
  getPhaseCostFromCredits,
  hasBillingCostData,
  type PhaseCostRow,
  type RoiCostFilters,
} from "@/lib/db/metrics-repo";
import { getLicensingConfig } from "@/lib/config/dashboard-config";
import {
  DAYS_PER_MONTH,
  ENTERPRISE_ROLLING_WINDOW_DAYS,
  type RoiCostSource,
  type RoiGroup,
  type RoiGroupKey,
  type RoiResponse,
  type TotalsByAIAdoptionPhase,
} from "@/lib/types/metrics";

/**
 * The two adoption groups GitHub's impact dashboard compares: developers still
 * working mainly through chat and completions, versus agent-first developers.
 */
const GROUP_DEFINITIONS: { key: RoiGroupKey; label: string; phases: number[] }[] = [
  { key: "early", label: "Chat & completions", phases: [0, 1] },
  { key: "agent", label: "Agent-first", phases: [2, 3] },
];

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

/**
 * Merged pull requests per adoption phase, taken from the most recent
 * enterprise day row.
 *
 * `totals_by_ai_adoption_phase[].total_pull_requests_merged` is a 28-day rolling
 * aggregate, so the latest row already represents a full window — summing across
 * days would multiply-count the same pull requests. Returns `null` when the
 * field is absent, which is the case for data synced before the June 2026 API
 * addition.
 */
function getMergedByPhase(
  start: string,
  end: string,
  enterpriseSlugs?: string[],
): Record<number, number> | null {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);

  const row = db.prepare(`
    SELECT totals_by_ai_adoption_phase
    FROM enterprise_daily_metrics
    WHERE day >= ? AND day <= ?${ef.clause}
      AND totals_by_ai_adoption_phase IS NOT NULL
      AND totals_by_ai_adoption_phase != '[]'
    ORDER BY day DESC
    LIMIT 1
  `).get(start, end, ...ef.params) as { totals_by_ai_adoption_phase: string } | undefined;

  if (!row) return null;

  let phases: TotalsByAIAdoptionPhase[];
  try {
    phases = JSON.parse(row.totals_by_ai_adoption_phase || "[]");
  } catch {
    return null;
  }

  const byPhase: Record<number, number> = {};
  let sawMergeField = false;
  for (const p of phases) {
    if (typeof p.total_pull_requests_merged === "number") {
      sawMergeField = true;
      byPhase[p.phase] = (byPhase[p.phase] || 0) + p.total_pull_requests_merged;
    }
  }

  return sawMergeField ? byPhase : null;
}

/** Empty-but-valid payload so the UI degrades instead of erroring. */
function emptyResponse(days: number, end: string, currency: string, creditToUsd: number): RoiResponse {
  return {
    hasData: false,
    hasPrData: false,
    costSource: "none",
    currency,
    creditToUsd,
    groups: [],
    windowDays: days,
    dataAsOf: end,
    daysLoaded: days,
    filtered: false,
  };
}

const CACHE_HEADERS = { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" };

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

    // `creditToUsd` / `currency` live in the server-only licensing config block
    // (deliberately stripped from /api/config). Only derived USD values are
    // returned to the client.
    const licensing = getLicensingConfig();
    const { creditToUsd, currency } = licensing;

    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const hasFilter = filter.selectedTeams.length > 0 || filter.selectedOrgs.length > 0;
    const allowedLogins = filter.allowedLogins ? Array.from(filter.allowedLogins) : undefined;

    // A scope filter that resolved to zero users must return nothing rather than
    // silently dropping the filter and leaking unscoped data.
    if (hasFilter && allowedLogins && allowedLogins.length === 0) {
      return NextResponse.json(
        { ...emptyResponse(days, end, currency, creditToUsd), filtered: true },
        { headers: CACHE_HEADERS },
      );
    }

    const costFilters: RoiCostFilters = { allowedLogins, enterpriseSlugs };

    const useBilling = hasBillingCostData(start, end, costFilters);
    const costRows: PhaseCostRow[] = useBilling
      ? getPhaseCostFromBilling(start, end, costFilters)
      : getPhaseCostFromCredits(start, end, creditToUsd, costFilters);

    if (costRows.length === 0) {
      return NextResponse.json(
        { ...emptyResponse(days, end, currency, creditToUsd), filtered: hasFilter || !!enterpriseSlugs },
        { headers: CACHE_HEADERS },
      );
    }

    const totalCost = costRows.reduce((s, r) => s + (r.total_cost_usd || 0), 0);
    const costSource: RoiCostSource = totalCost > 0 ? (useBilling ? "billing" : "credits") : "none";

    // Merged-PR totals come from a single enterprise row. Across several
    // enterprises that row covers only one of them, so it cannot describe the
    // whole scope — suppress PR figures unless the scope is a single enterprise.
    const singleEnterpriseScope =
      (enterpriseSlugs?.length ?? 0) === 1 || countEffectiveEnterprises(enterpriseSlugs) <= 1;
    const mergedByPhase = singleEnterpriseScope ? getMergedByPhase(start, end, enterpriseSlugs) : null;

    const costByPhase = new Map<number, PhaseCostRow>();
    for (const r of costRows) costByPhase.set(Number(r.phase), r);

    // Cost is summed over the requested range; merged PRs are a 28-day rolling
    // figure. Each is normalized against its own window length.
    const costMonthlyFactor = DAYS_PER_MONTH / days;
    const prMonthlyFactor = DAYS_PER_MONTH / ENTERPRISE_ROLLING_WINDOW_DAYS;

    const groups: RoiGroup[] = GROUP_DEFINITIONS.map((def) => {
      let developers = 0;
      let totalCostUsd = 0;
      let prsMerged = 0;

      for (const phase of def.phases) {
        const row = costByPhase.get(phase);
        if (row) {
          developers += row.developers || 0;
          totalCostUsd += row.total_cost_usd || 0;
        }
        if (mergedByPhase) prsMerged += mergedByPhase[phase] || 0;
      }

      return {
        key: def.key,
        label: def.label,
        phases: def.phases,
        developers,
        totalCostUsd,
        costPerDevPerMonth: developers > 0 ? (totalCostUsd / developers) * costMonthlyFactor : 0,
        prsMerged,
        prsMergedPerDevPerMonth: developers > 0 ? (prsMerged / developers) * prMonthlyFactor : 0,
      };
    });

    const hasDevelopers = groups.some((g) => g.developers > 0);
    const hasPrData = mergedByPhase !== null && groups.some((g) => g.prsMerged > 0);

    const body: RoiResponse = {
      hasData: hasDevelopers,
      hasPrData,
      costSource,
      currency,
      creditToUsd,
      groups,
      windowDays: days,
      dataAsOf: end,
      daysLoaded: days,
      filtered: hasFilter || !!enterpriseSlugs,
    };

    return NextResponse.json(body, { headers: CACHE_HEADERS });
  } catch (err) {
    console.error("[api/metrics/roi] request failed:", err);
    return NextResponse.json({ error: "Failed to compute ROI metrics" }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
