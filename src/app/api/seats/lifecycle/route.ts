import { NextRequest, NextResponse } from "next/server";
import {
  getSeatLifecycleStats,
  getSeatLifecycleTrend,
  getSeatLifecycleRows,
  getSeatLifecycleCoverage,
  SEAT_LIFECYCLE_SORT_COLUMNS,
  type SeatLifecycleQuery,
  type SeatLifecycleStats,
  type SeatLifecycleCoverage,
  type SeatLifecycleRow,
  type SeatLifecycleTrendPoint,
} from "@/lib/db/seat-lifecycle-repo";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { parseSeatLifecycleWindow } from "@/lib/api/seat-lifecycle-window";
import { CACHE_SKIP_HEADER, withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const CACHE_HEADERS = { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" };
const DEGRADED_CACHE_HEADERS = { "Cache-Control": "private, no-cache, no-store, max-age=0", [CACHE_SKIP_HEADER]: "1" };

const EMPTY_STATS: SeatLifecycleStats = {
  onboardedUsers: 0,
  offboardedUsers: 0,
  onboardedEvents: 0,
  offboardedEvents: 0,
  netChange: 0,
  churnRate: null,
};

const EMPTY_COVERAGE: SeatLifecycleCoverage = {
  source: "none",
  trackingStartedAt: null,
  onboardingOnly: false,
};

function clampPage(raw: string | null): number {
  const parsed = parseInt(raw || "1", 10);
  return Math.max(1, Number.isNaN(parsed) ? 1 : parsed);
}

function clampPageSize(raw: string | null): number {
  const parsed = parseInt(raw || String(DEFAULT_PAGE_SIZE), 10);
  const size = Number.isNaN(parsed) ? DEFAULT_PAGE_SIZE : parsed;
  return Math.min(Math.max(1, size), MAX_PAGE_SIZE);
}

async function handler(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const window = parseSeatLifecycleWindow(params);
  if ("error" in window) {
    return NextResponse.json({ error: window.error }, { status: 400 });
  }

  const sort = params.get("sort") || "event_date";
  if (!SEAT_LIFECYCLE_SORT_COLUMNS.includes(sort)) {
    return NextResponse.json(
      { error: `Invalid sort column "${sort}". Allowed: ${SEAT_LIFECYCLE_SORT_COLUMNS.join(", ")}.` },
      { status: 400 },
    );
  }
  const sortDir = params.get("sortDir") === "asc" ? "asc" : "desc";

  const filter = parseScopeFilter(params);
  const query: SeatLifecycleQuery = {
    start: window.start,
    end: window.end,
    enterpriseSlugs: filter.enterpriseSlugs,
    orgs: filter.selectedOrgs.length > 0 ? filter.selectedOrgs : undefined,
    allowedLogins: filter.allowedLogins,
  };

  const pageSize = clampPageSize(params.get("pageSize"));
  const onboardedPage = clampPage(params.get("onboardedPage"));
  const offboardedPage = clampPage(params.get("offboardedPage"));

  // A database that has never synced with this feature present has no ledger
  // tables at all. That is a legitimate empty state, not a server error, so
  // degrade to a zeroed payload rather than returning a 500.
  let stats = EMPTY_STATS;
  let trend: SeatLifecycleTrendPoint[] = [];
  let onboarded: { rows: SeatLifecycleRow[]; total: number } = { rows: [], total: 0 };
  let offboarded: { rows: SeatLifecycleRow[]; total: number } = { rows: [], total: 0 };
  let coverage = EMPTY_COVERAGE;
  let available = true;

  try {
    stats = getSeatLifecycleStats(query);
    trend = getSeatLifecycleTrend(query);
    onboarded = getSeatLifecycleRows(query, "onboarded", { page: onboardedPage, pageSize, sort, sortDir });
    offboarded = getSeatLifecycleRows(query, "offboarded", { page: offboardedPage, pageSize, sort, sortDir });
    coverage = getSeatLifecycleCoverage(query);
  } catch (err) {
    console.error("[api/seats/lifecycle] Falling back to empty payload:", err);
    available = false;
  }

  return NextResponse.json(
    {
      window: { start: window.start, end: window.end, explicit: window.explicit },
      stats,
      trend,
      onboarded: {
        rows: onboarded.rows,
        pagination: {
          page: onboardedPage,
          pageSize,
          totalItems: onboarded.total,
          totalPages: Math.max(1, Math.ceil(onboarded.total / pageSize)),
        },
      },
      offboarded: {
        rows: offboarded.rows,
        pagination: {
          page: offboardedPage,
          pageSize,
          totalItems: offboarded.total,
          totalPages: Math.max(1, Math.ceil(offboarded.total / pageSize)),
        },
      },
      coverage,
      filtered: filter.hasFilter,
      available,
    },
    { headers: available ? CACHE_HEADERS : DEGRADED_CACHE_HEADERS },
  );
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
