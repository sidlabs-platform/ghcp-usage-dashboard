// Teams repository — cache team memberships in SQLite

import { getDb } from "./database";
import type { TeamWithMembers } from "@/lib/types/teams";

function buildEnterpriseFilter(slugs?: string[]): { clause: string; params: string[] } {
  if (!slugs || slugs.length === 0) return { clause: "", params: [] };
  const placeholders = slugs.map(() => "?").join(",");
  return { clause: ` AND enterprise_slug IN (${placeholders})`, params: slugs };
}

export function upsertTeamMembers(enterpriseSlug: string, team: TeamWithMembers): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO team_memberships (enterprise_slug, team_slug, team_name, source, org_slug, user_login, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Remove old members of this team
    db.prepare(`DELETE FROM team_memberships WHERE team_slug = ? AND source = ? AND enterprise_slug = ?`).run(team.slug, team.source, enterpriseSlug);

    for (const login of team.members) {
      stmt.run(enterpriseSlug, team.slug, team.name, team.source, team.orgSlug || null, login, now);
    }
  });

  tx();
}

export function upsertAllTeams(enterpriseSlug: string, teams: TeamWithMembers[]): void {
  for (const team of teams) {
    upsertTeamMembers(enterpriseSlug, team);
  }
}

export interface TeamRow {
  enterprise_slug: string;
  team_slug: string;
  team_name: string;
  source: string;
  org_slug: string | null;
  member_count: number;
}

export function getAllTeams(enterpriseSlugs?: string[]): TeamRow[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const where = ef.clause ? `WHERE 1=1${ef.clause}` : "";
  return db.prepare(`
    SELECT enterprise_slug, team_slug, team_name, MAX(source) as source, org_slug, COUNT(DISTINCT user_login) as member_count
    FROM team_memberships
    ${where}
    GROUP BY enterprise_slug, team_slug, source, org_slug
    ORDER BY team_name ASC
  `).all(...ef.params) as TeamRow[];
}

export function getTeamMembers(teamSlug: string, enterpriseSlugs?: string[]): string[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT user_login FROM team_memberships WHERE team_slug = ?${ef.clause} ORDER BY user_login
  `).all(teamSlug, ...ef.params) as { user_login: string }[];

  return rows.map((r) => r.user_login);
}

export function getTeamsByUser(userLogin: string, enterpriseSlugs?: string[]): { team_slug: string; team_name: string }[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  return db.prepare(`
    SELECT DISTINCT team_slug, team_name FROM team_memberships WHERE user_login = ?${ef.clause}
  `).all(userLogin, ...ef.params) as { team_slug: string; team_name: string }[];
}

/** Get unique user logins across multiple teams */
export function getTeamMembersMulti(teamSlugs: string[], enterpriseSlugs?: string[]): string[] {
  if (teamSlugs.length === 0) return [];
  const db = getDb();
  const placeholders = teamSlugs.map(() => "?").join(",");
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM team_memberships
    WHERE team_slug IN (${placeholders})${ef.clause}
    ORDER BY user_login
  `).all(...teamSlugs, ...ef.params) as { user_login: string }[];
  return rows.map((r) => r.user_login);
}

/** Get unique user logins for all teams belonging to given orgs */
export function getMembersForOrgs(orgSlugs: string[], enterpriseSlugs?: string[]): string[] {
  if (orgSlugs.length === 0) return [];
  const db = getDb();
  const placeholders = orgSlugs.map(() => "?").join(",");
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT DISTINCT user_login FROM team_memberships
    WHERE org_slug IN (${placeholders})${ef.clause}
    ORDER BY user_login
  `).all(...orgSlugs, ...ef.params) as { user_login: string }[];
  return rows.map((r) => r.user_login);
}

/** Get distinct org slugs from team memberships */
export function getDistinctOrgs(enterpriseSlugs?: string[]): { slug: string; name: string }[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const rows = db.prepare(`
    SELECT DISTINCT org_slug FROM team_memberships
    WHERE org_slug IS NOT NULL AND org_slug != ''${ef.clause}
    ORDER BY org_slug
  `).all(...ef.params) as { org_slug: string }[];
  return rows.map((r) => ({ slug: r.org_slug, name: r.org_slug }));
}

/** Load all teams with their members in a single query (avoids N+1) */
export function getAllTeamsWithMembers(enterpriseSlugs?: string[]): { team_slug: string; team_name: string; source: string; org_slug: string | null; members: string[] }[] {
  const db = getDb();
  const ef = buildEnterpriseFilter(enterpriseSlugs);
  const where = ef.clause ? `WHERE 1=1${ef.clause}` : "";
  const rows = db.prepare(`
    SELECT team_slug, team_name, source, org_slug, user_login
    FROM team_memberships
    ${where}
    ORDER BY team_slug, user_login
  `).all(...ef.params) as { team_slug: string; team_name: string; source: string; org_slug: string | null; user_login: string }[];

  const teamMap = new Map<string, { team_slug: string; team_name: string; source: string; org_slug: string | null; members: string[] }>();
  for (const row of rows) {
    const key = `${row.team_slug}:${row.source}`;
    let team = teamMap.get(key);
    if (!team) {
      team = { team_slug: row.team_slug, team_name: row.team_name, source: row.source, org_slug: row.org_slug, members: [] };
      teamMap.set(key, team);
    }
    team.members.push(row.user_login);
  }
  return Array.from(teamMap.values());
}

/** Resolve team + org filters into a unique set of user logins */
export function resolveFilteredUsers(teamSlugs: string[], orgSlugs: string[], enterpriseSlugs?: string[]): string[] {
  const logins = new Set<string>();
  if (teamSlugs.length > 0) {
    for (const login of getTeamMembersMulti(teamSlugs, enterpriseSlugs)) logins.add(login);
  }
  if (orgSlugs.length > 0) {
    for (const login of getMembersForOrgs(orgSlugs, enterpriseSlugs)) logins.add(login);
  }
  return Array.from(logins).sort();
}
