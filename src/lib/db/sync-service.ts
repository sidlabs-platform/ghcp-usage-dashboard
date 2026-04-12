// Data Sync Service — fetches data day-by-day using enterprise-1-day or org-1-day endpoints
// Supports 90+ day backfill by looping through each day individually
// Respects dashboard-config.json for enterprise/userMetrics/seats/teams toggles

import { metricsClient } from "@/lib/github/metrics-client";
import { seatsClient } from "@/lib/github/seats-client";
import { teamsClient } from "@/lib/github/teams-client";
import pLimit from "p-limit";
import {
  upsertEnterpriseDayMetrics,
  upsertOrgDayMetrics,
  upsertUserDayMetrics,
  batchUpsertUserDayMetrics,
  recordSync,
  isSynced,
  getLatestSyncDay,
  hasEnterpriseDataForRange,
  hasOrgDataForRange,
  heartbeatSyncLock,
} from "./metrics-repo";
import { upsertSeats } from "./seats-repo";
import { refreshAllSummaries } from "./summary-tables";
import { cache } from "@/lib/cache/memory-cache";
import { upsertAllTeams } from "./teams-repo";
import { datesBetween } from "@/lib/utils";
import { syncBilling } from "./billing-sync-service";
import {
  isEnterpriseEnabled,
  isCopilotSubEnabled,
  getResolvedOrgs,
} from "@/lib/config/dashboard-config";

const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || "90", 10);

/** Returns the enterprise slug, or null when enterprise mode is disabled. */
function getEnterprise(): string | null {
  if (!isEnterpriseEnabled()) return null;
  return process.env.GITHUB_ENTERPRISE || null;
}

export interface SyncProgress {
  phase: string;
  day?: string;
  current: number;
  total: number;
  message: string;
}

// ── Sync a single day ─────────────────────────────────────────────────

