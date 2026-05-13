import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { getAllTeamsWithMembers } from "@/lib/db/teams-repo";
import { getAllUserMetrics } from "@/lib/db/metrics-repo";
import { computeTeamSummary } from "@/lib/aggregation/team-metrics";
import { refreshTeamSummary } from "@/lib/db/summary-tables";
import { parseDateRangeParams } from "@/lib/utils";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";

interface TeamResult {
  teamSlug: string; teamName: string; source: string; orgSlug: string | null;
  totalMembers: number; avgDailyActiveUsers: number; totalLocAdded: number;
  totalInteractions: number; overallAcceptanceRate: number;
  agentAdoptionRate: number; chatAdoptionRate: number; cliAdoptionRate: number;
  codeReviewAdoptionRate: number;
}

/** Try to serve from the pre-aggregated cache; returns null if cache is empty for this period */
function fromCache(
  db: ReturnType<typeof getDb>, start: string, end: string,
  selectedSlugs: string[], selectedOrgs: string[], enterpriseSlugs: string[],
  sort: string, sortDir: string, page: number, pageSize: number,
): { teams: TeamResult[]; total: number } | null {
  // Quick check — if no rows exist for this period, return null to trigger fallback
  const probe = db.prepare(
    `SELECT 1 FROM team_summary_cache WHERE period_start = ? AND period_end = ? LIMIT 1`
  ).get(start, end);
  if (!probe) return null;

  const conditions: string[] = ["period_start = ? AND period_end = ?"];
  const queryParams: (string | number)[] = [start, end];

  if (enterpriseSlugs.length > 0) {
    conditions.push(`enterprise_slug IN (${enterpriseSlugs.map(() => "?").join(",")})`);
    queryParams.push(...enterpriseSlugs);
  }
  if (selectedSlugs.length > 0) {
    conditions.push(`team_slug IN (${selectedSlugs.map(() => "?").join(",")})`);
    queryParams.push(...selectedSlugs);
  }
  if (selectedOrgs.length > 0) {
    conditions.push(`org_slug IN (${selectedOrgs.map(() => "?").join(",")})`);
    queryParams.push(...selectedOrgs);
  }

  const whereClause = conditions.join(" AND ");

  const sortColumns: Record<string, string> = {
    teamName: "team_name", totalMembers: "total_members", total_members: "total_members",
    avgDailyActiveUsers: "avg_daily_active_users", totalLocAdded: "total_loc_added",
    overallAcceptanceRate: "overall_acceptance_rate", totalInteractions: "total_interactions",
    agentAdoptionRate: "agent_adoption_rate", chatAdoptionRate: "chat_adoption_rate",
    cliAdoptionRate: "cli_adoption_rate",
  };
  const sqlSort = sortColumns[sort] || "total_members";
  const sqlDir = sortDir === "asc" ? "ASC" : "DESC";

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM team_summary_cache WHERE ${whereClause}`
  ).get(...queryParams) as { total: number };

  const offset = (page - 1) * pageSize;
  const rows = db.prepare(`
    SELECT team_slug, team_name, source, org_slug,
           total_members, active_members, avg_daily_active_users,
           total_loc_added, total_interactions, overall_acceptance_rate,
           agent_adoption_rate, chat_adoption_rate, cli_adoption_rate, code_review_adoption_rate
    FROM team_summary_cache
    WHERE ${whereClause}
    ORDER BY ${sqlSort} ${sqlDir}
    LIMIT ? OFFSET ?
  `).all(...queryParams, pageSize, offset) as Array<Record<string, unknown>>;

  const teams = rows.map((r) => ({
    teamSlug: r.team_slug as string, teamName: r.team_name as string,
    source: r.source as string, orgSlug: r.org_slug as string | null,
    totalMembers: r.total_members as number,
    avgDailyActiveUsers: r.avg_daily_active_users as number,
    totalLocAdded: r.total_loc_added as number,
    totalInteractions: r.total_interactions as number,
    overallAcceptanceRate: r.overall_acceptance_rate as number,
    agentAdoptionRate: r.agent_adoption_rate as number,
    chatAdoptionRate: r.chat_adoption_rate as number,
    cliAdoptionRate: r.cli_adoption_rate as number,
    codeReviewAdoptionRate: r.code_review_adoption_rate as number,
  }));

  return { teams, total: countRow.total };
}

/** Fallback: compute from live data (original logic) and populate the cache for next time */
function fromLiveData(
  start: string, end: string,
  selectedSlugs: string[], selectedOrgs: string[],
  sort: string, sortDir: string,
  page: number, pageSize: number,
  enterpriseSlugs?: string[],
): { teams: TeamResult[]; total: number } {
  let teamsWithMembers = getAllTeamsWithMembers(enterpriseSlugs);
  if (selectedSlugs.length > 0) {
    const slugSet = new Set(selectedSlugs);
    teamsWithMembers = teamsWithMembers.filter((t) => slugSet.has(t.team_slug));
  }

  const userRecords = getAllUserMetrics(start, end, enterpriseSlugs);

  let summaries = teamsWithMembers.map((team) => {
    const summary = computeTeamSummary(team.team_slug, team.team_name, team.members, userRecords);
    return {
      teamSlug: summary.teamSlug, teamName: summary.teamName,
      source: team.source, orgSlug: team.org_slug,
      totalMembers: summary.totalMembers,
      avgDailyActiveUsers: summary.avgDailyActiveUsers,
      totalLocAdded: summary.totalLocAdded,
      totalInteractions: summary.totalInteractions,
      overallAcceptanceRate: Number(summary.overallAcceptanceRate.toFixed(1)),
      agentAdoptionRate: Number(summary.agentAdoptionRate.toFixed(1)),
      chatAdoptionRate: Number(summary.chatAdoptionRate.toFixed(1)),
      cliAdoptionRate: Number(summary.cliAdoptionRate.toFixed(1)),
      codeReviewAdoptionRate: Number(summary.codeReviewAdoptionRate.toFixed(1)),
    };
  });

  if (selectedOrgs.length > 0) {
    const orgSet = new Set(selectedOrgs);
    summaries = summaries.filter((t) => t.orgSlug && orgSet.has(t.orgSlug));
  }

  // Sort using the requested field
  const sortKey = sort as keyof TeamResult;
  const dir = sortDir === "asc" ? 1 : -1;
  summaries.sort((a, b) => {
    const av = a[sortKey] ?? 0;
    const bv = b[sortKey] ?? 0;
    if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
    return ((av as number) - (bv as number)) * dir;
  });

  // Populate the cache for next request (scoped by enterprise when filtered)
  try {
    if (enterpriseSlugs && enterpriseSlugs.length > 0) {
      for (const slug of enterpriseSlugs) refreshTeamSummary(start, end, slug);
    } else {
      refreshTeamSummary(start, end);
    }
  } catch { /* non-critical */ }

  const total = summaries.length;
  const offset = (page - 1) * pageSize;
  const paged = summaries.slice(offset, offset + pageSize);

  return { teams: paged, total };
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const rangeResult = parseDateRangeParams(params, 7);
    if ("error" in rangeResult) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const { start, end } = rangeResult;

    const teamsParam = params.get("teams");
    const orgsParam = params.get("orgs");
    const selectedSlugs = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];

    const enterprisesParam = params.get("enterprises");
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
    const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;

    const rawPage = parseInt(params.get("page") || "1", 10);
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);
    const rawPageSize = parseInt(params.get("pageSize") || "50", 10);
    const pageSize = Math.min(Math.max(1, Number.isNaN(rawPageSize) ? 50 : rawPageSize), 200);
    const sort = params.get("sort") || "total_members";
    const sortDir = (params.get("sortDir") === "asc" ? "asc" : "desc") as "asc" | "desc";

    const db = getDb();

    // Try pre-aggregated cache first; fall back to live computation
    const cached = fromCache(db, start, end, selectedSlugs, selectedOrgs, selectedEnterprises, sort, sortDir, page, pageSize);
    const result = cached ?? fromLiveData(start, end, selectedSlugs, selectedOrgs, sort, sortDir, page, pageSize, enterpriseSlugs);

    return NextResponse.json({
      teams: result.teams,
      pagination: {
        page, pageSize,
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
