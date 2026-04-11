// GitHub API client for Code Scanning alerts

import { githubFetchPaginatedWithCutoff } from "./api-base";
import type { CodeScanningAlert } from "@/lib/types/ghas";

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
}

export const codeScanningClient = new CodeScanningClient();
