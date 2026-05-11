import { NextResponse } from "next/server";
import { fullSync } from "@/lib/db/sync-service";
import { fullGhasSync } from "@/lib/db/ghas-sync-service";
import { getSyncStatus, acquireSyncLock, releaseSyncLock, isSyncLocked, clearEmptySyncEntries, forceReleaseSyncLock, getSyncLockInfo } from "@/lib/db/metrics-repo";
import { getAutoSyncStatus } from "@/lib/sync/auto-sync-scheduler";
import { getClientEnterpriseList, isMetricEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const resync = searchParams.get("resync") === "true";
  const forceLock = searchParams.get("forceLock") === "true";

  // Clear empty sync entries to allow re-fetching enterprise/org data
  if (resync) {
    const cleared = clearEmptySyncEntries();
    console.log(`[Sync] Cleared ${cleared} empty sync_log entries for re-sync`);
  }

  // Log current lock state for operator diagnostics
  const lockInfo = getSyncLockInfo();
  console.log(`[Sync] Lock state before acquire:`, JSON.stringify(lockInfo));

  // Force-release a stale lock if requested
  if (forceLock && lockInfo.locked) {
    const cleared = forceReleaseSyncLock();
    console.log(`[Sync] Force-released stale lock:`, JSON.stringify(cleared));
  }

  if (!acquireSyncLock()) {
    return NextResponse.json({
      success: true,
      message: "Sync already in progress. Check GET /api/sync/status for progress. Use ?forceLock=true to force-release a stale lock.",
      inProgress: true,
      status: getSyncStatus(),
      lockInfo,
    });
  }

  // Return immediately — sync runs in background
  const syncPromise = fullSync((progress) => {
    console.log(`[Sync] ${progress.message}`);
  })
    .then(async (result) => {
      console.log("[Sync] Copilot sync complete:", JSON.stringify({
        daysSynced: result.backfill.daysSynced,
        daysSkipped: result.backfill.daysSkipped,
        errors: result.backfill.errors,
        seatsSynced: result.seats,
        teamsSynced: result.teams,
      }));

      // Run GHAS sync if any security metrics are enabled
      const ghasEnabled = isMetricEnabledForAnyEnterprise("codeScanning") || isMetricEnabledForAnyEnterprise("dependabot") || isMetricEnabledForAnyEnterprise("secretScanning");
      if (ghasEnabled) {
        try {
          console.log("[Sync] Starting GHAS sync...");
          const ghasResult = await fullGhasSync((p) => console.log(`[GHAS Sync] ${p.message}`));
          console.log("[Sync] GHAS sync complete:", JSON.stringify(ghasResult));
        } catch (err) {
          console.error("[Sync] GHAS sync failed:", err);
        }
      }
    })
    .catch((err) => {
      console.error("[Sync] Failed:", err);
    })
    .finally(() => {
      releaseSyncLock();
    });

  void syncPromise;

  return NextResponse.json({
    success: true,
    message: "Sync started. Poll GET /api/sync/status for progress.",
    inProgress: true,
  });
}

export async function GET() {
  return NextResponse.json({
    syncInProgress: isSyncLocked(),
    status: getSyncStatus(),
    lockInfo: getSyncLockInfo(),
    autoSync: getAutoSyncStatus(),
    enterprises: getClientEnterpriseList(),
  });
}
