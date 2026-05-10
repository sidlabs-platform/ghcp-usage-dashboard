// Data Sync Service — fetches data day-by-day using enterprise-1-day or org-1-day endpoints
// Supports 90+ day backfill by looping through each day individually
// Respects dashboard-config.json for enterprise/userMetrics/seats/teams toggles
// Loops over all configured enterprises for multi-enterprise support

import { metricsClient } from "@/lib/github/metrics-client";
import { seatsClient } from "@/lib/github/seats-client";
import { teamsClient } from "@/lib/github/teams-client";
import pLimit from "p-limit";
import {
  upsertEnterpriseDayMetrics,
  upsertOrgDayMetrics,
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
} from "@/lib/config/dashboard-config";
import { getConfiguredEnterprises, getResolvedOrgsForEnterprise } from "@/lib/config/enterprise-config";
import { getEnterpriseContext, updateEnterpriseRegistry } from "./enterprise-context";

const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || "90", 10) || 90;

export interface SyncProgress {
  phase: string;
  day?: string;
  current: number;
  total: number;
  message: string;
  enterpriseSlug?: string;
}

export interface EnterpriseSyncResult {
  enterpriseSlug: string;
  backfill: { daysSynced: number; daysSkipped: number; errors: number };
  seats: number;
  teams: number;
}

export interface MultiEnterpriseSyncResult {
  backfill: { daysSynced: number; daysSkipped: number; errors: number };
  seats: number;
  teams: number;
  enterprises: EnterpriseSyncResult[];
}

// ── Sync a single day ─────────────────────────────────────────────────

export async function syncDay(
  enterpriseSlug: string,
  day: string,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ enterprise: number; users: number; orgs: Record<string, number> }> {
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
  const userMetricsEnabled = isCopilotSubEnabled("userMetrics");
  const result = { enterprise: 0, users: 0, orgs: {} as Record<string, number> };

  // 1. Enterprise aggregate (skipped when enterprise is disabled)
  if (isEnterpriseEnabled() && !isSynced(enterpriseSlug, "enterprise", enterpriseSlug, day)) {
    onProgress?.({ phase: "enterprise", day, current: 0, total: 1, message: `[${enterpriseSlug}] Fetching enterprise metrics for ${day}`, enterpriseSlug });
    try {
      const data = await metricsClient.getEnterpriseDailyReport(enterpriseSlug, day, enterpriseSlug);
      for (const record of data) {
        upsertEnterpriseDayMetrics(enterpriseSlug, record);
      }
      result.enterprise = data.length;
      recordSync(enterpriseSlug, "enterprise", enterpriseSlug, day, data.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordSync(enterpriseSlug, "enterprise", enterpriseSlug, day, 0, "error", msg);
      console.error("[%s] Failed to sync enterprise data for %s: %s", enterpriseSlug.replace(/\n|\r/g, ""), day, msg.replace(/\n|\r/g, ""));
    }
  }

  // 2. User-level metrics (skipped when userMetrics is disabled)
  if (userMetricsEnabled) {
    if (isEnterpriseEnabled()) {
      // Enterprise mode: fetch user data at enterprise scope
      if (!isSynced(enterpriseSlug, "users", enterpriseSlug, day)) {
        onProgress?.({ phase: "users", day, current: 0, total: 1, message: `[${enterpriseSlug}] Fetching user metrics for ${day}`, enterpriseSlug });
        try {
          const users = await metricsClient.getEnterpriseUserDailyReport(enterpriseSlug, day, enterpriseSlug);
          batchUpsertUserDayMetrics(enterpriseSlug, users);
          result.users = users.length;
          recordSync(enterpriseSlug, "users", enterpriseSlug, day, users.length);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordSync(enterpriseSlug, "users", enterpriseSlug, day, 0, "error", msg);
          console.error("[%s] Failed to sync user data for %s: %s", enterpriseSlug.replace(/\n|\r/g, ""), day, msg.replace(/\n|\r/g, ""));
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
        if (!isSynced(enterpriseSlug, "users", org, day)) {
          onProgress?.({ phase: "users", day, current: 0, total: orgs.length, message: `[${enterpriseSlug}] Fetching user metrics for org ${org} on ${day}`, enterpriseSlug });
          try {
            const users = await metricsClient.getOrgUserDailyReport(org, day, enterpriseSlug);
            batchUpsertUserDayMetrics(enterpriseSlug, users);
            result.users += users.length;
            recordSync(enterpriseSlug, "users", org, day, users.length);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            recordSync(enterpriseSlug, "users", org, day, 0, "error", msg);
            console.error("[%s] Failed to sync user data for org %s on %s: %s", enterpriseSlug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), day, msg.replace(/\n|\r/g, ""));
          }
        }
      })));
    }
  }

  // 3. Organization aggregates (parallel with concurrency limit)
  const orgLimit = pLimit(5);
  await Promise.all(orgs.map((org) => orgLimit(async () => {
    if (!isSynced(enterpriseSlug, "org", org, day)) {
      onProgress?.({ phase: "org", day, current: 0, total: orgs.length, message: `[${enterpriseSlug}] Fetching org ${org} metrics for ${day}`, enterpriseSlug });
      try {
        const data = await metricsClient.getOrgDailyReport(org, day, enterpriseSlug);
        for (const record of data) {
          upsertOrgDayMetrics(enterpriseSlug, org, record);
        }
        result.orgs[org] = data.length;
        recordSync(enterpriseSlug, "org", org, day, data.length);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordSync(enterpriseSlug, "org", org, day, 0, "error", msg);
        console.error("[%s] Failed to sync org %s data for %s: %s", enterpriseSlug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), day, msg.replace(/\n|\r/g, ""));
      }
    }
  })));

  return result;
}

