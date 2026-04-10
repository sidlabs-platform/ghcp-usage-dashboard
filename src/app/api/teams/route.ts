import { NextResponse } from "next/server";
import { getAllTeamsWithMembers } from "@/lib/db/teams-repo";
import { getAllUserMetrics } from "@/lib/db/metrics-repo";
import { computeTeamSummary } from "@/lib/aggregation/team-metrics";
import { getDateRange } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);

    const teamsParam = searchParams.get("teams");
    const selectedSlugs = teamsParam ? teamsParam.split(",").filter(Boolean) : [];

    let teamsWithMembers = getAllTeamsWithMembers();
    if (selectedSlugs.length > 0) {
      const slugSet = new Set(selectedSlugs);
      teamsWithMembers = teamsWithMembers.filter((t) => slugSet.has(t.team_slug));
    }

    const userRecords = getAllUserMetrics(start, end);

    const summaries = teamsWithMembers.map((team) => {
      const summary = computeTeamSummary(team.team_slug, team.team_name, team.members, userRecords);
      return {
        teamSlug: summary.teamSlug,
        teamName: summary.teamName,
        source: team.source,
        orgSlug: team.org_slug,
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

    return NextResponse.json({ teams: summaries }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
