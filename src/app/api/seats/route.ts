import { NextRequest, NextResponse } from "next/server";
import { getSeatsPaginated, getSeatStats } from "@/lib/db/seats-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

    const page = Math.max(1, parseInt(params.get("page") || "1", 10));
    const pageSize = Math.min(Math.max(1, parseInt(params.get("pageSize") || "50", 10)), 200);
    const sort = params.get("sort") || "_lastActivity";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";

    const stats = getSeatStats();

    const allowedLogins = hasFilter
      ? new Set(resolveFilteredUsers(selectedTeams, selectedOrgs))
      : undefined;

    const result = getSeatsPaginated(page, pageSize, sort, sortDir, allowedLogins);

    const utilization = stats.total > 0
      ? Number(((stats.active30d / stats.total) * 100).toFixed(1))
      : 0;

    return NextResponse.json({
      seats: result.seats,
      stats,
      utilization,
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

export const GET = withTimeout(withCache(handler, CACHE_TTL.MEDIUM));
