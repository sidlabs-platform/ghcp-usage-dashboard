import { NextRequest, NextResponse } from "next/server";
import { getDependabotDaily, computeMTTR } from "@/lib/db/ghas-repo";
import { computeFixRate, computeTrendDirection, getSeverityDistribution, getTopEcosystems, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";
import { resolveDefaultScope } from "@/lib/config/enterprise-config";
import { resolveWindow } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    if (!isMetricEnabled("dependabot")) {
      return NextResponse.json({ enabled: false, data: [] });
    }

    const params = request.nextUrl.searchParams;
    const window = resolveWindow(params, 28);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { days, start, end } = window;
    // Resolve scope: use query params, then enterprise config, then first org
    let scope = params.get("scope") || "";
    let scopeId = params.get("scopeId") || "";
    if (!scope || !scopeId) {
      if (isEnterpriseEnabled()) {
        const defaults = resolveDefaultScope();
        scope = scope || defaults.scope;
        scopeId = scopeId || defaults.scopeId;
      } else {
        scope = scope || "org";
        scopeId = scopeId || (getResolvedOrgs()[0] || "");
      }
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
