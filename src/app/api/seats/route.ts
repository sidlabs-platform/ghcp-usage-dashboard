import { NextResponse } from "next/server";
import { getAllSeats, getSeatStats } from "@/lib/db/seats-repo";
import { resolveFilteredUsers } from "@/lib/db/teams-repo";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const teamsParam = searchParams.get("teams");
    const orgsParam = searchParams.get("orgs");
    const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
    const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
    const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

    let seats = getAllSeats();
    const stats = getSeatStats();

    if (hasFilter) {
      const allowedLogins = new Set(resolveFilteredUsers(selectedTeams, selectedOrgs));
      // Also filter by org_slug when orgs are selected directly
      const orgSet = selectedOrgs.length > 0 ? new Set(selectedOrgs) : null;
      seats = seats.filter((s) => {
        if (allowedLogins.has(s.user_login)) return true;
        if (orgSet && orgSet.has(s.org_slug)) return true;
        return false;
      });
    }

    const utilization = stats.total > 0
      ? Number(((stats.active30d / stats.total) * 100).toFixed(1))
      : 0;

    return NextResponse.json({ seats, stats, utilization, filtered: hasFilter }, {
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=60" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
