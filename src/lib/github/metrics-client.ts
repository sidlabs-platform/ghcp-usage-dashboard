// GitHub Copilot Usage Metrics API Client
// Primary data source: enterprise-1-day endpoint (supports up to 365 days of history)

import { githubFetch, fetchNDJSON, sleep } from "./api-base";
import type {
  ReportResponse,
  UserDayRecord,
  DayTotal,
  UserTeamRecord,
} from "@/lib/types/metrics";

export class MetricsClient {
  // Helper to extract DayTotal[] from NDJSON that may be wrapped or flat
  private extractDayTotals(records: Record<string, unknown>[], context?: string): DayTotal[] {
    const results: DayTotal[] = [];
    for (const record of records) {
      if (Array.isArray(record.day_totals)) {
        // Wrapped format: { enterprise_id, day_totals: [...] }
        results.push(...(record.day_totals as DayTotal[]));
      } else if (record.day && record.daily_active_users !== undefined) {
        // Flat DayTotal format
        results.push(record as unknown as DayTotal);
      } else if (record.day) {
        // Might be a DayTotal without daily_active_users (partial data)
        results.push(record as unknown as DayTotal);
      } else {
        console.warn(`[MetricsClient] ${context ?? "unknown"}: skipped unrecognised NDJSON record with keys: ${Object.keys(record).join(", ")}`);
      }
    }
    return results;
  }

  // ── Enterprise aggregate (1-day) ───────────────────────────────────

  async getEnterpriseDailyReport(enterprise: string, day: string, enterpriseSlug?: string): Promise<DayTotal[]> {
    const report = await githubFetch<ReportResponse>(
      `/enterprises/${enterprise}/copilot/metrics/reports/enterprise-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) {
      console.warn(`[MetricsClient] enterprise-1-day ${day}: no download_links (report keys: ${report ? Object.keys(report).join(", ") : "null"})`);
      return [];
    }

    const allRecords: Record<string, unknown>[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<Record<string, unknown>>(link);
      allRecords.push(...records);
    }

    const results = this.extractDayTotals(allRecords, `enterprise-1-day ${day}`);
    if (results.length === 0 && allRecords.length > 0) {
      console.warn(`[MetricsClient] enterprise-1-day ${day}: ${allRecords.length} NDJSON records fetched but 0 matched DayTotal shape`);
    }
    return results;
  }

  // ── Enterprise aggregate (28-day latest) ───────────────────────────

  async getEnterprise28DayReport(enterprise: string, enterpriseSlug?: string): Promise<DayTotal[]> {
    const report = await githubFetch<ReportResponse>(
      `/enterprises/${enterprise}/copilot/metrics/reports/enterprise-28-day/latest`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) {
      console.warn(`[MetricsClient] enterprise-28-day: no download_links (report keys: ${report ? Object.keys(report).join(", ") : "null"})`);
      return [];
    }

    const allRecords: Record<string, unknown>[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<Record<string, unknown>>(link);
      allRecords.push(...records);
    }

    const results = this.extractDayTotals(allRecords, "enterprise-28-day");
    console.log(`[MetricsClient] enterprise-28-day: ${results.length} day-totals extracted from ${allRecords.length} NDJSON records`);
    return results;
  }

  // ── Enterprise user-level (1-day) ──────────────────────────────────

  async getEnterpriseUserDailyReport(enterprise: string, day: string, enterpriseSlug?: string): Promise<UserDayRecord[]> {
    const report = await githubFetch<ReportResponse>(
      `/enterprises/${enterprise}/copilot/metrics/reports/users-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) return [];

    const allUsers: UserDayRecord[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<UserDayRecord>(link);
      allUsers.push(...records);
    }
    return allUsers;
  }

  // ── Enterprise user-level (28-day latest) ──────────────────────────

  async getEnterpriseUser28DayReport(enterprise: string, enterpriseSlug?: string): Promise<UserDayRecord[]> {
    const report = await githubFetch<ReportResponse>(
      `/enterprises/${enterprise}/copilot/metrics/reports/users-28-day/latest`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) return [];

    const allUsers: UserDayRecord[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<UserDayRecord>(link);
      allUsers.push(...records);
    }
    return allUsers;
  }

  // ── Organization aggregate (1-day) ─────────────────────────────────

