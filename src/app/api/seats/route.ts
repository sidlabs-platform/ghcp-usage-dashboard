import { NextRequest, NextResponse } from "next/server";
import { getSeatsPaginated, getSeatStats } from "@/lib/db/seats-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const hasFilter = filter.selectedTeams.length > 0 || filter.selectedOrgs.length > 0;

    // Seat rows are a live snapshot with no history, so the selected window can
    // only govern the activity split, never the seat counts themselves.
    const range = parseDateRangeParams(params, 30);
    if ("error" in range) {
      return NextResponse.json({ error: range.error }, { status: 400 });
    }
    const activitySince = `${range.start}T00:00:00.000Z`;

    const rawPage = parseInt(params.get("page") || "1", 10);
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(params.get("pageSize") || "50", 10);
    const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? 50 : rawPageSize), 200);
    const sort = params.get("sort") || "_lastActivity";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";

    const stats = getSeatStats(enterpriseSlugs, activitySince);

    const result = getSeatsPaginated(page, pageSize, sort, sortDir, filter.allowedLogins, enterpriseSlugs);

    const utilization = stats.total > 0
      ? Number(((stats.active30d / stats.total) * 100).toFixed(1))
      : 0;

    return NextResponse.json({
      seats: result.seats,
      stats,
      utilization,
      window: { start: range.start, end: range.end },
      filtered: hasFilter,
      pagination: {
        page,
        pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
