// GitHub API client for Code Scanning alerts

import { githubFetchPaginatedWithCutoff, githubFetch, GitHubApiError } from "./api-base";
import type { CodeScanningAlert } from "@/lib/types/ghas";

export interface AutofixStatusResponse {
  status: string; // "success", "error", "none", "outdated"
  description?: string;
  started_at?: string;
}

class CodeScanningClient {
  // Code scanning does not support state=all; omit state to get all alerts
  async getOrgAlerts(
    org: string,
    cutoffDate?: string | null,
    enterpriseSlug?: string,
  ): Promise<CodeScanningAlert[]> {
    const path = `/orgs/${org}/code-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<CodeScanningAlert>(
      path,
      cutoffDate ?? null,
      100, undefined, enterpriseSlug,
    );
  }

  async getEnterpriseAlerts(
    enterprise: string,
    cutoffDate?: string | null,
    enterpriseSlug?: string,
  ): Promise<CodeScanningAlert[]> {
    const path = `/enterprises/${enterprise}/code-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<CodeScanningAlert>(
      path,
      cutoffDate ?? null,
      100, undefined, enterpriseSlug,
    );
  }

  async getAlertAutofixStatus(
    owner: string,
    repo: string,
    alertNumber: number,
    enterpriseSlug?: string,
  ): Promise<AutofixStatusResponse | null> {
    try {
      return await githubFetch<AutofixStatusResponse>(
        `/repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/autofix`,
        3, undefined, enterpriseSlug,
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}

export const codeScanningClient = new CodeScanningClient();