  async getOrgDailyReport(org: string, day: string, enterpriseSlug?: string): Promise<DayTotal[]> {
    const report = await githubFetch<ReportResponse>(
      `/orgs/${org}/copilot/metrics/reports/organization-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) {
      console.warn(`[MetricsClient] org-1-day ${org} ${day}: no download_links`);
      return [];
    }

    const allRecords: Record<string, unknown>[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<Record<string, unknown>>(link);
      allRecords.push(...records);
    }

    return this.extractDayTotals(allRecords, `org-1-day ${org} ${day}`);
  }

  // ── Organization aggregate (28-day latest) ─────────────────────────

  async getOrg28DayReport(org: string, enterpriseSlug?: string): Promise<DayTotal[]> {
    const report = await githubFetch<ReportResponse>(
      `/orgs/${org}/copilot/metrics/reports/organization-28-day/latest`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) {
      console.warn(`[MetricsClient] org-28-day ${org}: no download_links`);
      return [];
    }

    const allRecords: Record<string, unknown>[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<Record<string, unknown>>(link);
      allRecords.push(...records);
    }

    const results = this.extractDayTotals(allRecords, `org-28-day ${org}`);
    console.log(`[MetricsClient] org-28-day ${org}: ${results.length} day-totals extracted`);
    return results;
  }

  // ── Organization user-level (1-day) ────────────────────────────────

  async getOrgUserDailyReport(org: string, day: string, enterpriseSlug?: string): Promise<UserDayRecord[]> {
    const report = await githubFetch<ReportResponse>(
      `/orgs/${org}/copilot/metrics/reports/users-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) return [];

    const allUsers: UserDayRecord[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<UserDayRecord>(link);
      allUsers.push(...records);
    }
    return allUsers;
  }

  // ── Enterprise user-teams (1-day) ────────────────────────────────────

  async getEnterpriseUserTeamsReport(enterprise: string, day: string, enterpriseSlug?: string): Promise<UserTeamRecord[]> {
    const report = await githubFetch<ReportResponse>(
      `/enterprises/${enterprise}/copilot/metrics/reports/user-teams-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) return [];

    const allRecords: UserTeamRecord[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<UserTeamRecord>(link);
      allRecords.push(...records);
    }
    return allRecords;
  }

  // ── Org user-teams (1-day) ───────────────────────────────────────────

  async getOrgUserTeamsReport(org: string, day: string, enterpriseSlug?: string): Promise<UserTeamRecord[]> {
    const report = await githubFetch<ReportResponse>(
      `/orgs/${org}/copilot/metrics/reports/user-teams-1-day?day=${day}`,
      3, undefined, enterpriseSlug
    );
    if (!report?.download_links?.length) return [];

    const allRecords: UserTeamRecord[] = [];
    for (const link of report.download_links) {
      const records = await fetchNDJSON<UserTeamRecord>(link);
      allRecords.push(...records);
    }
    return allRecords;
  }

  // ── Orchestrator: fetch a range of days ────────────────────────────
  // This is the primary method for backfilling 90+ days of data.
  // It calls the enterprise-1-day endpoint for each day in the range.

  async fetchEnterpriseDateRange(
    enterprise: string,
    days: string[],
    onProgress?: (day: string, index: number, total: number) => void
  ): Promise<Map<string, DayTotal[]>> {
    const results = new Map<string, DayTotal[]>();

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      onProgress?.(day, i, days.length);

      try {
        const data = await this.getEnterpriseDailyReport(enterprise, day);
        results.set(day, data);
      } catch (err) {
        console.error(`Failed to fetch enterprise data for ${day}:`, err);
        results.set(day, []);
      }

      // Rate limit courtesy: 2-second delay between day fetches
      if (i < days.length - 1) await sleep(2000);
    }

    return results;
  }

  async fetchEnterpriseUserDateRange(
    enterprise: string,
    days: string[],
    onProgress?: (day: string, index: number, total: number) => void
  ): Promise<Map<string, UserDayRecord[]>> {
    const results = new Map<string, UserDayRecord[]>();

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      onProgress?.(day, i, days.length);

      try {
        const data = await this.getEnterpriseUserDailyReport(enterprise, day);
        results.set(day, data);
      } catch (err) {
        console.error(`Failed to fetch user data for ${day}:`, err);
        results.set(day, []);
      }

      if (i < days.length - 1) await sleep(2000);
    }

    return results;
  }

  async fetchOrgDateRange(
    org: string,
    days: string[],
    onProgress?: (day: string, index: number, total: number) => void
  ): Promise<Map<string, DayTotal[]>> {
    const results = new Map<string, DayTotal[]>();

    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      onProgress?.(day, i, days.length);

      try {
        const data = await this.getOrgDailyReport(org, day);
        results.set(day, data);
      } catch (err) {
        console.error(`Failed to fetch org ${org} data for ${day}:`, err);
        results.set(day, []);
      }

      if (i < days.length - 1) await sleep(2000);
    }

    return results;
  }
}

export const metricsClient = new MetricsClient();
