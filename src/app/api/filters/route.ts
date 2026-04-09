import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";

export async function GET() {
  try {
    const db = getDb();

    // Enterprise teams (source = 'enterprise')
    const entTeams = db.prepare(`
      SELECT team_slug as slug, team_name as name, COUNT(DISTINCT user_login) as memberCount
      FROM team_memberships WHERE source = 'enterprise'
      GROUP BY team_slug ORDER BY team_name ASC
    `).all() as { slug: string; name: string; memberCount: number }[];

    // Org teams (source = 'org'), grouped by org
    const orgTeams = db.prepare(`
      SELECT team_slug as slug, team_name as name, org_slug as orgSlug, COUNT(DISTINCT user_login) as memberCount
      FROM team_memberships WHERE source = 'org'
      GROUP BY team_slug ORDER BY team_name ASC
    `).all() as { slug: string; name: string; orgSlug: string; memberCount: number }[];

    // Distinct orgs
    const orgs = db.prepare(`
      SELECT DISTINCT org_slug as slug FROM team_memberships WHERE source = 'org' AND org_slug IS NOT NULL
      UNION
      SELECT DISTINCT org_slug as slug FROM copilot_seats WHERE org_slug IS NOT NULL
    `).all() as { slug: string }[];

    return NextResponse.json({
      enterpriseTeams: entTeams,
      orgTeams,
      orgs: orgs.map((o) => ({ slug: o.slug, name: o.slug })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
