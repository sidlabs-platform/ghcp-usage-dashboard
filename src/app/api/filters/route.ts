import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/database";
import { withCache } from "@/lib/cache/with-cache";
import { withTimeout } from "@/lib/api/timeout";
import { CACHE_TTL } from "@/lib/cache/memory-cache";
import { getClientEnterpriseList } from "@/lib/config/enterprise-config";

async function handler(request: NextRequest) {
  try {
    const db = getDb();
    const params = request.nextUrl.searchParams;
    const enterprisesParam = params.get("enterprises");
    const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];

    // Build enterprise filter clause for SQL queries
    let entFilter = "";
    const entParams: string[] = [];
    if (selectedEnterprises.length > 0) {
      entFilter = ` AND enterprise_slug IN (${selectedEnterprises.map(() => "?").join(",")})`;
      entParams.push(...selectedEnterprises);
    }

    // Enterprise teams (source = 'enterprise')
    const entTeams = db.prepare(`
      SELECT team_slug as slug, team_name as name, enterprise_slug as enterpriseSlug, COUNT(DISTINCT LOWER(user_login)) as memberCount
      FROM team_memberships WHERE source = 'enterprise'${entFilter}
      GROUP BY team_slug, enterprise_slug ORDER BY team_name ASC
    `).all(...entParams) as { slug: string; name: string; enterpriseSlug: string; memberCount: number }[];

    // Org teams (source = 'org'), grouped by org
    const orgTeams = db.prepare(`
      SELECT team_slug as slug, team_name as name, org_slug as orgSlug, enterprise_slug as enterpriseSlug, COUNT(DISTINCT LOWER(user_login)) as memberCount
      FROM team_memberships WHERE source = 'org'${entFilter}
      GROUP BY team_slug, org_slug, enterprise_slug ORDER BY team_name ASC
    `).all(...entParams) as { slug: string; name: string; orgSlug: string; enterpriseSlug: string; memberCount: number }[];

    // Distinct orgs
    const orgs = db.prepare(`
      SELECT DISTINCT org_slug as slug, enterprise_slug as enterpriseSlug FROM team_memberships WHERE source = 'org' AND org_slug IS NOT NULL${entFilter}
      UNION
      SELECT DISTINCT org_slug as slug, enterprise_slug as enterpriseSlug FROM copilot_seats WHERE org_slug IS NOT NULL${entFilter}
    `).all(...entParams, ...entParams) as { slug: string; enterpriseSlug: string }[];

    // Client-safe enterprise list
    const enterprises = getClientEnterpriseList();

    return NextResponse.json({
      enterprises,
      enterpriseTeams: entTeams,
      orgTeams,
      orgs: orgs.map((o) => ({ slug: o.slug, name: o.slug, enterpriseSlug: o.enterpriseSlug })),
    }, {
      // No browser cache: server-side withCache() handles caching and is invalidated
      // after sync. Browser caching here would persist stale empty results across syncs.
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
export const GET = withRateLimit(withTimeout(withCache(handler, CACHE_TTL.FILTERS)));
