// GitHub API client for Secret Scanning alerts

import { githubFetchPaginatedWithCutoff } from "./api-base";
import type { SecretScanningAlert } from "@/lib/types/ghas";

class SecretScanningClient {
  // Secret scanning supports state=open|resolved; omit state to get all alerts
  async getOrgAlerts(
    org: string,
    cutoffDate?: string | null,
  ): Promise<SecretScanningAlert[]> {
    const path = `/orgs/${org}/secret-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<SecretScanningAlert>(
      path,
      cutoffDate ?? null,
    );
  }

  async getEnterpriseAlerts(
    enterprise: string,
    cutoffDate?: string | null,
  ): Promise<SecretScanningAlert[]> {
    const path = `/enterprises/${enterprise}/secret-scanning/alerts?sort=updated&direction=desc`;
    return githubFetchPaginatedWithCutoff<SecretScanningAlert>(
      path,
      cutoffDate ?? null,
    );
  }
}

export const secretScanningClient = new SecretScanningClient();
