import { NextResponse } from "next/server";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";
import { getUserSummaries } from "@/lib/db/aggregation-queries";
import { getDateRange } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = Number(searchParams.get("days") ?? 7);
    const { start, end } = getDateRange(days);

    const teamsParam = searchParams.get("teams");
    const orgsParam = searchParams.get("orgs");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

    const allowedLogins = hasFilter
      ? resolveFilteredUsers(selectedTeams, selectedOrgs)
      : undefined;

    const users = getUserSummaries(start, end, allowedLogins);

    return NextResponse.json({ users }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
