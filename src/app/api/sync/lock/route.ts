import { NextResponse } from "next/server";
import { forceReleaseSyncLock, getSyncLockInfo } from "@/lib/db/metrics-repo";

/**
 * GET /api/sync/lock — Return current lock state for diagnostics.
 */
export async function GET() {
  const lockInfo = getSyncLockInfo();
  return NextResponse.json(lockInfo);
}

/**
 * DELETE /api/sync/lock — Manually clear a stuck sync lock.
 * Use when the lock is held after a server crash or hanging sync.
 */
export async function DELETE() {
  const lockInfo = getSyncLockInfo();

  if (!lockInfo.locked) {
    return NextResponse.json({
      success: true,
      message: "No lock was held.",
      lockInfo,
    });
  }

  const cleared = forceReleaseSyncLock();
  console.log(`[Sync] Manual lock clear via DELETE /api/sync/lock:`, JSON.stringify(cleared));

  return NextResponse.json({
    success: true,
    message: "Sync lock cleared.",
    clearedLock: cleared,
  });
}
