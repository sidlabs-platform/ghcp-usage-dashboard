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
  invalidateEnterpriseCountCache,
} from "./metrics-repo";
import { replaceEnterpriseSeats, upsertSeats } from "./seats-repo";
import { refreshAllSummaries } from "./summary-tables";
import { cache } from "@/lib/cache/memory-cache";
import { upsertAllTeams } from "./teams-repo";
import { batchUpsertUserTeams } from "./user-teams-repo";
import { datesBetween } from "@/lib/utils";
import { syncBilling } from "./billing-sync-service";
import {
  syncLicenseHistoryForEnterprise,
  createDefaultLicenseHistorySyncDeps,
  type LicenseHistoryEnterpriseSyncResult,
  type LicenseHistorySyncDeps,
  type LicenseHistorySyncProgress,
} from "./license-history-sync-service";
import {
  getConfiguredEnterprises, getResolvedOrgsForEnterprise, getEnterpriseConfig,
  isCopilotSubEnabledForEnterprise, isCopilotSubEnabledForAnyEnterprise,
} from "@/lib/config/enterprise-config";
import { getEnterpriseContext, updateEnterpriseRegistry } from "./enterprise-context";
import { orgsClient } from "@/lib/github/orgs-client";
import { upsertEnterpriseOrgs, clearEnterpriseOrgs } from "./orgs-repo";
import type { UserTeamRecord } from "@/lib/types/metrics";
import type { CopilotSeat } from "@/lib/types/seats";

const BACKFILL_DAYS = parseInt(process.env.BACKFILL_DAYS || "90", 10) || 90;

/** Track which enterprises have the user-teams API unavailable during this sync run */
const userTeamsUnavailable = new Set<string>();
const enterpriseSeatsSnapshotCache = new Map<string, { totalSeats: number; seats: CopilotSeat[] }>();

/** Strip newlines/carriage returns from a string before logging to prevent log injection. */
function sanitizeForLog(s: string): string {
  return s.replace(/\n|\r/g, "");
}

async function getEnterpriseSeatsSnapshot(enterpriseSlug: string): Promise<{ totalSeats: number; seats: CopilotSeat[] }> {
  const cached = enterpriseSeatsSnapshotCache.get(enterpriseSlug);
  if (cached) return cached;
  const snapshot = await seatsClient.getEnterpriseSeats(enterpriseSlug, enterpriseSlug);
  enterpriseSeatsSnapshotCache.set(enterpriseSlug, snapshot);
  return snapshot;
}

function getSeatOrganizationLogin(seat: CopilotSeat): string | null {
  const login = seat.organization?.login?.trim();
  return login || null;
}

function groupSeatsByOrganization(seats: CopilotSeat[]): { seatsByOrg: Map<string, CopilotSeat[]>; skipped: number } {
  const seatsByOrg = new Map<string, CopilotSeat[]>();
  let skipped = 0;
  for (const seat of seats) {
    const org = getSeatOrganizationLogin(seat);
    if (!org) {
      skipped++;
      continue;
    }
    const existing = seatsByOrg.get(org);
    if (existing) {
      existing.push(seat);
    } else {
      seatsByOrg.set(org, [seat]);
    }
  }
  return { seatsByOrg, skipped };
}

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
  /** Additive — historical license reconciliation sync result for this enterprise. Absent when licensing history is disabled/not configured. */
  licensing?: LicenseHistoryEnterpriseSyncResult;
}

export interface MultiEnterpriseSyncResult {
  backfill: { daysSynced: number; daysSkipped: number; errors: number };
  seats: number;
  teams: number;
  enterprises: EnterpriseSyncResult[];
  /** Additive summary — never replaces or mutates any existing field above. */
  licensing: { enabled: boolean; enterprises: LicenseHistoryEnterpriseSyncResult[] };
}

// ── Org auto-discovery ────────────────────────────────────────────────

/**
 * When an enterprise has no explicit `organizations.include` list,
 * fetch all orgs from the GitHub API and cache them in enterprise_orgs.
 * If include is non-empty, persist those as `configured` for consistency.
 * Returns the number of orgs discovered/persisted.
 */