// ── Backfill: fetch multiple days ─────────────────────────────────────

export async function backfillEnterprise(
  enterpriseSlug: string,
  days?: number,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number; errors: number }> {
  const numDays = days || BACKFILL_DAYS;
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
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
    const entSynced = isEnterpriseEnabled() ? isSynced(enterpriseSlug, "enterprise", enterpriseSlug, day) : true;
    const userSynced = !userMetricsEnabled || (isEnterpriseEnabled()
      ? isSynced(enterpriseSlug, "users", enterpriseSlug, day)
      : orgs.every((org) => isSynced(enterpriseSlug, "users", org, day)));
    const orgSynced = orgs.every((org) => isSynced(enterpriseSlug, "org", org, day));

    if (entSynced && userSynced && orgSynced) {
      daysSkipped++;
      return;
    }

    onProgress?.({
      phase: "backfill",
      day,
      current: i + 1,
      total: allDays.length,
      message: `[${enterpriseSlug}] Syncing day ${i + 1}/${allDays.length}: ${day}`,
      enterpriseSlug,
    });

    try {
      await syncDay(enterpriseSlug, day, onProgress);
      daysSynced++;
    } catch (err) {
      errors++;
      console.error("[%s] Error syncing %s:", enterpriseSlug.replace(/\n|\r/g, ""), day, err);
    }
  }));

  await Promise.all(dayPromises);

  return { daysSynced, daysSkipped, errors };
}

/** Backward-compatible wrapper: loops over all configured enterprises. */
export async function backfill(
  days?: number,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number; errors: number }> {
  const enterprises = getConfiguredEnterprises();
  let daysSynced = 0;
  let daysSkipped = 0;
  let errors = 0;

  for (const ent of enterprises) {
    const result = await backfillEnterprise(ent.slug, days, onProgress);
    daysSynced += result.daysSynced;
    daysSkipped += result.daysSkipped;
    errors += result.errors;
  }

  return { daysSynced, daysSkipped, errors };
}

// ── Incremental sync: fill gaps since last sync ───────────────────────

async function incrementalSyncEnterprise(
  enterpriseSlug: string,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number }> {
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);

  // Find the minimum latest sync day across all relevant scopes.
  // This ensures no org/scope falls behind.
  const latestDays: (string | null)[] = [];
  if (isEnterpriseEnabled()) {
    latestDays.push(getLatestSyncDay(enterpriseSlug, "enterprise", enterpriseSlug));
  }
  for (const org of orgs) {
    latestDays.push(getLatestSyncDay(enterpriseSlug, "org", org));
  }

  if (latestDays.length === 0) {
    console.warn("[Sync] [%s] No enterprise and no orgs configured — nothing to sync", enterpriseSlug.replace(/\n|\r/g, ""));
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

  // If no data at all, do full backfill for this enterprise
  if (!latestDay) {
    const result = await backfillEnterprise(enterpriseSlug, undefined, onProgress);
    return { daysSynced: result.daysSynced, daysSkipped: result.daysSkipped };
  }

  // Otherwise, sync from day after latest to yesterday
  const startDate = new Date(latestDay);
  startDate.setDate(startDate.getDate() + 1);
  const days = datesBetween(startDate.toISOString().split("T")[0], yesterdayStr);

  let daysSynced = 0;
  const daysSkipped = 0;

  for (let i = 0; i < days.length; i++) {
    // syncDay() internally checks isSynced per-scope and skips already-synced scopes
    onProgress?.({
      phase: "incremental",
      day: days[i],
      current: i + 1,
      total: days.length,
      message: `[${enterpriseSlug}] Incremental sync ${i + 1}/${days.length}: ${days[i]}`,
      enterpriseSlug,
    });

    await syncDay(enterpriseSlug, days[i], onProgress);
    daysSynced++;

    if (i < days.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { daysSynced, daysSkipped };
}

export async function incrementalSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number }> {
  const enterprises = getConfiguredEnterprises();
  let daysSynced = 0;
  let daysSkipped = 0;

  for (const ent of enterprises) {
    const result = await incrementalSyncEnterprise(ent.slug, onProgress);
    daysSynced += result.daysSynced;
    daysSkipped += result.daysSkipped;
  }

  return { daysSynced, daysSkipped };
}

// ── Sync seats (per-enterprise helper) ────────────────────────────────

async function syncSeatsForEnterprise(slug: string): Promise<number> {
  const orgs = getResolvedOrgsForEnterprise(slug);
  let total = 0;

  for (const org of orgs) {
    try {
      const { seats } = await seatsClient.getOrgSeats(org, slug);
      upsertSeats(slug, org, seats);
      total += seats.length;
      recordSync(slug, "seats", org, null, seats.length);
    } catch (err) {
      console.error("[%s] Failed to sync seats for %s:", slug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), err);
    }
  }

  return total;
}

