import { NextRequest, NextResponse } from "next/server";
import { getCodeScanningDaily, getDependabotDaily, getSecretScanningDaily, getSecurityOverview, computeMTTR } from "@/lib/db/ghas-repo";
import { computeSecuritySummary, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
    const { start, end } = getDateRange(days);

    // Resolve scope: defaults to enterprise when available, otherwise first org
    let scope = params.get("scope") || (isEnterpriseEnabled() ? "enterprise" : "org");
    let scopeId = params.get("scopeId") || "";
    if (!scopeId) {
      scopeId = isEnterpriseEnabled()
        ? (process.env.GITHUB_ENTERPRISE || "")
        : (getResolvedOrgs()[0] || "");
    }

    // Get overview stats from DB
    const overview = getSecurityOverview(scope, scopeId);

    // Get daily data for trends
    const csDaily = isMetricEnabled("codeScanning") ? getCodeScanningDaily(scope, scopeId, start, end) : [];
    const depDaily = isMetricEnabled("dependabot") ? getDependabotDaily(scope, scopeId, start, end) : [];
    const ssDaily = isMetricEnabled("secretScanning") ? getSecretScanningDaily(scope, scopeId, start, end) : [];

    // Compute summary
    const summary = computeSecuritySummary(csDaily, depDaily, ssDaily);

    // MTTR
    const csMTTR = isMetricEnabled("codeScanning") ? computeMTTR(scope, scopeId, "code_scanning") : null;
    const depMTTR = isMetricEnabled("dependabot") ? computeMTTR(scope, scopeId, "dependabot") : null;
    const ssMTTR = isMetricEnabled("secretScanning") ? computeMTTR(scope, scopeId, "secret_scanning") : null;

    return NextResponse.json({
      overview,
      summary,
      mttr: { codeScanning: csMTTR, dependabot: depMTTR, secretScanning: ssMTTR },
      mttrFormatted: {
        codeScanning: formatMTTR(csMTTR),
        dependabot: formatMTTR(depMTTR),
        secretScanning: formatMTTR(ssMTTR),
      },
      dataAsOf: end,
      daysLoaded: days,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
