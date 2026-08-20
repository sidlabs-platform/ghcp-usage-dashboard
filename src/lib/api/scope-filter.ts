// Shared utility for parsing team/org/enterprise filter params in API routes

import {
  resolveFilteredUsers,
  resolveFilteredUserScopes,
  type FilteredUserScope,
} from "@/lib/db/teams-repo";

interface ParsedScopeFilter {
  selectedTeams: string[];
  selectedOrgs: string[];
  selectedEnterprises: string[];
  hasFilter: boolean;
  /** Set of allowed user logins when team/org filter is active; undefined when no filter */
  allowedLogins?: Set<string>;
  /** Enterprise-qualified users when team and organization dimensions are intersected. */
  allowedUserScopes?: FilteredUserScope[];
  /** Enterprise slugs to filter by; undefined means all enterprises */
  enterpriseSlugs?: string[];
}

/**
 * Parse `teams`, `orgs`, and `enterprises` query parameters into SQL-ready scope criteria.
 *
 * Multiple values within one dimension are additive. When both teams and
 * organizations are selected, users must match both dimensions in the same
 * enterprise. A disjoint intersection returns empty allowed-login and
 * enterprise-qualified user collections so callers can deliberately match no rows.
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

  const compositeEnterpriseSlugs = Array.from(
    new Set(compositeTeams.map((team) => team.enterprise)),
  );
  // A composite team carries its enterprise identity even when the UI omits
  // the separate enterprises parameter.
  const enterpriseSlugs = selectedEnterprises.length > 0
    ? selectedEnterprises
    : (compositeEnterpriseSlugs.length > 0 ? compositeEnterpriseSlugs : undefined);

  if (compositeTeams.length > 0 && plainTeams.length === 0 && selectedOrgs.length === 0) {
    const allowedUserScopes: FilteredUserScope[] = [];
    const byEnterprise = new Map<string, string[]>();
    for (const team of compositeTeams) {
      const slugs = byEnterprise.get(team.enterprise) ?? [];
      slugs.push(team.team);
      byEnterprise.set(team.enterprise, slugs);
    }
    for (const [enterpriseSlug, teamSlugs] of byEnterprise) {
      for (const userLogin of resolveFilteredUsers(
        [...plainTeams, ...teamSlugs],
        [],
        [enterpriseSlug],
      )) {
        allowedUserScopes.push({ enterpriseSlug, userLogin });
      }
    }
    return {
      selectedTeams,
      selectedOrgs,
      selectedEnterprises,
      hasFilter,
      allowedLogins: new Set(allowedUserScopes.map((scope) => scope.userLogin)),
      allowedUserScopes,
      enterpriseSlugs,
    };
  }

  if (selectedTeams.length > 0 && selectedOrgs.length > 0) {
    let allowedUserScopes: FilteredUserScope[];
    if (compositeTeams.length > 0) {
      const scopes = new Map<string, FilteredUserScope>();
      const byEnterprise = new Map<string, string[]>();
      for (const team of compositeTeams) {
        const slugs = byEnterprise.get(team.enterprise) ?? [];
        slugs.push(team.team);
        byEnterprise.set(team.enterprise, slugs);
      }
      for (const [enterpriseSlug, teamSlugs] of byEnterprise) {
        for (const scope of resolveFilteredUserScopes(
          [...plainTeams, ...teamSlugs],
          selectedOrgs,
          [enterpriseSlug],
        )) {
          scopes.set(`${scope.enterpriseSlug}\0${scope.userLogin}`, scope);
        }
      }
      allowedUserScopes = Array.from(scopes.values());
    } else {
      allowedUserScopes = resolveFilteredUserScopes(
        selectedTeams,
        selectedOrgs,
        enterpriseSlugs,
      );
    }

    return {
      selectedTeams,
      selectedOrgs,
      selectedEnterprises,
      hasFilter,
      allowedLogins: new Set(allowedUserScopes.map((scope) => scope.userLogin)),
      allowedUserScopes,
      enterpriseSlugs,
    };
  }

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

  const allowedLogins = teamLogins ?? orgLogins;

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
