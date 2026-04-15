// GitHub API client for Dependabot alerts
// Dependabot uses cursor-based pagination (after param), not page-based

import { githubFetchCursorPaginatedWithCutoff } from "./api-base";
import type { DependabotAlert } from "@/lib/types/ghas";

class DependabotClient {
  async getOrgAlerts(
    org: string,
    cutoffDate?: string | null,
    enterpriseSlug?: string,
  ): Promise<DependabotAlert[]> {
    const path = `/orgs/${org}/dependabot/alerts?sort=updated&direction=desc`;
    return githubFetchCursorPaginatedWithCutoff<DependabotAlert>(
      path,
      cutoffDate ?? null,
      100, undefined, enterpriseSlug,
    );
  }

  async getEnterpriseAlerts(
    enterprise: string,
    cutoffDate?: string | null,
    enterpriseSlug?: string,
  ): Promise<DependabotAlert[]> {
    const path = `/enterprises/${enterprise}/dependabot/alerts?sort=updated&direction=desc`;
    return githubFetchCursorPaginatedWithCutoff<DependabotAlert>(
      path,
      cutoffDate ?? null,
      100, undefined, enterpriseSlug,
    );
  }
}

export const dependabotClient = new DependabotClient();