async function discoverOrgsIfNeeded(
  enterpriseSlug: string,
  onProgress?: (progress: SyncProgress) => void,
): Promise<number> {
  const config = getEnterpriseConfig(enterpriseSlug);
  const include = config.organizations?.include ?? [];

  if (include.length > 0) {
    // Explicit org list — clear any stale discovered orgs and persist as 'configured'
    clearEnterpriseOrgs(enterpriseSlug);
    upsertEnterpriseOrgs(enterpriseSlug, include, "configured");
    return include.length;
  }

  // Skip auto-discovery when enterprise mode is disabled (org-only mode)
  if (!isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")) {
    console.warn(
      "[Sync] [%s] Org auto-discovery skipped (enterprise mode disabled). " +
      "Configure organizations.include in dashboard-config.json or set GITHUB_ORGS.",
      sanitizeForLog(enterpriseSlug),
    );
    return 0;
  }

  // Auto-discover from enterprise API
  onProgress?.({
    phase: "org-discovery",
    current: 0,
    total: 1,
    message: `[${sanitizeForLog(enterpriseSlug)}] Discovering organizations from enterprise API...`,
    enterpriseSlug,
  });

  try {
    const apiOrgs = await orgsClient.listEnterpriseOrgs(enterpriseSlug, enterpriseSlug);
    const orgSlugs = apiOrgs.map((o) => o.login);

    // Replace the full cached org set with the latest discovery result
    clearEnterpriseOrgs(enterpriseSlug);
    if (orgSlugs.length > 0) {
      upsertEnterpriseOrgs(enterpriseSlug, orgSlugs, "discovered");
    }

    console.log(
      "[Sync] [%s] Auto-discovered %d organization(s) from enterprise API",
      sanitizeForLog(enterpriseSlug),
      orgSlugs.length,
    );
    return orgSlugs.length;
  } catch (err) {
    const orgApiMessage = err instanceof Error ? err.message : String(err);
    try {
      const { seats } = await getEnterpriseSeatsSnapshot(enterpriseSlug);
      const { seatsByOrg, skipped } = groupSeatsByOrganization(seats);
      const orgSlugs = Array.from(seatsByOrg.keys()).sort();
      if (orgSlugs.length > 0) {
        clearEnterpriseOrgs(enterpriseSlug);
        upsertEnterpriseOrgs(enterpriseSlug, orgSlugs, "discovered");
        console.log(
          "[Sync] [%s] Auto-discovered %d organization(s) from enterprise seats fallback; orgs with zero Copilot seats are not visible via this fallback",
          sanitizeForLog(enterpriseSlug),
          orgSlugs.length,
        );
        if (skipped > 0) {
          console.warn(
            "[Sync] [%s] Skipped %d enterprise seat(s) without organization metadata during org discovery",
            sanitizeForLog(enterpriseSlug),
            skipped,
          );
        }
        return orgSlugs.length;
      }
      console.warn(
        "[Sync] [%s] Org auto-discovery failed and enterprise seats fallback found no organizations (continuing with cached orgs): %s",
        sanitizeForLog(enterpriseSlug),
        sanitizeForLog(orgApiMessage),
      );
    } catch (seatErr) {
      console.warn(
        "[Sync] [%s] Org auto-discovery failed (continuing with cached orgs): %s; enterprise seats fallback also failed: %s",
        sanitizeForLog(enterpriseSlug),
        sanitizeForLog(orgApiMessage),
        sanitizeForLog(seatErr instanceof Error ? seatErr.message : String(seatErr)),
      );
    }
    return 0;
  }
}

// ── Sync a single day ─────────────────────────────────────────────────

