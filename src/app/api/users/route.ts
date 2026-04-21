import { NextRequest, NextResponse } from "next/server";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { getUserSummariesPaginated } from "@/lib/db/aggregation-queries";
import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const daysResult = parseAndClampDays(params.get("days"), 7);
    if ("error" in daysResult) {
      return NextResponse.json({ error: daysResult.error }, { status: 400 });
    }
    const days = daysResult.days;
    const { start, end } = getDateRange(days);

    const page = Math.max(1, parseInt(params.get("page") || "1", 10));
    const pageSize = Math.min(Math.max(1, parseInt(params.get("pageSize") || "50", 10)), 200);
    const sort = params.get("sort") || "activeDays";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";
    const search = params.get("search") || undefined;

    const filter = parseScopeFilter(params);
    const { enterpriseSlugs } = filter;
    const allowedLogins = filter.allowedLogins ? Array.from(filter.allowedLogins) : undefined;

    const result = getUserSummariesPaginated(start, end, page, pageSize, sort, sortDir, search, allowedLogins, enterpriseSlugs);

    return NextResponse.json({
      users: result.users,
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

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
