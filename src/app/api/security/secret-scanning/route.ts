import { NextRequest, NextResponse } from "next/server";
import { getSecretScanningDaily, computeMTTR } from "@/lib/db/ghas-repo";
import { computeFixRate, computeTrendDirection, formatMTTR } from "@/lib/aggregation/ghas-aggregation";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";

export async function GET(request: NextRequest) {
  try {
    if (!isMetricEnabled("secretScanning")) {
      return NextResponse.json({ enabled: false, data: [] });
    }

    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
    const { start, end } = getDateRange(days);
    // Resolve scope: defaults to enterprise, supports ?scope=org&scopeId=my-org
    const scope = params.get("scope") || "enterprise";
    const scopeId = params.get("scopeId") || process.env.GITHUB_ENTERPRISE || "";

    const daily = getSecretScanningDaily(scope, scopeId, start, end);
    const fixRate = computeFixRate(daily.map(d => ({ opened: d.opened, fixed: d.resolved })));
    const trend = computeTrendDirection(daily.map(d => d.total_open));
    const mttr = computeMTTR(scope, scopeId, "secret_scanning");

    return NextResponse.json({
      enabled: true,
      daily,
      fixRate,
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