export async function syncDay(
  enterpriseSlug: string,
  day: string,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ enterprise: number; users: number; orgs: Record<string, number> }> {
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
  const userMetricsEnabled = isCopilotSubEnabledForEnterprise(enterpriseSlug, "userMetrics");
  const result = { enterprise: 0, users: 0, orgs: {} as Record<string, number> };

  // 1. Enterprise aggregate (skipped when enterprise is disabled)
  if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise") && !isSynced(enterpriseSlug, "enterprise", enterpriseSlug, day)) {
    onProgress?.({ phase: "enterprise", day, current: 0, total: 1, message: `[${sanitizeForLog(enterpriseSlug)}] Fetching enterprise metrics for ${day}`, enterpriseSlug });
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
      console.error("[%s] Failed to sync enterprise data for %s: %s", sanitizeForLog(enterpriseSlug), day, sanitizeForLog(msg));
    }
  }

  // 2. User-level metrics (skipped when userMetrics is disabled)
  if (userMetricsEnabled) {
    if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")) {
      if (!isSynced(enterpriseSlug, "users", enterpriseSlug, day)) {
        onProgress?.({ phase: "users", day, current: 0, total: 1, message: `[${sanitizeForLog(enterpriseSlug)}] Fetching user metrics for ${day}`, enterpriseSlug });
        try {
          const users = await metricsClient.getEnterpriseUserDailyReport(enterpriseSlug, day, enterpriseSlug);
          batchUpsertUserDayMetrics(enterpriseSlug, users);
          result.users = users.length;
          recordSync(enterpriseSlug, "users", enterpriseSlug, day, users.length);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recordSync(enterpriseSlug, "users", enterpriseSlug, day, 0, "error", msg);
          console.error("[%s] Failed to sync user data for %s: %s", sanitizeForLog(enterpriseSlug), day, sanitizeForLog(msg));
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
          onProgress?.({ phase: "users", day, current: 0, total: orgs.length, message: `[${sanitizeForLog(enterpriseSlug)}] Fetching user metrics for org ${sanitizeForLog(org)} on ${day}`, enterpriseSlug });
          try {
            const users = await metricsClient.getOrgUserDailyReport(org, day, enterpriseSlug);
            batchUpsertUserDayMetrics(enterpriseSlug, users);
            result.users += users.length;
            recordSync(enterpriseSlug, "users", org, day, users.length);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            recordSync(enterpriseSlug, "users", org, day, 0, "error", msg);
            console.error("[%s] Failed to sync user data for org %s on %s: %s", sanitizeForLog(enterpriseSlug), sanitizeForLog(org), day, sanitizeForLog(msg));
          }
        }
      })));
    }
  }

  // 3. Organization aggregates (parallel with concurrency limit)
  const orgLimit = pLimit(5);
  await Promise.all(orgs.map((org) => orgLimit(async () => {
    if (!isSynced(enterpriseSlug, "org", org, day)) {
      onProgress?.({ phase: "org", day, current: 0, total: orgs.length, message: `[${sanitizeForLog(enterpriseSlug)}] Fetching org ${sanitizeForLog(org)} metrics for ${day}`, enterpriseSlug });
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
        console.error("[%s] Failed to sync org %s data for %s: %s", sanitizeForLog(enterpriseSlug), sanitizeForLog(org), day, sanitizeForLog(msg));
      }
    }
  })));

  // 4. User-teams attribution (non-blocking, separate sync scope)
  if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "teams")) {
    try {
      await syncUserTeamsForDay(enterpriseSlug, day);
    } catch (err) {
      console.error("[%s] Failed to sync user-teams for %s:", sanitizeForLog(enterpriseSlug), day, err);
    }
  }

  return result;
}

