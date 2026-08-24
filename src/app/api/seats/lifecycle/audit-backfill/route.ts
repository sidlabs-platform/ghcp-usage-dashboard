import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { resetSeatAuditCoverage } from "@/lib/db/seat-lifecycle-repo";

/**
 * Opt-in recovery trigger for the audit-log seat lifecycle source.
 *
 * The audit-log sync is incremental: it resumes from the stored
 * `covered_through` watermark on every run, by design, so a healthy sync
 * never re-reads history it has already covered. That design has a failure
 * mode: a run that read the audit log successfully but misclassified (and
 * therefore silently dropped) the events it saw — as happened when GitHub's
 * `copilot.`-prefixed seat action names were not recognized — still advances
 * `covered_through` past the gap. Later syncs resume just past it and can
 * never revisit the window where real offboard/onboard events were lost.
 *
 * This clears only the stored coverage watermark, mirroring
 * `/api/billing/tokens/backfill`'s reset of `billing_sync_state`: no
 * lifecycle event rows are deleted, and the next sync re-derives them from
 * a full re-read of the configured lookback window.
 */
async function handler(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get("enterprise");
    const enterprise = raw && raw.trim() ? raw.trim() : undefined;
    if (enterprise) {
      const configured = getEnterpriseSlugs();
      if (!configured.includes(enterprise)) {
        return NextResponse.json(
          {
            error: `Unknown enterprise "${enterprise}". Configured enterprises: ${
              configured.join(", ") || "(none)"
            }`,
          },
          { status: 400 },
        );
      }
    }

    const cleared = resetSeatAuditCoverage(enterprise);

    return NextResponse.json({
      ok: true,
      cleared,
      enterprise: enterprise ?? "all",
      message:
        cleared > 0
          ? "Audit-log coverage watermark cleared. Run a sync to refetch the full lookback window."
          : "No matching audit sync state found; the next sync will already fetch the full lookback window.",
    });
  } catch (error) {
    // Never surface the raw exception: a SQLite failure names tables, columns
    // and the database file path.
    console.error("[api/seats/lifecycle/audit-backfill] failed:", error);
    return NextResponse.json({ error: "Failed to clear audit sync state." }, { status: 500 });
  }
}

export const POST = withRateLimit(handler);
