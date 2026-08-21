import { NextRequest, NextResponse } from "next/server";
import { resolveWindow } from "@/lib/utils";
import { parseScopeFilter } from "@/lib/api/scope-filter";
import { parsePaginationParams } from "@/lib/api/pagination";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { estimateCopilotAppRowCount, getCopilotAppAdopters } from "@/lib/db/copilot-app-queries";
import type { CopilotAppAdoptersResponse } from "@/lib/types/metrics";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const window = resolveWindow(params, 7);
    if ("error" in window) {
      return NextResponse.json({ error: window.error }, { status: 400 });
    }
    const { start, end } = window;

    const scope = parseScopeFilter(params);
    const allowedLogins = scope.allowedLogins ? Array.from(scope.allowedLogins) : undefined;
    const { enterpriseSlugs } = scope;

    // Row-count guard — same threshold/estimate as the summary route, since
    // the adopter roster query walks the same json_each-heavy row set.
    const estimate = estimateCopilotAppRowCount(start, end, allowedLogins, enterpriseSlugs);
    if (estimate.exceeds) {
      return NextResponse.json(
        {
          error: `Result set too large (${estimate.count.toLocaleString()} rows) for Copilot App analytics. Try a narrower date range or add filters.`,
        },
        { status: 400 },
      );
    }

    const { page, pageSize, sortField, sortDir, search } = parsePaginationParams(params, "sessions", "desc");

    // Adopters is a user-only view — no enterprise/org aggregate fallback,
    // since per-adopter rosters can't be derived from aggregate rollups.
    const result = getCopilotAppAdopters(
      start,
      end,
      page,
      pageSize,
      sortField,
      sortDir,
      search,
      allowedLogins,
      enterpriseSlugs,
    );

    const response: CopilotAppAdoptersResponse = {
      adopters: result.adopters,
      pagination: {
        page,
        pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / pageSize),
      },
    };

    return NextResponse.json(response, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.MEDIUM)));
