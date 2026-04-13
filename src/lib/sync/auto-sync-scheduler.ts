// Auto-Sync Scheduler — runs incremental sync once per day at a configurable UTC time.
// Uses chained setTimeout (not setInterval) for drift-free scheduling.
// Respects the existing sync lock to prevent concurrent syncs.

import { getAutoSyncConfig } from "@/lib/config/dashboard-config";
import { incrementalSync } from "@/lib/db/sync-service";
import { refreshAllSummaries } from "@/lib/db/summary-tables";
import {
  acquireSyncLock,
  releaseSyncLock,
  heartbeatSyncLock,
} from "@/lib/db/metrics-repo";
import { cache } from "@/lib/cache/memory-cache";

const BACKFILL_RANGE = parseInt(process.env.BACKFILL_DAYS || "90", 10);

let timer: ReturnType<typeof setTimeout> | null = null;
let lastAutoSyncAt: string | null = null;
let nextAutoSyncAt: string | null = null;
let running = false;
let stopped = false;

/** Parse "HH:MM" into { hour, minute }. Returns null on invalid input. */
function parseUtcTime(utcTime: string): { hour: number; minute: number } | null {
  const match = utcTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Calculate ms until the next occurrence of HH:MM UTC. */
function msUntilNextRun(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  // If the target time already passed today, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/** Execute one auto-sync cycle, then schedule the next. */
async function executeAutoSync(): Promise<void> {
  let lockAcquired = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  try {
    if (stopped) return;

    const config = getAutoSyncConfig();
    if (!config.enabled) {
      console.log("[AutoSync] Disabled in config — stopping scheduler");
      nextAutoSyncAt = null;
      return;
    }

    if (!acquireSyncLock()) {
      console.log("[AutoSync] Sync already in progress — skipping this cycle");
      return;
    }
    lockAcquired = true;

    // Heartbeat the lock every 5 minutes to prevent expiry during long syncs
    heartbeat = setInterval(() => {
      try { heartbeatSyncLock(); } catch { /* ignore */ }
    }, 5 * 60 * 1000);

    running = true;
    console.log("[AutoSync] Starting incremental sync...");

    try {
      const result = await incrementalSync((p) => {
        console.log(`[AutoSync] ${p.message}`);
      });
      console.log(`[AutoSync] Incremental sync complete: ${result.daysSynced} days synced, ${result.daysSkipped} skipped`);

      // Refresh summary tables
      try {
        const summaryEnd = new Date();
        summaryEnd.setDate(summaryEnd.getDate() - 1);
        const summaryStart = new Date(summaryEnd);
        summaryStart.setDate(summaryStart.getDate() - BACKFILL_RANGE + 1);
        refreshAllSummaries(
          summaryStart.toISOString().split("T")[0],
          summaryEnd.toISOString().split("T")[0],
        );
      } catch (err) {
        console.error("[AutoSync] Failed to refresh summary tables:", err);
      }

      cache.invalidateAll();
      lastAutoSyncAt = new Date().toISOString();
    } catch (err) {
      console.error("[AutoSync] Incremental sync failed:", err);
    }
  } catch (err) {
    console.error("[AutoSync] Unexpected error:", err);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lockAcquired) releaseSyncLock();
    running = false;
    if (!stopped) scheduleNext();
  }
}

/** Schedule the next auto-sync run. */
function scheduleNext(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }

  if (stopped) {
    nextAutoSyncAt = null;
    return;
  }

  const config = getAutoSyncConfig();
  if (!config.enabled) {
    nextAutoSyncAt = null;
    return;
  }

  const parsed = parseUtcTime(config.utcTime);
  if (!parsed) {
    console.error(`[AutoSync] Invalid utcTime "${config.utcTime}" — expected "HH:MM"`);
    nextAutoSyncAt = null;
    return;
  }

  const delayMs = msUntilNextRun(parsed.hour, parsed.minute);
  const nextDate = new Date(Date.now() + delayMs);
  nextAutoSyncAt = nextDate.toISOString();
  console.log(`[AutoSync] Next run scheduled at ${nextAutoSyncAt} (in ${Math.round(delayMs / 60000)} minutes)`);

  timer = setTimeout(() => {
    executeAutoSync().catch((err) => {
      console.error("[AutoSync] Unexpected error in scheduled run:", err);
    });
  }, delayMs);
}

/** Start the auto-sync scheduler. Safe to call multiple times. */
export function startAutoSync(): void {
  stopAutoSync();
  stopped = false;

  const config = getAutoSyncConfig();
  if (!config.enabled) {
    console.log("[AutoSync] Disabled in config — scheduler not started");
    return;
  }

  console.log(`[AutoSync] Scheduler starting — configured for ${config.utcTime} UTC daily`);
  scheduleNext();
}

/** Stop the auto-sync scheduler. */
export function stopAutoSync(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextAutoSyncAt = null;
}

/** Get the current auto-sync schedule state (for API exposure). */
export function getAutoSyncStatus(): {
  enabled: boolean;
  utcTime: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  running: boolean;
} {
  const config = getAutoSyncConfig();
  return {
    enabled: config.enabled,
    utcTime: config.utcTime,
    nextRunAt: nextAutoSyncAt,
    lastRunAt: lastAutoSyncAt,
    running,
  };
}
