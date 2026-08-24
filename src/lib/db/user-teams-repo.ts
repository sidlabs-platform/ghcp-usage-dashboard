// User-teams repository — per-day Copilot team attribution from user-teams-1-day API

import { getDb } from "./database";
import type { UserTeamRecord } from "@/lib/types/metrics";

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

/** Bulk upsert user-team records for a given enterprise and day */
export function batchUpsertUserTeams(enterpriseSlug: string, day: string, records: UserTeamRecord[]): void {
  if (records.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO copilot_user_teams (day, enterprise_slug, org_slug, team_slug, user_id, user_login, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const record of records) {
      if (record.day && record.day !== day) {
        throw new Error(`batchUpsertUserTeams day mismatch: expected ${day}, got ${record.day}`);
      }
      stmt.run(day, enterpriseSlug, record.organization_id ?? '', record.team_slug, record.user_id, record.user_login, now);
    }
  });

  tx();
}

/** Get distinct teams from Copilot attribution data for a date range */
export function getCopilotTeams(startDay: string, endDay: string, enterpriseSlugs?: string[]): {
  team_slug: string;
  enterprise_slug: string;
  org_slug: string | null;
  member_count: number;
}[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  return db.prepare(`
    SELECT team_slug, enterprise_slug, org_slug, COUNT(DISTINCT user_id) as member_count
    FROM copilot_user_teams
    WHERE day >= ? AND day <= ?${ef.clause}
    GROUP BY enterprise_slug, team_slug, org_slug
    ORDER BY team_slug ASC
  `).all(startDay, endDay, ...ef.params) as {
    team_slug: string;
    enterprise_slug: string;
    org_slug: string | null;
    member_count: number;
  }[];
}

/** Get user logins for a specific team in a date range */
export function getCopilotTeamMembers(
  teamSlug: string,
  startDay: string,
  endDay: string,
  enterpriseSlugs?: string[],
  orgSlug?: string,
): string[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const orgClause = orgSlug ? " AND org_slug = ?" : "";
  const orgParams = orgSlug ? [orgSlug] : [];
  const rows = db.prepare(`
    SELECT MAX(user_login) AS user_login
    FROM copilot_user_teams
    WHERE team_slug = ? AND day >= ? AND day <= ?${ef.clause}${orgClause}
    GROUP BY user_id
    ORDER BY user_login
  `).all(teamSlug, startDay, endDay, ...ef.params, ...orgParams) as { user_login: string }[];
  return rows.map((row) => row.user_login);
}

/** Get teams for a specific user in a date range */
export function getCopilotTeamsByUser(
  userLogin: string,
  startDay: string,
  endDay: string,
  enterpriseSlugs?: string[],
): { team_slug: string }[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  return db.prepare(`
    SELECT DISTINCT team_slug
    FROM copilot_user_teams
    WHERE LOWER(user_login) = LOWER(?) AND day >= ? AND day <= ?${ef.clause}
    ORDER BY team_slug
  `).all(userLogin, startDay, endDay, ...ef.params) as { team_slug: string }[];
}