export async function syncDay(
  day: string,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ enterprise: number; users: number; orgs: Record<string, number> }> {
  const enterprise = getEnterprise();
  const orgs = getResolvedOrgs();
  const userMetricsEnabled = isCopilotSubEnabled("userMetrics");
  const result = { enterprise: 0, users: 0, orgs: {} as Record<string, number> };

  // 1. Enterprise aggregate (skipped when enterprise is disabled)
  if (enterprise && !isSynced("enterprise", enterprise, day)) {
    onProgress?.({ phase: "enterprise", day, current: 0, total: 1, message: `Fetching enterprise metrics for ${day}` });
    try {
      const data = await metricsClient.getEnterpriseDailyReport(enterprise, day);
      for (const record of data) {
        upsertEnterpriseDayMetrics(record);
      }
      result.enterprise = data.length;
      recordSync("enterprise", enterprise, day, data.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordSync("enterprise", enterprise, day, 0, "error", msg);
      console.error(`Failed to sync enterprise data for ${day}:`, msg);
    }
  }

  // 2. User-level metrics (skipped when userMetrics is disabled)
  if (userMetricsEnabled) {
    if (enterprise) {
      // Enterprise mode: fetch user data at enterprise scope
      if (!isSynced("users", enterprise, day)) {
        onProgress?.({ phase: "users", day, current: 0, total: 1, message: `Fetching user metrics for ${day}` });
        try {
          const users = await metricsClient.getEnterpriseUserDailyReport(enterprise, day);
          batchUpsertUserDayMetrics(users);
          result.users = users.length;
          recordSync("users", enterprise, day, users.length);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordSync("users", enterprise, day, 0, "error", msg);
          console.error(`Failed to sync user data for ${day}:`, msg);
        }
      }
    } else {
      // Org-only mode: fetch user data per org.
      // NOTE: The user_daily_metrics PK is (day, enterprise_id, user_id). If a user
      // belongs to multiple orgs, later fetches overwrite earlier ones. This is
      // acceptable because Copilot user metrics are global (not per-org scoped),
      // so the data for a given user is the same regardless of queried org.
      const orgUserLimit = pLimit(5);
      await Promise.all(orgs.map((org) => orgUserLimit(async () => {
        if (!isSynced("users", org, day)) {
          onProgress?.({ phase: "users", day, current: 0, total: orgs.length, message: `Fetching user metrics for org ${org} on ${day}` });
          try {
            const users = await metricsClient.getOrgUserDailyReport(org, day);
            batchUpsertUserDayMetrics(users);
            result.users += users.length;
            recordSync("users", org, day, users.length);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            recordSync("users", org, day, 0, "error", msg);
            console.error(`Failed to sync user data for org ${org} on ${day}:`, msg);
          }
        }
      })));
    }
  }

  // 3. Organization aggregates (parallel with concurrency limit)
  const orgLimit = pLimit(5);
  await Promise.all(orgs.map((org) => orgLimit(async () => {
    if (!isSynced("org", org, day)) {
      onProgress?.({ phase: "org", day, current: 0, total: orgs.length, message: `Fetching org ${org} metrics for ${day}` });
      try {
        const data = await metricsClient.getOrgDailyReport(org, day);
        for (const record of data) {
          upsertOrgDayMetrics(org, record);
        }
        result.orgs[org] = data.length;
        recordSync("org", org, day, data.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordSync("org", org, day, 0, "error", msg);
        console.error(`Failed to sync org ${org} data for ${day}:`, msg);
      }
    }
  })));

  return result;
}

// ── Backfill: fetch multiple days ─────────────────────────────────────

export async function backfill(
  days?: number,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number; errors: number }> {
  const numDays = days || BACKFILL_DAYS;
  const enterprise = getEnterprise();
  const orgs = getResolvedOrgs();
  const userMetricsEnabled = isCopilotSubEnabled("userMetrics");

  // Calculate date range: from (today - numDays) to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start = new Date(yesterday);
  start.setDate(start.getDate() - numDays + 1);

  const allDays = datesBetween(
    start.toISOString().split("T")[0],
    yesterday.toISOString().split("T")[0]
  );

  let daysSynced = 0;
  let daysSkipped = 0;
  let errors = 0;

  const dayLimit = pLimit(3);
  const dayPromises = allDays.map((day, i) => dayLimit(async () => {
    // Determine if this day is already fully synced
    const entSynced = enterprise ? isSynced("enterprise", enterprise, day) : true;
    const userSynced = !userMetricsEnabled || (enterprise
      ? isSynced("users", enterprise, day)
      : orgs.every((org) => isSynced("users", org, day)));
    const orgSynced = orgs.every((org) => isSynced("org", org, day));

    if (entSynced && userSynced && orgSynced) {
      daysSkipped++;
      return;
    }

    onProgress?.({
      phase: "backfill",
      day,
      current: i + 1,
      total: allDays.length,
      message: `Syncing day ${i + 1}/${allDays.length}: ${day}`,
    });

    try {
      await syncDay(day, onProgress);
      daysSynced++;
    } catch (err) {
      errors++;
      console.error(`Error syncing ${day}:`, err);
    }
  }));

  await Promise.all(dayPromises);

  return { daysSynced, daysSkipped, errors };
}

// ── Incremental sync: fill gaps since last sync ───────────────────────

export async function incrementalSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number }> {
  const enterprise = getEnterprise();
  const orgs = getResolvedOrgs();

  // Find the minimum latest sync day across all relevant scopes.
  // This ensures no org/scope falls behind.
  const latestDays: (string | null)[] = [];
  if (enterprise) {
    latestDays.push(getLatestSyncDay("enterprise", enterprise));
  }
  for (const org of orgs) {
    latestDays.push(getLatestSyncDay("org", org));
  }

  if (latestDays.length === 0) {
    console.warn("[Sync] No enterprise and no orgs configured — nothing to sync");
    return { daysSynced: 0, daysSkipped: 0 };
  }

  // Use the minimum (oldest) day so we catch up all scopes
  const nonNullDays = latestDays.filter((d): d is string => d !== null);
  const latestDay = nonNullDays.length > 0
    ? nonNullDays.reduce((min, d) => d < min ? d : min)
    : null;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  if (latestDay === yesterdayStr) {
    return { daysSynced: 0, daysSkipped: 0 };
  }

  // If no data at all, do full backfill
  if (!latestDay) {
    const result = await backfill(undefined, onProgress);
    return { daysSynced: result.daysSynced, daysSkipped: result.daysSkipped };
  }

  // Otherwise, sync from day after latest to yesterday
  const startDate = new Date(latestDay);
  startDate.setDate(startDate.getDate() + 1);
  const days = datesBetween(startDate.toISOString().split("T")[0], yesterdayStr);

  let daysSynced = 0;
  let daysSkipped = 0;

  for (let i = 0; i < days.length; i++) {
    // syncDay() internally checks isSynced per-scope and skips already-synced scopes
    onProgress?.({
      phase: "incremental",
      day: days[i],
      current: i + 1,
      total: days.length,
      message: `Incremental sync ${i + 1}/${days.length}: ${days[i]}`,
    });

    await syncDay(days[i], onProgress);
    daysSynced++;

    if (i < days.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { daysSynced, daysSkipped };
}

// ── Sync seats ────────────────────────────────────────────────────────

export async function syncSeats(): Promise<number> {
  if (!isCopilotSubEnabled("seats")) {
    console.log("[Sync] Seats sync disabled by config");
    return 0;
  }

  const orgs = getResolvedOrgs();
  let total = 0;

  for (const org of orgs) {
    try {
      const { seats } = await seatsClient.getOrgSeats(org);
      upsertSeats(org, seats);
      total += seats.length;
      recordSync("seats", org, null, seats.length);
    } catch (err) {
      console.error(`Failed to sync seats for ${org}:`, err);
    }
  }

  return total;
}

// ── Sync teams ────────────────────────────────────────────────────────

export async function syncTeams(): Promise<number> {
  if (!isCopilotSubEnabled("teams")) {
    console.log("[Sync] Teams sync disabled by config");
    return 0;
  }

  const enterprise = getEnterprise();
  const orgs = getResolvedOrgs();
  let total = 0;

  // Enterprise teams (only when enterprise mode is on)
  if (enterprise) {
    try {
      const entTeams = await teamsClient.getEnterpriseTeamsWithMembers(enterprise);
      upsertAllTeams(entTeams);
      total += entTeams.length;
      recordSync("teams", enterprise, null, entTeams.length);
    } catch (err) {
      console.error("Failed to sync enterprise teams:", err);
    }
  }

  // Org teams
  for (const org of orgs) {
    try {
      const orgTeams = await teamsClient.getOrgTeamsWithMembers(org);
      upsertAllTeams(orgTeams);
      total += orgTeams.length;
      recordSync("teams", org, null, orgTeams.length);
    } catch (err) {
      console.error(`Failed to sync teams for ${org}:`, err);
    }
  }

  return total;
}

// ── Full sync: backfill + seats + teams ───────────────────────────────

export async function fullSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<{
  backfill: { daysSynced: number; daysSkipped: number; errors: number };
  seats: number;
  teams: number;
}> {
  onProgress?.({ phase: "teams", current: 0, total: 1, message: "Syncing team memberships..." });
  const teams = await syncTeams();
  heartbeatSyncLock();

  onProgress?.({ phase: "seats", current: 0, total: 1, message: "Syncing seat data..." });
  const seats = await syncSeats();
  heartbeatSyncLock();

  onProgress?.({ phase: "backfill", current: 0, total: 1, message: "Starting metrics backfill..." });
  const bf = await backfill(undefined, onProgress);
  heartbeatSyncLock();

  // Try 28-day reports as fallback when per-day enterprise/org data is empty
  await sync28DayFallback(onProgress);

  // Refresh pre-aggregated summary tables
  onProgress?.({ phase: "summaries", current: 0, total: 1, message: "Refreshing summary tables..." });
  const BACKFILL_RANGE = parseInt(process.env.BACKFILL_DAYS || "90", 10);
  const summaryEnd = new Date();
  summaryEnd.setDate(summaryEnd.getDate() - 1);
  const summaryStart = new Date(summaryEnd);
  summaryStart.setDate(summaryStart.getDate() - BACKFILL_RANGE + 1);
  try {
    refreshAllSummaries(
      summaryStart.toISOString().split("T")[0],
      summaryEnd.toISOString().split("T")[0],
    );
  } catch (err) {
    console.error("[Sync] Failed to refresh summary tables:", err);
  }

  // Sync billing reports (only available in enterprise mode)
  onProgress?.({ phase: "billing", current: 0, total: 1, message: "Syncing billing reports..." });
  try {
    await syncBilling((p) => {
      onProgress?.({ phase: "billing", current: p.current, total: p.total, message: p.message });
    });
  } catch (err) {
    console.error("[Sync] Billing sync failed:", err);
  }

  // Invalidate in-memory cache so fresh data is served
  cache.invalidateAll();

  return { backfill: bf, seats, teams };
}

// ── 28-day fallback: fill enterprise/org gaps ─────────────────────────
// The enterprise-28-day and org-28-day endpoints may return data when
// the per-day endpoints return empty results. This runs once per sync
// pass and upserts any days returned.

async function sync28DayFallback(
  onProgress?: (progress: SyncProgress) => void
): Promise<void> {
  const enterprise = getEnterprise();
  const orgs = getResolvedOrgs();

  // Only run if enterprise_daily_metrics is still empty for the last 28 days
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start28 = new Date(yesterday);
  start28.setDate(start28.getDate() - 27);
  const startStr = start28.toISOString().split("T")[0];
  const endStr = yesterday.toISOString().split("T")[0];

  // Enterprise 28-day fallback (only when enterprise mode is on)
  if (enterprise && !hasEnterpriseDataForRange(enterprise, startStr, endStr)) {
    onProgress?.({ phase: "fallback", current: 0, total: 1, message: "Trying enterprise 28-day report as fallback..." });
    try {
      const data = await metricsClient.getEnterprise28DayReport(enterprise);
      if (data.length > 0) {
        console.log(`[Sync] 28-day enterprise fallback: ${data.length} day-totals received`);
        for (const record of data) {
          upsertEnterpriseDayMetrics(record);
          recordSync("enterprise", enterprise, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error("[Sync] 28-day enterprise fallback failed:", err);
    }
  }

  // Org 28-day fallback — only for orgs without existing data
  for (const org of orgs) {
    if (hasOrgDataForRange(org, startStr, endStr)) {
      continue; // Already have org data, skip fallback
    }
    onProgress?.({ phase: "fallback", current: 0, total: orgs.length, message: `Trying org ${org} 28-day report as fallback...` });
    try {
      const data = await metricsClient.getOrg28DayReport(org);
      if (data.length > 0) {
        console.log(`[Sync] 28-day org fallback for ${org}: ${data.length} day-totals received`);
        for (const record of data) {
          upsertOrgDayMetrics(org, record);
          recordSync("org", org, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error(`[Sync] 28-day org fallback failed for ${org}:`, err);
    }
  }
}
