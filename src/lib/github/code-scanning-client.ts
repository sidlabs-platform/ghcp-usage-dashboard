// GitHub API client for Code Scanning alerts

import { githubFetchPaginatedWithCutoff, githubFetch } from "./api-base";
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
  ): Promise<CodeScanningAlert[]> {
    const path = `/orgs/${org}/code-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<CodeScanningAlert>(
      path,
      cutoffDate ?? null,
    );
  }

  async getEnterpriseAlerts(
    enterprise: string,
    cutoffDate?: string | null,
  ): Promise<CodeScanningAlert[]> {
    const path = `/enterprises/${enterprise}/code-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<CodeScanningAlert>(
      path,
      cutoffDate ?? null,
    );
  }

  /**
   * Fetch autofix status for a specific code scanning alert.
   * Returns null if autofix is not available (404).
   * Throws on non-404 errors so callers can track failures.
   */
  async getAlertAutofixStatus(
    owner: string,
    repo: string,
    alertNumber: number,
  ): Promise<AutofixStatusResponse | null> {
    try {
      return await githubFetch<AutofixStatusResponse>(
        `/repos/${owner}/${repo}/code-scanning/alerts/${alertNumber}/autofix`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        return null; // No autofix available — expected
      }
      // Re-throw non-404 errors so sync can track failure rate
      throw err;
    }
  }
}

export const codeScanningClient = new CodeScanningClient();
