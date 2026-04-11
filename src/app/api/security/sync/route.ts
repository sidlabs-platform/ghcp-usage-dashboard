import { NextResponse } from "next/server";
import { fullGhasSync } from "@/lib/db/ghas-sync-service";
import { getAllGhasSyncStates } from "@/lib/db/ghas-repo";

export async function POST() {
  // Start sync in background (don't await)
  const syncPromise = fullGhasSync((progress) => {
    console.log(`[GHAS Sync] ${progress.message}`);
  })
    .then((result) => {
      console.log("[GHAS Sync] Complete:", JSON.stringify(result));
    })
    .catch((err) => {
      console.error("[GHAS Sync] Failed:", err);
    });

  void syncPromise;

  return NextResponse.json({
    success: true,
    message: "GHAS sync started. Check GET /api/security/sync for status.",
  });
}

export async function GET() {
  const states = getAllGhasSyncStates();
  const syncing = states.some(s => s.status === "syncing");
  return NextResponse.json({ syncing, states });
}
