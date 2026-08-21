import { NextRequest, NextResponse } from "next/server";
import { getSeatsPaginated, getSeatStatsForWindow } from "@/lib/db/seats-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { resolveSeatActivityWindow } from "@/lib/api/seat-activity-window";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

const MAX_PAGE_SIZE = 200;

/**
 * Parse a pagination parameter.
 *
 * A value that is not a complete integer (`1abc`, `abc`, an empty string) is a
 * caller error and returns 400. Previously it silently fell back to the default,
 * so `page=1abc` quietly served page 1 and `page=abc` quietly served the first
 * page — a different result than the caller asked for, with no signal.
 *
 * A well-formed integer outside the supported range is still clamped rather than
 * rejected, because that is the long-standing contract of the sibling paginated
 * routes (`/api/users`, `/api/teams`, `/api/seats/lifecycle`) and is covered by
 * an existing regression test. Clamping a known-numeric bound is a normalization;
 * accepting `1abc` as `1` was a parsing bug.
 */
function parsePaginationInt(
  raw: string | null,
  paramName: string,
  defaultValue: number,
  max = Number.MAX_SAFE_INTEGER,
): number | { error: string } {
  if (raw === null) return defaultValue;
  const value = raw.trim();
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return { error: `Invalid ${paramName} value "${raw}". Expected an integer.` };
  }
  return Math.min(Math.max(1, Number(value)), max);
}

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
    const { activitySince, activityUntil, isCurrentWindow } = resolveSeatActivityWindow(range.start, range.end);

    const pageResult = parsePaginationInt(params.get("page"), "page", 1);
    if (typeof pageResult === "object") {
      return NextResponse.json({ error: pageResult.error }, { status: 400 });
    }
    const pageSizeResult = parsePaginationInt(params.get("pageSize"), "pageSize", 50, MAX_PAGE_SIZE);
    if (typeof pageSizeResult === "object") {
      return NextResponse.json({ error: pageSizeResult.error }, { status: 400 });
    }
    const page = pageResult;
    const pageSize = pageSizeResult;
    const sort = params.get("sort") || "_lastActivity";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";

    const stats = getSeatStatsForWindow(range.start, range.end, isCurrentWindow, enterpriseSlugs, activitySince, activityUntil);

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
