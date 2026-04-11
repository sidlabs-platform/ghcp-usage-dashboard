// Shared utility for parsing team/org filter params in API routes

import { resolveFilteredUsers } from "@/lib/db/teams-repo";

interface ParsedScopeFilter {
  selectedTeams: string[];
  selectedOrgs: string[];
  hasFilter: boolean;
  /** Set of allowed user logins when filter is active; undefined when no filter */
  allowedLogins?: Set<string>;
}

/**
 * Parse `teams` and `orgs` query parameters from a request and resolve them
 * to a set of allowed user logins via the team_memberships table.
 */
export function parseScopeFilter(searchParams: URLSearchParams): ParsedScopeFilter {
  const teamsParam = searchParams.get("teams");
  const orgsParam = searchParams.get("orgs");
  const selectedTeams = teamsParam ? teamsParam.split(",").filter(Boolean) : [];
  const selectedOrgs = orgsParam ? orgsParam.split(",").filter(Boolean) : [];
  const hasFilter = selectedTeams.length > 0 || selectedOrgs.length > 0;

  let allowedLogins: Set<string> | undefined;
  if (hasFilter) {
    allowedLogins = new Set(resolveFilteredUsers(selectedTeams, selectedOrgs));
  }

  return { selectedTeams, selectedOrgs, hasFilter, allowedLogins };
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
