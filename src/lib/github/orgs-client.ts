// GitHub Enterprise Organizations API Client

import { githubFetchPaginated } from "./api-base";

/** Minimal org shape returned by the enterprise orgs endpoint. */
export interface GitHubOrg {
  login: string;
  id: number;
}

export class OrgsClient {
  /**
   * List all organizations in an enterprise.
   * Uses `GET /enterprises/{enterprise}/organizations` (paginated).
   * Requires PAT with `read:enterprise` scope.
   */
  async listEnterpriseOrgs(enterprise: string, enterpriseSlug?: string): Promise<GitHubOrg[]> {
    return githubFetchPaginated<GitHubOrg>(
      `/enterprises/${enterprise}/organizations`,
      100,
      "pat",
      enterpriseSlug,
    );
  }
}

export const orgsClient = new OrgsClient();
