import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";
import {
  getPremiumUserSummary,
  getPremiumModelSummary,
} from "@/lib/db/billing-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    if (!isMetricEnabled("billing")) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
    const { start, end } = getDateRange(days);

    const filters = {
      username: params.get("username") || undefined,
      organization: params.get("organization")?.split(",").filter(Boolean),
      model: params.get("model")?.split(",").filter(Boolean),
      exceedsQuota: params.get("exceedsQuota") === "true" ? true
        : params.get("exceedsQuota") === "false" ? false
        : undefined,
    };

    const userSummary = getPremiumUserSummary(start, end, filters);
    const modelSummary = getPremiumModelSummary(start, end, filters);

    // Compute KPIs from user summary
    const totalRequests = userSummary.reduce((sum, u) => sum + u.total_requests, 0);
    const usersOverQuota = userSummary.filter((u) => u.over_quota > 0).length;
    const totalUsers = userSummary.length;
    const totalNet = userSummary.reduce((sum, u) => sum + u.total_net, 0);
    const topModel = modelSummary.length > 0
      ? modelSummary.reduce((a, b) => (a.total_requests > b.total_requests ? a : b)).model
      : "N/A";

    return NextResponse.json({
      enabled: true,
      kpis: {
        totalRequests,
        usersOverQuota,
        totalUsers,
        totalNet,
        topModel,
        uniqueModels: modelSummary.length,
      },
      userSummary,
      modelSummary,
      daysLoaded: days,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
