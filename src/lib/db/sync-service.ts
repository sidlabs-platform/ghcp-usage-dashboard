// Data Sync Service — fetches data day-by-day using enterprise-1-day endpoint
// Supports 90+ day backfill by looping through each day individually

import { metricsClient } from "@/lib/github/metrics-client";
import { seatsClient } from "@/lib/github/seats-client";
import { teamsClient } from "@/lib/github/teams-client";
import {
  upsertEnterpriseDayMetrics,
  upsertOrgDayMetrics,
  upsertUserDayMetrics,
  recordSync,
  isSynced,
  getLatestSyncDay,
} from "./metrics-repo";
import { upsertSeats } from "./seats-repo";
import { upsertAllTeams } from "./teams-repo";
import { datesBetween } from "@/lib/utils";

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
      for (const user of users) {
        upsertUserDayMetrics(user);
      }
      result.users = users.length;
      recordSync("users", enterprise, day, users.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordSync("users", enterprise, day, 0, "error", msg);
      console.error(`Failed to sync user data for ${day}:`, msg);
    }
  }

  // 3. Organization aggregates
  for (const org of orgs) {
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
  }

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

  for (let i = 0; i < allDays.length; i++) {
    const day = allDays[i];

    // Skip if already synced
    if (isSynced("enterprise", enterprise, day) && isSynced("users", enterprise, day)) {
      daysSkipped++;
      continue;
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

    // Rate limit courtesy: 500ms delay between days (API handles it well)
    if (i < allDays.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

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

  onProgress?.({ phase: "seats", current: 0, total: 1, message: "Syncing seat data..." });
  const seats = await syncSeats();

  onProgress?.({ phase: "backfill", current: 0, total: 1, message: "Starting metrics backfill..." });
  const bf = await backfill(undefined, onProgress);

  return { backfill: bf, seats, teams };
}
