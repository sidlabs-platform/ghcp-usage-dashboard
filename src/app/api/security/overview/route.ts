import { NextRequest, NextResponse } from "next/server";
import { getCodeScanningDaily, getDependabotDaily, getSecretScanningDaily, getSecurityOverview, computeMTTR } from "@/lib/db/ghas-repo";
import { computeSecuritySummary, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled, isEnterpriseEnabled, getResolvedOrgs } from "@/lib/config/dashboard-config";
import { resolveDefaultScope } from "@/lib/config/enterprise-config";
import { parseDateRangeParams } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(params, 28);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;
    const days = Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
    ) + 1;
    const dashboardScope = parseScopeFilter(params);
    if (dashboardScope.selectedTeams.length > 0) {
      return NextResponse.json(
        { error: "Security metrics do not support team filters. Clear the team selection to view security data." },
        { status: 400 },
      );
    }
    if (dashboardScope.selectedOrgs.length > 1 || dashboardScope.selectedEnterprises.length > 1) {
      return NextResponse.json(
        { error: "Security metrics support only one organization or enterprise at a time." },
        { status: 400 },
      );
    }
    if (dashboardScope.selectedOrgs.length > 0 && dashboardScope.selectedEnterprises.length > 0) {
      return NextResponse.json(
        { error: "Security metrics support either one organization or one enterprise, not both." },
        { status: 400 },
      );
    }

    // Resolve scope: use query params, then enterprise config, then first org
    let scope = dashboardScope.selectedOrgs.length === 1
      ? "org"
      : (dashboardScope.selectedEnterprises.length === 1 ? "enterprise" : (params.get("scope") || ""));
    let scopeId = dashboardScope.selectedOrgs[0]
      ?? dashboardScope.selectedEnterprises[0]
      ?? params.get("scopeId")
      ?? "";
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
