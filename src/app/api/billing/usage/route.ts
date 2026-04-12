import { NextRequest, NextResponse } from "next/server";
import { isMetricEnabled } from "@/lib/config/dashboard-config";
import { getDateRange } from "@/lib/utils";
import {
  getUsageRecordsPaginated,
  getUsageFilterOptions,
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

    const page = Math.max(1, parseInt(params.get("page") || "1", 10));
    const pageSize = Math.min(Math.max(1, parseInt(params.get("pageSize") || "50", 10)), 200);
    const sort = params.get("sort") || "date";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";
    const search = params.get("search") || undefined;

    const filters = {
      product: params.get("product")?.split(",").filter(Boolean),
      sku: params.get("sku")?.split(",").filter(Boolean),
      organization: params.get("organization")?.split(",").filter(Boolean),
      username: params.get("username") || undefined,
      chargeScope: (params.get("chargeScope") as ChargeScope) || undefined,
      costCenter: params.get("costCenter") || undefined,
    };

    const { records, total } = getUsageRecordsPaginated(
      start, end, page, pageSize, sort, sortDir, search, filters,
    );

    const filterOptions = getUsageFilterOptions(start, end);

    return NextResponse.json({
      enabled: true,
      records,
      pagination: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize),
      },
      filterOptions,
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