/** Sync user-teams attribution for a single day */
async function syncUserTeamsForDay(
  enterpriseSlug: string,
  day: string,
): Promise<number> {
  if (userTeamsUnavailable.has(enterpriseSlug)) return 0;
  if (isSynced(enterpriseSlug, "user-teams", enterpriseSlug, day)) return 0;

  const records: UserTeamRecord[] = [];

  try {
    if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")) {
      records.push(...await metricsClient.getEnterpriseUserTeamsReport(enterpriseSlug, day, enterpriseSlug));
    } else {
      const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
      let hasAvailableResponse = false;
      let sawUnavailableResponse = false;
      let hardErrorMsg: string | null = null;

      for (const org of orgs) {
        try {
          const orgRecords = await metricsClient.getOrgUserTeamsReport(org, day, enterpriseSlug);
          records.push(...orgRecords);
          hasAvailableResponse = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404") || msg.includes("403")) {
            sawUnavailableResponse = true;
            console.warn("[%s] user-teams API not available for org %s, skipping", sanitizeForLog(enterpriseSlug), sanitizeForLog(org));
          } else {
            hardErrorMsg = msg;
            console.error("[%s] Failed to fetch user-teams for org %s on %s: %s", sanitizeForLog(enterpriseSlug), sanitizeForLog(org), day, sanitizeForLog(msg));
          }
        }
      }

      if (!hasAvailableResponse && sawUnavailableResponse) {
        console.warn("[%s] user-teams API not available, skipping for remainder of sync", sanitizeForLog(enterpriseSlug));
        userTeamsUnavailable.add(enterpriseSlug);
        recordSync(enterpriseSlug, "user-teams", enterpriseSlug, day, 0, "skipped", "API unavailable (404/403)");
        return 0;
      }

      if (hardErrorMsg && !hasAvailableResponse) {
        recordSync(enterpriseSlug, "user-teams", enterpriseSlug, day, 0, "error", hardErrorMsg);
        return 0;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.includes("403")) {
      console.warn("[%s] user-teams API not available, skipping for remainder of sync", sanitizeForLog(enterpriseSlug));
      userTeamsUnavailable.add(enterpriseSlug);
      recordSync(enterpriseSlug, "user-teams", enterpriseSlug, day, 0, "skipped", "API unavailable (404/403)");
      return 0;
    }
    recordSync(enterpriseSlug, "user-teams", enterpriseSlug, day, 0, "error", msg);
    return 0;
  }

  if (records.length > 0) {
    batchUpsertUserTeams(enterpriseSlug, day, records);
  }
  recordSync(enterpriseSlug, "user-teams", enterpriseSlug, day, records.length);
  return records.length;
}

// ── Backfill: fetch multiple days ─────────────────────────────────────

export async function backfillEnterprise(
  enterpriseSlug: string,
  days?: number,
  onProgress?: (progress: SyncProgress) => void
): Promise<{ daysSynced: number; daysSkipped: number; errors: number }> {
  // Clear per-run unavailability cache so transient 404s don't persist across calls
  userTeamsUnavailable.delete(enterpriseSlug);

  const numDays = days || BACKFILL_DAYS;
  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);
  const userMetricsEnabled = isCopilotSubEnabledForEnterprise(enterpriseSlug, "userMetrics");

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
    const entSynced = isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise") ? isSynced(enterpriseSlug, "enterprise", enterpriseSlug, day) : true;
    const userSynced = !userMetricsEnabled || (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")
      ? isSynced(enterpriseSlug, "users", enterpriseSlug, day)
      : orgs.every((org) => isSynced(enterpriseSlug, "users", org, day)));
    const orgSynced = orgs.every((org) => isSynced(enterpriseSlug, "org", org, day));
    const userTeamsSynced = !isCopilotSubEnabledForEnterprise(enterpriseSlug, "teams")
      || isSynced(enterpriseSlug, "user-teams", enterpriseSlug, day)
      || userTeamsUnavailable.has(enterpriseSlug);

    if (entSynced && userSynced && orgSynced && userTeamsSynced) {
      daysSkipped++;
      return;
    }

    onProgress?.({
      phase: "backfill",
      day,
      current: i + 1,
      total: allDays.length,
      message: `[${sanitizeForLog(enterpriseSlug)}] Syncing day ${i + 1}/${allDays.length}: ${day}`,
      enterpriseSlug,
    });

    try {
      await syncDay(enterpriseSlug, day, onProgress);
      daysSynced++;
    } catch (err) {
      errors++;
      console.error("[%s] Error syncing %s:", sanitizeForLog(enterpriseSlug), day, err);
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
  // Refresh org list (auto-discovers when include is empty)
  await discoverOrgsIfNeeded(enterpriseSlug, onProgress);

  const orgs = getResolvedOrgsForEnterprise(enterpriseSlug);

  // Find the minimum latest sync day across all relevant scopes.
  // This ensures no org/scope falls behind.
  const latestDays: (string | null)[] = [];
  if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise")) {
    latestDays.push(getLatestSyncDay(enterpriseSlug, "enterprise", enterpriseSlug));
  }
  for (const org of orgs) {
    latestDays.push(getLatestSyncDay(enterpriseSlug, "org", org));
  }

  if (latestDays.length === 0) {
    console.warn("[Sync] [%s] No enterprise and no orgs configured — nothing to sync", sanitizeForLog(enterpriseSlug));
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
      message: `[${sanitizeForLog(enterpriseSlug)}] Incremental sync ${i + 1}/${days.length}: ${days[i]}`,
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
): Promise<{ daysSynced: number; daysSkipped: number; errors: number; failedEnterprises: string[] }> {
  const enterprises = getConfiguredEnterprises();
  userTeamsUnavailable.clear();
  let daysSynced = 0;
  let daysSkipped = 0;
  let errors = 0;
  const failedEnterprises: string[] = [];

  for (const ent of enterprises) {
    try {
      const result = await incrementalSyncEnterprise(ent.slug, onProgress);
      daysSynced += result.daysSynced;
      daysSkipped += result.daysSkipped;
    } catch (err) {
      errors++;
      failedEnterprises.push(ent.slug);
      console.error("[Sync] [%s] Incremental sync failed, continuing with remaining enterprises:", sanitizeForLog(ent.slug), err);
    }
  }

  return { daysSynced, daysSkipped, errors, failedEnterprises };
}

