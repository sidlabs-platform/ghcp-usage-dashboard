// Teams repository — cache team memberships in SQLite

import { getDb } from "./database";
import type { TeamWithMembers } from "@/lib/types/teams";

export function upsertTeamMembers(team: TeamWithMembers): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO team_memberships (team_slug, team_name, source, org_slug, user_login, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Remove old members of this team
    db.prepare(`DELETE FROM team_memberships WHERE team_slug = ? AND source = ?`).run(team.slug, team.source);

    for (const login of team.members) {
      stmt.run(team.slug, team.name, team.source, team.orgSlug || null, login, now);
    }
  });

  tx();
}

export function upsertAllTeams(teams: TeamWithMembers[]): void {
  for (const team of teams) {
    upsertTeamMembers(team);
  }
}

export interface TeamRow {
  team_slug: string;
  team_name: string;
  source: string;
  org_slug: string | null;
  member_count: number;
}

export function getAllTeams(): TeamRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT team_slug, team_name, MAX(source) as source, org_slug, COUNT(DISTINCT user_login) as member_count
    FROM team_memberships
    GROUP BY team_slug
    ORDER BY team_name ASC
  `).all() as TeamRow[];
}

export function getTeamMembers(teamSlug: string): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT user_login FROM team_memberships WHERE team_slug = ? ORDER BY user_login
  `).all(teamSlug) as { user_login: string }[];

  return rows.map((r) => r.user_login);
}

export function getTeamsByUser(userLogin: string): { team_slug: string; team_name: string }[] {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT team_slug, team_name FROM team_memberships WHERE user_login = ?
  `).all(userLogin) as { team_slug: string; team_name: string }[];
}

/** Get unique user logins across multiple teams */
export function getTeamMembersMulti(teamSlugs: string[]): string[] {
  if (teamSlugs.length === 0) return [];
  const db = getDb();
  const placeholders = teamSlugs.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM team_memberships
    WHERE team_slug IN (${placeholders})
    ORDER BY user_login
  `).all(...teamSlugs) as { user_login: string }[];
  return rows.map((r) => r.user_login);
}

/** Get unique user logins for all teams belonging to given orgs */
export function getMembersForOrgs(orgSlugs: string[]): string[] {
  if (orgSlugs.length === 0) return [];
  const db = getDb();
  const placeholders = orgSlugs.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM team_memberships
    WHERE org_slug IN (${placeholders})
    ORDER BY user_login
  `).all(...orgSlugs) as { user_login: string }[];
  return rows.map((r) => r.user_login);
}

/** Get distinct org slugs from team memberships */
export function getDistinctOrgs(): { slug: string; name: string }[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT org_slug FROM team_memberships
    WHERE org_slug IS NOT NULL AND org_slug != ''
    ORDER BY org_slug
  `).all() as { org_slug: string }[];
  return rows.map((r) => ({ slug: r.org_slug, name: r.org_slug }));
}

/** Resolve team + org filters into a unique set of user logins */
export function resolveFilteredUsers(teamSlugs: string[], orgSlugs: string[]): string[] {
  const logins = new Set<string>();
  if (teamSlugs.length > 0) {
    for (const login of getTeamMembersMulti(teamSlugs)) logins.add(login);
  }
  if (orgSlugs.length > 0) {
    for (const login of getMembersForOrgs(orgSlugs)) logins.add(login);
  }
  return Array.from(logins).sort();
}
