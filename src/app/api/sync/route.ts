import { NextResponse } from "next/server";
import { fullSync } from "@/lib/db/sync-service";
import { getSyncStatus, acquireSyncLock, releaseSyncLock, isSyncLocked, clearEmptySyncEntries } from "@/lib/db/metrics-repo";

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const resync = searchParams.get("resync") === "true";

  // Clear empty sync entries to allow re-fetching enterprise/org data
  if (resync) {
    const cleared = clearEmptySyncEntries();
    console.log(`[Sync] Cleared ${cleared} empty sync_log entries for re-sync`);
  }

  if (!acquireSyncLock()) {
    return NextResponse.json({
      success: true,
      message: "Sync already in progress. Check GET /api/sync/status for progress.",
      inProgress: true,
      status: getSyncStatus(),
    });
  }

  // Return immediately — sync runs in background
  const syncPromise = fullSync((progress) => {
    console.log(`[Sync] ${progress.message}`);
  })
    .then((result) => {
      console.log("[Sync] Complete:", JSON.stringify({
        daysSynced: result.backfill.daysSynced,
        daysSkipped: result.backfill.daysSkipped,
        errors: result.backfill.errors,
        seatsSynced: result.seats,
        teamsSynced: result.teams,
      }));
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
  });
}