// ── Sync seats (per-enterprise helper) ────────────────────────────────

async function syncSeatsForEnterprise(slug: string): Promise<number> {
  const orgs = getResolvedOrgsForEnterprise(slug);
  let total = 0;

  if (isCopilotSubEnabledForEnterprise(slug, "enterprise")) {
    try {
      const { seats } = await getEnterpriseSeatsSnapshot(slug);
      const { seatsByOrg, skipped } = groupSeatsByOrganization(seats);
      if (skipped > 0 && seatsByOrg.size === 0) {
        console.warn(
          "[Sync] [%s] Skipped %d enterprise seat(s) without organization metadata during seat sync",
          sanitizeForLog(slug),
          skipped,
        );
        throw new Error("Enterprise seats snapshot contained no organization metadata");
      }
      total = replaceEnterpriseSeats(slug, seatsByOrg);
      recordSync(slug, "seats", slug, null, total);
      if (skipped > 0) {
        console.warn(
          "[Sync] [%s] Skipped %d enterprise seat(s) without organization metadata during seat sync",
          sanitizeForLog(slug),
          skipped,
        );
      }
      return total;
    } catch (err) {
      console.error("[%s] Failed to sync enterprise seats; falling back to org seats:", sanitizeForLog(slug), err);
    }
  }

  for (const org of orgs) {
    try {
      const { seats } = await seatsClient.getOrgSeats(org, slug);
      upsertSeats(slug, org, seats);
      total += seats.length;
      recordSync(slug, "seats", org, null, seats.length);
    } catch (err) {
      console.error("[%s] Failed to sync seats for %s:", sanitizeForLog(slug), sanitizeForLog(org), err);
    }
  }

  return total;
}

export async function syncSeats(): Promise<number> {
  enterpriseSeatsSnapshotCache.clear();
  if (!isCopilotSubEnabledForAnyEnterprise("seats")) {
    console.log("[Sync] Seats sync disabled by config");
    return 0;
  }

  const enterprises = getConfiguredEnterprises();
  let total = 0;

  for (const ent of enterprises) {
    if (!isCopilotSubEnabledForEnterprise(ent.slug, "seats")) continue;
    total += await syncSeatsForEnterprise(ent.slug);
  }

  return total;
}

// ── Sync teams (per-enterprise helper) ────────────────────────────────

async function syncTeamsForEnterprise(slug: string): Promise<number> {
  const orgs = getResolvedOrgsForEnterprise(slug);
  let total = 0;

  // Enterprise teams (only when enterprise mode is on)
  if (isCopilotSubEnabledForEnterprise(slug, "enterprise")) {
    try {
      const entTeams = await teamsClient.getEnterpriseTeamsWithMembers(slug, slug);
      upsertAllTeams(slug, entTeams);
      total += entTeams.length;
      recordSync(slug, "teams", slug, null, entTeams.length);
    } catch (err) {
      console.error("[%s] Failed to sync enterprise teams:", sanitizeForLog(slug), err);
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
      console.error("[%s] Failed to sync teams for %s:", sanitizeForLog(slug), sanitizeForLog(org), err);
    }
  }

  return total;
}

