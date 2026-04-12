import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";
import {
  getProductBreakdown,
  getOrgBreakdown,
  getUserBreakdown,
  getDailyAggregates,
} from "@/lib/db/billing-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import type { ChargeScope } from "@/lib/types/billing";

async function handler(request: NextRequest) {
  try {
    if (!isMetricEnabled("billing")) {
      return NextResponse.json({ enabled: false });
    }

    const params = request.nextUrl.searchParams;
    const days = parseInt(params.get("days") || "28", 10);
    const { start, end } = getDateRange(days);
    const groupBy = params.get("groupBy") || "product";

    const filters = {
      product: params.get("product")?.split(",").filter(Boolean),
      sku: params.get("sku")?.split(",").filter(Boolean),
      organization: params.get("organization")?.split(",").filter(Boolean),
      username: params.get("username") || undefined,
      chargeScope: (params.get("chargeScope") as ChargeScope) || undefined,
      costCenter: params.get("costCenter") || undefined,
    };

    let groupedData;
    switch (groupBy) {
      case "organization":
        groupedData = getOrgBreakdown(start, end, filters);
        break;
      case "user":
        groupedData = getUserBreakdown(start, end, filters);
        break;
      case "daily":
        groupedData = getDailyAggregates(start, end, filters);
        break;
      case "product":
      default:
        groupedData = getProductBreakdown(start, end, filters);
        break;
    }

    return NextResponse.json({
      enabled: true,
      groupBy,
      data: groupedData,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
