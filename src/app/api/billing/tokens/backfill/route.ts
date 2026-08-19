import { NextRequest, NextResponse } from "next/server";
import {
  getEnterpriseSlugs,
  isBillingSubEnabledForAnyEnterprise,
} from "@/lib/config/enterprise-config";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";
import { resetBillingSyncState } from "@/lib/db/billing-repo";
import type { BillingReportType } from "@/lib/types/billing";

/**
 * Opt-in backfill trigger for the AI usage report's per-model token breakdown.
 *
 * Billing sync is incremental: it only requests days after the stored
 * `last_report_end`. Days synced before the token columns were wired up
 * therefore keep zeroed tokens indefinitely. Clearing the sync state for the
 * credit report types makes the next sync re-request the full rolling window
 * (31 days for the detailed/AI-credit reports), overwriting those rows with
 * token-bearing data.
 *
 * This is deliberately a POST the user triggers explicitly — normal incremental
 * sync behaviour is unchanged, and no usage data is deleted.
 *
 * The endpoint is rate limited and the optional `enterprise` parameter is
 * validated against the configured enterprises, so an unrecognised slug fails
 * loudly with a 400 rather than silently clearing nothing.
 */
const REPORT_TYPES: BillingReportType[] = ["ai_credit", "premium_request"];

async function handler(request: NextRequest) {
  try {
    if (
      !isBillingSubEnabledForAnyEnterprise("premiumRequests") &&
      !isBillingSubEnabledForAnyEnterprise("aiCredits")
    ) {
      return NextResponse.json(
        { error: "Billing reports are not enabled for any enterprise" },
        { status: 400 }
      );
    }

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
          { status: 400 }
        );
      }
    }

    const cleared = resetBillingSyncState(REPORT_TYPES, enterprise);

    return NextResponse.json({
      ok: true,
      cleared,
      reportTypes: REPORT_TYPES,
      enterprise: enterprise ?? "all",
      message:
        cleared > 0
          ? "Billing sync state cleared. Run a sync to refetch the full window with token detail."
          : "No matching sync state found; the next sync will already fetch the full window.",
    });
  } catch (error) {
    // Never surface the raw exception: a SQLite failure names tables, columns
    // and the database file path.
    console.error("[api/billing/tokens/backfill] failed:", error);
    return NextResponse.json({ error: "Failed to clear billing sync state." }, { status: 500 });
  }
}

export const POST = withRateLimit(handler);