export async function syncTeams(): Promise<number> {
  if (!isCopilotSubEnabledForAnyEnterprise("teams")) {
    console.log("[Sync] Teams sync disabled by config");
    return 0;
  }

  const enterprises = getConfiguredEnterprises();
  let total = 0;

  for (const ent of enterprises) {
    if (!isCopilotSubEnabledForEnterprise(ent.slug, "teams")) continue;
    total += await syncTeamsForEnterprise(ent.slug);
  }

  return total;
}

// ── Full sync: backfill + seats + teams (per-enterprise loop) ─────────

export async function fullSync(
  onProgress?: (progress: SyncProgress) => void
): Promise<MultiEnterpriseSyncResult> {
  const enterprises = getConfiguredEnterprises();
  userTeamsUnavailable.clear();
  enterpriseSeatsSnapshotCache.clear();

  if (enterprises.length === 0) {
    console.warn("[Sync] No enterprises configured — nothing to sync");
    return {
      backfill: { daysSynced: 0, daysSkipped: 0, errors: 0 },
      seats: 0,
      teams: 0,
      enterprises: [],
      licensing: { enabled: false, enterprises: [] },
    };
  }

  const enterpriseResults: EnterpriseSyncResult[] = [];
  const licensingResults: LicenseHistoryEnterpriseSyncResult[] = [];
  const licensingDeps: LicenseHistorySyncDeps = createDefaultLicenseHistorySyncDeps({
    onProgress: (p: LicenseHistorySyncProgress) => {
      onProgress?.({ phase: "licensing", current: p.current, total: p.total, message: p.message, enterpriseSlug: p.enterprise });
    },
  });
  const licensingEnabled = licensingDeps.getConfig().history.enabled;

  for (const entConfig of enterprises) {
    const slug = entConfig.slug;

    try {
    // Validate config + auth for this enterprise (skip for org-only entries)
    if (isCopilotSubEnabledForEnterprise(slug, "enterprise")) {
      void getEnterpriseContext(slug);
    }
    // Always register in DB — this is a local write, not an enterprise API call
    updateEnterpriseRegistry(slug, slug, entConfig.displayName);

    // Discover orgs (auto-discovers from API when include is empty)
    await discoverOrgsIfNeeded(slug, onProgress);
    heartbeatSyncLock();

    // Teams
    let entTeams = 0;
    if (isCopilotSubEnabledForEnterprise(slug, "teams")) {
      onProgress?.({ phase: "teams", current: 0, total: 1, message: `[${sanitizeForLog(slug)}] Syncing team memberships...`, enterpriseSlug: slug });
      entTeams = await syncTeamsForEnterprise(slug);
      cache.invalidateByPrefix("/api/teams");
      cache.invalidateByPrefix("/api/filters");
    }
    heartbeatSyncLock();

    // Seats
    let entSeats = 0;
    if (isCopilotSubEnabledForEnterprise(slug, "seats")) {
      onProgress?.({ phase: "seats", current: 0, total: 1, message: `[${sanitizeForLog(slug)}] Syncing seat data...`, enterpriseSlug: slug });
      entSeats = await syncSeatsForEnterprise(slug);
      cache.invalidateByPrefix("/api/seats");
    }
    heartbeatSyncLock();

    // Backfill
    onProgress?.({ phase: "backfill", current: 0, total: 1, message: `[${sanitizeForLog(slug)}] Starting metrics backfill...`, enterpriseSlug: slug });
    const bf = await backfillEnterprise(slug, undefined, onProgress);
    heartbeatSyncLock();

    // Try 28-day reports as fallback when per-day enterprise/org data is empty
    await sync28DayFallback(slug, onProgress);
    cache.invalidateByPrefix("/api/metrics");
    cache.invalidateByPrefix("/api/users");

    // Sync billing reports
    onProgress?.({ phase: "billing", current: 0, total: 1, message: `[${sanitizeForLog(slug)}] Syncing billing reports...`, enterpriseSlug: slug });
    try {
      await syncBilling(slug, (p) => {
        onProgress?.({ phase: "billing", current: p.current, total: p.total, message: p.message, enterpriseSlug: slug });
      });
      cache.invalidateByPrefix("/api/billing");
    } catch (err) {
      console.error("[Sync] [%s] Billing sync failed:", sanitizeForLog(slug), err);
    }

    // Sync historical license reconciliation (Task 9) — only after existing
    // live seats and billing inputs are available for this enterprise.
    // A licensing failure is isolated here so it never rolls back this
    // enterprise's otherwise-successful backfill/seats/teams/billing results.
    onProgress?.({ phase: "licensing", current: 0, total: 1, message: `[${sanitizeForLog(slug)}] Syncing historical license reconciliation...`, enterpriseSlug: slug });
    let entLicensing: LicenseHistoryEnterpriseSyncResult;
    try {
      entLicensing = await syncLicenseHistoryForEnterprise(slug, licensingDeps);
    } catch (err) {
      console.error("[Sync] [%s] Licensing history sync failed unexpectedly:", sanitizeForLog(slug), err);
      entLicensing = {
        enterpriseSlug: slug,
        status: "failed",
        runId: null,
        requestedPeriods: [],
        materializedPeriods: [],
        skippedPeriods: [],
        warnings: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    licensingResults.push(entLicensing);

    enterpriseResults.push({
      enterpriseSlug: slug,
      backfill: bf,
      seats: entSeats,
      teams: entTeams,
      licensing: entLicensing,
    });
    } catch (err) {
      console.error("[Sync] [%s] Enterprise sync failed, continuing with remaining enterprises:", sanitizeForLog(slug), err);
      enterpriseResults.push({
        enterpriseSlug: slug,
        backfill: { daysSynced: 0, daysSkipped: 0, errors: 1 },
        seats: 0,
        teams: 0,
      });
    }
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

  // Invalidate in-memory caches so fresh data is served
  // (Individual prefixes are invalidated inside the loop after each sync phase)
  invalidateEnterpriseCountCache();

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
    licensing: {
      enabled: licensingEnabled,
      enterprises: [...licensingResults].sort((a, b) => a.enterpriseSlug.localeCompare(b.enterpriseSlug)),
    },
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
  if (isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise") && !hasEnterpriseDataForRange(enterpriseSlug, startStr, endStr)) {
    onProgress?.({ phase: "fallback", current: 0, total: 1, message: `[${sanitizeForLog(enterpriseSlug)}] Trying enterprise 28-day report as fallback...`, enterpriseSlug });
    try {
      const data = await metricsClient.getEnterprise28DayReport(enterpriseSlug, enterpriseSlug);
      if (data.length > 0) {
        console.log("[Sync] [%s] 28-day enterprise fallback: %d day-totals received", sanitizeForLog(enterpriseSlug), data.length);
        for (const record of data) {
          upsertEnterpriseDayMetrics(enterpriseSlug, record);
          recordSync(enterpriseSlug, "enterprise", enterpriseSlug, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error("[Sync] [%s] 28-day enterprise fallback failed:", sanitizeForLog(enterpriseSlug), err);
    }
  }

  // Org 28-day fallback — only for orgs without existing data
  for (const org of orgs) {
    if (hasOrgDataForRange(org, startStr, endStr, [enterpriseSlug])) {
      continue; // Already have org data, skip fallback
    }
    onProgress?.({ phase: "fallback", current: 0, total: orgs.length, message: `[${sanitizeForLog(enterpriseSlug)}] Trying org ${sanitizeForLog(org)} 28-day report as fallback...`, enterpriseSlug });
    try {
      const data = await metricsClient.getOrg28DayReport(org, enterpriseSlug);
      if (data.length > 0) {
        console.log("[Sync] [%s] 28-day org fallback for %s: %d day-totals received", sanitizeForLog(enterpriseSlug), sanitizeForLog(org), data.length);
        for (const record of data) {
          upsertOrgDayMetrics(enterpriseSlug, org, record);
          recordSync(enterpriseSlug, "org", org, record.day, 1, "success");
        }
      }
    } catch (err) {
      console.error("[Sync] [%s] 28-day org fallback failed for %s:", sanitizeForLog(enterpriseSlug), sanitizeForLog(org), err);
    }
  }
}
