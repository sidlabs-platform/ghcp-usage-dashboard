// Data Sync Service — fetches data day-by-day using enterprise-1-day endpoint
// Supports 90+ day backfill by looping through each day individually

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

const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || "90", 10);

function getEnterprise(): string {
  const ent = process.env.GITHUB_ENTERPRISE;
  if (!ent) throw new Error("GITHUB_ENTERPRISE environment variable is required");
  return ent;
}

function getOrgs(): string[] {
  const orgs = process.env.GITHUB_ORGS;
  if (!orgs) return [];
  return orgs.split(",").map((o) => o.trim()).filter(Boolean);
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
  const orgs = getOrgs();
  const result = { enterprise: 0, users: 0, orgs: {} as Record<string, number> };

  // 1. Enterprise aggregate
  if (!isSynced("enterprise", enterprise, day)) {
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

  // 2. Enterprise user-level
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
    if (isSynced("enterprise", enterprise, day) && isSynced("users", enterprise, day)) {
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
  const latestDay = getLatestSyncDay("enterprise", enterprise);

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
  const start = new Date(latestDay);
  start.setDate(start.getDate() + 1);
  const days = datesBetween(start.toISOString().split("T")[0], yesterdayStr);

  let daysSynced = 0;
  let daysSkipped = 0;

  for (let i = 0; i < days.length; i++) {
    if (isSynced("enterprise", enterprise, days[i])) {
      daysSkipped++;
      continue;
    }

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
  const orgs = getOrgs();
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
  const enterprise = getEnterprise();
  const orgs = getOrgs();
  let total = 0;

  // Enterprise teams
  try {
    const entTeams = await teamsClient.getEnterpriseTeamsWithMembers(enterprise);
    upsertAllTeams(entTeams);
    total += entTeams.length;
    recordSync("teams", enterprise, null, entTeams.length);
  } catch (err) {
    console.error("Failed to sync enterprise teams:", err);
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

  // Sync billing reports (if enabled)
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
  const orgs = getOrgs();

  // Only run if enterprise_daily_metrics is still empty for the last 28 days
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start28 = new Date(yesterday);
  start28.setDate(start28.getDate() - 27);
  const startStr = start28.toISOString().split("T")[0];
  const endStr = yesterday.toISOString().split("T")[0];

  if (hasEnterpriseDataForRange(enterprise, startStr, endStr)) {
    return; // Already have enterprise data, no fallback needed
  }

  // Enterprise 28-day fallback
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
