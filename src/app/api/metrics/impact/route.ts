import { NextRequest, NextResponse } from "next/server";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { isImpactSubEnabled } from "@/lib/config/dashboard-config";
import {
  getPrEfficiencyMetrics,
  getAgentImpactMetrics,
  getLicenseUtilizationMetrics,
  getCodeReviewImpactMetrics,
  getEngagementDepthMetrics,
  getTimeToValueMetrics,
  getAdoptionFunnelMetrics,
  getHealthScoreMetrics,
} from "@/lib/db/impact-queries";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const { days } = daysResult;
    const { start, end } = getDateRange(days);

    const filter = parseScopeFilter(params);
    const allowedLogins = filter.allowedLogins ? Array.from(filter.allowedLogins) : undefined;
    const enterpriseSlugs = filter.enterpriseSlugs;

    // Only return enabled metrics
    const result: Record<string, unknown> = { days, start, end };

    if (isImpactSubEnabled("prEfficiency")) {
      result.prEfficiency = getPrEfficiencyMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    if (isImpactSubEnabled("agentImpact")) {
      result.agentImpact = getAgentImpactMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    if (isImpactSubEnabled("licenseUtilization")) {
      result.licenseUtilization = getLicenseUtilizationMetrics(enterpriseSlugs);
    }

    if (isImpactSubEnabled("codeReviewImpact")) {
      result.codeReviewImpact = getCodeReviewImpactMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    if (isImpactSubEnabled("engagementDepth")) {
      result.engagementDepth = getEngagementDepthMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    if (isImpactSubEnabled("timeToValue")) {
      result.timeToValue = getTimeToValueMetrics(enterpriseSlugs);
    }

    if (isImpactSubEnabled("adoptionFunnel")) {
      result.adoptionFunnel = getAdoptionFunnelMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    if (isImpactSubEnabled("healthScore")) {
      result.healthScore = getHealthScoreMetrics(start, end, allowedLogins, enterpriseSlugs);
    }

    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
