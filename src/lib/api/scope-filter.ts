// Shared utility for parsing team/org/enterprise filter params in API routes

import { resolveFilteredUsers } from "@/lib/db/teams-repo";

interface ParsedScopeFilter {
  selectedTeams: string[];
  selectedOrgs: string[];
  selectedEnterprises: string[];
  hasFilter: boolean;
  /** Set of allowed user logins when team/org filter is active; undefined when no filter */
  allowedLogins?: Set<string>;
  /** Enterprise slugs to filter by; undefined means all enterprises */
  enterpriseSlugs?: string[];
}

/**
 * Parse `teams`, `orgs`, and `enterprises` query parameters from a request
 * and resolve them to filter criteria.
 */
export function parseScopeFilter(searchParams: URLSearchParams): ParsedScopeFilter {
  const teamsParam = searchParams.get("teams");
  const orgsParam = searchParams.get("orgs");
  const enterprisesParam = searchParams.get("enterprises");
  const rawTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
  const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
  const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];

  // Parse composite team identifiers (enterpriseSlug:teamSlug) for multi-enterprise disambiguation
  const plainTeams: string[] = [];
  const compositeTeams: { enterprise: string; team: string }[] = [];
  for (const t of rawTeams) {
    const colonIdx = t.indexOf(":");
    if (colonIdx > 0) {
      compositeTeams.push({ enterprise: t.substring(0, colonIdx), team: t.substring(colonIdx + 1) });
    } else {
      plainTeams.push(t);
    }
  }

  const selectedTeams = [...plainTeams, ...compositeTeams.map((c) => c.team)];
  const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0 || selectedEnterprises.length > 0;

  // Resolve enterprise slugs for SQL filtering (undefined = all)
  const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;

  let teamLogins: Set<string> | undefined;

  if (compositeTeams.length > 0) {
    // Multi-enterprise: resolve members per-enterprise to avoid cross-enterprise slug collisions
    teamLogins = new Set<string>();

    const byEnterprise = new Map<string, string[]>();
    for (const ct of compositeTeams) {
      const existing = byEnterprise.get(ct.enterprise);
      if (existing) existing.push(ct.team);
      else byEnterprise.set(ct.enterprise, [ct.team]);
    }

    for (const [entSlug, teamSlugs] of byEnterprise) {
      for (const login of resolveFilteredUsers(teamSlugs, [], [entSlug])) {
        teamLogins.add(login);
      }
    }

    // Handle any remaining plain team slugs
    if (plainTeams.length > 0) {
      for (const login of resolveFilteredUsers(plainTeams, [], enterpriseSlugs)) {
        teamLogins.add(login);
      }
    }
  } else if (selectedTeams.length > 0) {
    // Single-enterprise backward-compatible path
    teamLogins = new Set(resolveFilteredUsers(selectedTeams, [], enterpriseSlugs));
  }

  const orgLogins = selectedOrgs.length > 0
    ? new Set(resolveFilteredUsers([], selectedOrgs, enterpriseSlugs))
    : undefined;

  // Multiple values within one dimension are additive, while selecting both
  // an organization and a team narrows the result to members matching both.
  const allowedLogins = teamLogins && orgLogins
    ? new Set(Array.from(teamLogins).filter((login) => orgLogins.has(login)))
    : teamLogins ?? orgLogins;

  return { selectedTeams, selectedOrgs, selectedEnterprises, hasFilter, allowedLogins, enterpriseSlugs };
}

/**
 * Filter an array of records that have a `user_login` field by the allowed logins set.
 */
export function filterByScope<T extends { user_login: string }>(
  records: T[],
  filter: ParsedScopeFilter,
): T[] {
  if (!filter.hasFilter || !filter.allowedLogins) return records;
  return records.filter((r) => filter.allowedLogins!.has(r.user_login));
}