export async function syncSeats(): Promise<number> {
  if (!isCopilotSubEnabled("seats")) {
    console.log("[Sync] Seats sync disabled by config");
    return 0;
  }

  const enterprises = getConfiguredEnterprises();
  let total = 0;

  for (const ent of enterprises) {
    total += await syncSeatsForEnterprise(ent.slug);
  }

  return total;
}

// ── Sync teams (per-enterprise helper) ────────────────────────────────

async function syncTeamsForEnterprise(slug: string): Promise<number> {
  const orgs = getResolvedOrgsForEnterprise(slug);
  let total = 0;

  // Enterprise teams (only when enterprise mode is on)
  if (isEnterpriseEnabled()) {
    try {
      const entTeams = await teamsClient.getEnterpriseTeamsWithMembers(slug, slug);
      upsertAllTeams(slug, entTeams);
      total += entTeams.length;
      recordSync(slug, "teams", slug, null, entTeams.length);
    } catch (err) {
      console.error("[%s] Failed to sync enterprise teams:", slug.replace(/\n|\r/g, ""), err);
    }
  }

  // Org teams
  for (const org of orgs) {
    try {
      const orgTeams = await teamsClient.getOrgTeamsWithMembers(org, slug);
      upsertAllTeams(slug, orgTeams);
      total += orgTeams.length;
      recordSync(slug, "teams", org, null, orgTeams.length);
    } catch (err) {
      console.error("[%s] Failed to sync teams for %s:", slug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), err);
    }
  }

  return total;
}

export async function syncTeams(): Promise<number> {
  if (!isCopilotSubEnabled("teams")) {
    console.log("[Sync] Teams sync disabled by config");
    return 0;
  }

  const enterprises = getConfiguredEnterprises();
  let total = 0;

  for (const ent of enterprises) {
    total += await syncTeamsForEnterprise(ent.slug);
  }

  return total;
}

// ── Full sync: backfill + seats + teams (per-enterprise loop) ─────────

