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
  const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
  const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
  const selectedEnterprises = enterprisesParam ? enterprisesParam.split(",").filter(Boolean) : [];
  const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0 || selectedEnterprises.length > 0;

  // Resolve enterprise slugs for SQL filtering (undefined = all)
  const enterpriseSlugs = selectedEnterprises.length > 0 ? selectedEnterprises : undefined;

  let allowedLogins: Set<string> | undefined;
  if (selectedTeams.length > 0 || selectedOrgs.length > 0) {
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
