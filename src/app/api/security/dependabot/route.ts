import { NextRequest, NextResponse } from "next/server";
import { getDependabotDaily, computeMTTR } from "@/lib/db/ghas-repo";
import { computeFixRate, computeTrendDirection, getSeverityDistribution, getTopEcosystems, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    if (!isMetricEnabled("dependabot")) {
      return NextResponse.json({ enabled: false, data: [] });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);
    // Resolve scope: defaults to enterprise when available, otherwise first org
    const scope = params.get("scope") || (isEnterpriseEnabled() ? "enterprise" : "org");
    let scopeId = params.get("scopeId") || "";
    if (!scopeId) {
      scopeId = isEnterpriseEnabled()
        ? (process.env.GITHUB_ENTERPRISE || "")
        : (getResolvedOrgs()[0] || "");
    }
    if (!scopeId) {
      return NextResponse.json(
        { error: "No scopeId could be resolved. Configure GITHUB_ENTERPRISE or GITHUB_ORG." },
        { status: 400 },
      );
    }

    const daily = getDependabotDaily(scope, scopeId, start, end);
    const fixRate = computeFixRate(daily);
    const severity = getSeverityDistribution(daily);
    const ecosystems = getTopEcosystems(daily);
    const trend = computeTrendDirection(daily.map(d => d.total_open));
    const mttr = computeMTTR(scope, scopeId, "dependabot");

    return NextResponse.json({
      enabled: true,
      daily,
      fixRate,
      severity,
      ecosystems,
      trend,
      mttr,
      mttrFormatted: formatMTTR(mttr),
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
