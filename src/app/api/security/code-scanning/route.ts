import { NextRequest, NextResponse } from "next/server";
import { getCodeScanningDaily, computeMTTR } from "@/lib/db/ghas-repo";
import { computeFixRate, computeAutofixAdoption, computeTrendDirection, getSeverityDistribution, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";
import { resolveDefaultScope } from "@/lib/config/enterprise-config";
import { getDateRange, parseAndClampDays } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    if (!isMetricEnabled("codeScanning")) {
      return NextResponse.json({ enabled: false, data: [] });
    }

    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 28);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);
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

    const daily = getCodeScanningDaily(scope, scopeId, start, end);
    const fixRate = computeFixRate(daily);
    const autofix = computeAutofixAdoption(daily);
    const severity = getSeverityDistribution(daily);
    const trend = computeTrendDirection(daily.map(d => d.total_open));
    const mttr = computeMTTR(scope, scopeId, "code_scanning");

    return NextResponse.json({
      enabled: true,
      daily,
      fixRate,
      autofix,
      severity,
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