export async function fullSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<MultiEnterpriseSyncResult> {
  const enterprises = getConfiguredEnterprises();

  if (enterprises.length === 0) {
    console.warn("[Sync] No enterprises configured — nothing to sync");
    return {
      backfill: { daysSynced: 0, daysSkipped: 0, errors: 0 },
      seats: 0,
      teams: 0,
      enterprises: [],
    };
  }

  const enterpriseResults: EnterpriseSyncResult[] = [];

  for (const entConfig of enterprises) {
    const slug = entConfig.slug;

    // Validate config + auth for this enterprise
    void getEnterpriseContext(slug);
    updateEnterpriseRegistry(slug, slug, entConfig.displayName);

    // Teams
    let entTeams = 0;
    if (isCopilotSubEnabled("teams")) {
      onProgress?.({ phase: "teams", current: 0, total: 1, message: `[${slug}] Syncing team memberships...`, enterpriseSlug: slug });
      entTeams = await syncTeamsForEnterprise(slug);
    }
    heartbeatSyncLock();

    // Seats
    let entSeats = 0;
    if (isCopilotSubEnabled("seats")) {
      onProgress?.({ phase: "seats", current: 0, total: 1, message: `[${slug}] Syncing seat data...`, enterpriseSlug: slug });
      entSeats = await syncSeatsForEnterprise(slug);
    }
    heartbeatSyncLock();

    // Backfill
    onProgress?.({ phase: "backfill", current: 0, total: 1, message: `[${slug}] Starting metrics backfill...`, enterpriseSlug: slug });
    const bf = await backfillEnterprise(slug, undefined, onProgress);
    heartbeatSyncLock();

    // Try 28-day reports as fallback when per-day enterprise/org data is empty
    await sync28DayFallback(slug, onProgress);

    // Sync billing reports
    onProgress?.({ phase: "billing", current: 0, total: 1, message: `[${slug}] Syncing billing reports...`, enterpriseSlug: slug });
    try {
      await syncBilling(slug, (p) => {
        onProgress?.({ phase: "billing", current: p.current, total: p.total, message: p.message, enterpriseSlug: slug });
      });
    } catch (err) {
      console.error("[Sync] [%s] Billing sync failed:", slug.replace(/\n|\r/g, ""), err);
    }

    enterpriseResults.push({
      enterpriseSlug: slug,
      backfill: bf,
      seats: entSeats,
      teams: entTeams,
    });
  }

  // Refresh pre-aggregated summary tables ONCE after all enterprises
  onProgress?.({ phase: "summaries", current: 0, total: 1, message: "Refreshing summary tables..." });
  const BACKFILL_RANGE = parseInt(process.env.BACKFILL_DAYS || "90", 10) || 90;
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

  // Invalidate in-memory cache so fresh data is served
  cache.invalidateAll();

  // Aggregate results across all enterprises
  return {
    backfill: {
      daysSynced: enterpriseResults.reduce((sum, r) => sum + r.backfill.daysSynced, 0),
      daysSkipped: enterpriseResults.reduce((sum, r) => sum + r.backfill.daysSkipped, 0),
      errors: enterpriseResults.reduce((sum, r) => sum + r.backfill.errors, 0),
    },
    seats: enterpriseResults.reduce((sum, r) => sum + r.seats, 0),
    teams: enterpriseResults.reduce((sum, r) => sum + r.teams, 0),
    enterprises: enterpriseResults,
  };
}

// ── 28-day fallback: fill enterprise/org gaps ─────────────────────────
// The enterprise-28-day and org-28-day endpoints may return data when
// the per-day endpoints return empty results. This runs once per sync
// pass and upserts any days returned.

async function sync28DayFallback(
  enterpriseSlug: string,
  onProgress?: (progress: SyncProgress) => void
): Promise<void> {
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);

  // Only run if enterprise_daily_metrics is still empty for the last 28 days
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start28 = new Date(yesterday);
  start28.setDate(start28.getDate() - 27);
  const startStr = start28.toISOString().split("T")[0];
  const endStr = yesterday.toISOString().split("T")[0];

  // Enterprise 28-day fallback (only when enterprise mode is on)
  if (isEnterpriseEnabled() && !hasEnterpriseDataForRange(enterpriseSlug, startStr, endStr, [enterpriseSlug])) {
    onProgress?.({ phase: "fallback", current: 0, total: 1, message: `[${enterpriseSlug}] Trying enterprise 28-day report as fallback...`, enterpriseSlug });
    try {
      const data = await metricsClient.getEnterprise28DayReport(enterpriseSlug, enterpriseSlug);
      if (data.length > 0) {
        console.log("[Sync] [%s] 28-day enterprise fallback: %d day-totals received", enterpriseSlug.replace(/\n|\r/g, ""), data.length);
        for (const record of data) {
          upsertEnterpriseDayMetrics(enterpriseSlug, record);
          recordSync(enterpriseSlug, "enterprise", enterpriseSlug, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error("[Sync] [%s] 28-day enterprise fallback failed:", enterpriseSlug.replace(/\n|\r/g, ""), err);
    }
  }

  // Org 28-day fallback — only for orgs without existing data
  for (const org of orgs) {
    if (hasOrgDataForRange(org, startStr, endStr, [enterpriseSlug])) {
      continue; // Already have org data, skip fallback
    }
    onProgress?.({ phase: "fallback", current: 0, total: orgs.length, message: `[${enterpriseSlug}] Trying org ${org} 28-day report as fallback...`, enterpriseSlug });
    try {
      const data = await metricsClient.getOrg28DayReport(org, enterpriseSlug);
      if (data.length > 0) {
        console.log("[Sync] [%s] 28-day org fallback for %s: %d day-totals received", enterpriseSlug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), data.length);
        for (const record of data) {
          upsertOrgDayMetrics(enterpriseSlug, org, record);
          recordSync(enterpriseSlug, "org", org, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error("[Sync] [%s] 28-day org fallback failed for %s:", enterpriseSlug.replace(/\n|\r/g, ""), org.replace(/\n|\r/g, ""), err);
    }
  }
}
