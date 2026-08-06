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

  // Resolve enterprise slugs for SQL filtering (undefined = all). Composite
  // team identifiers carry their enterprise scope when no explicit filter is set.
  const compositeEnterprises = [...new Set(compositeTeams.map((c) => c.enterprise))];
  const enterpriseSlugs =
    selectedEnterprises.length > 0
      ? selectedEnterprises
      : compositeEnterprises.length > 0
        ? compositeEnterprises
        : undefined;

  let allowedLogins: Set<string> | undefined;

  if (compositeTeams.length > 0) {
    // Multi-enterprise: resolve members per-enterprise to avoid cross-enterprise slug collisions
    allowedLogins = new Set<string>();

    const byEnterprise = new Map<string, string[]>();
    for (const ct of compositeTeams) {
      const existing = byEnterprise.get(ct.enterprise);
      if (existing) existing.push(ct.team);
      else byEnterprise.set(ct.enterprise, [ct.team]);
    }

    for (const [entSlug, teamSlugs] of byEnterprise) {
      for (const login of resolveFilteredUsers(teamSlugs, [], [entSlug])) {
        allowedLogins.add(login);
      }
    }

    // Handle any remaining plain team slugs
    if (plainTeams.length > 0) {
      for (const login of resolveFilteredUsers(plainTeams, [], enterpriseSlugs)) {
        allowedLogins.add(login);
      }
    }

    // Handle org filtering alongside composite teams
    if (selectedOrgs.length > 0) {
      for (const login of resolveFilteredUsers([], selectedOrgs, enterpriseSlugs)) {
        allowedLogins.add(login);
      }
    }
  } else if (selectedTeams.length > 0 || selectedOrgs.length > 0) {
    // Single-enterprise backward-compatible path
    allowedLogins = new Set(resolveFilteredUsers(selectedTeams, selectedOrgs, enterpriseSlugs));
  }

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
