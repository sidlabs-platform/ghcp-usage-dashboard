// Dated AI-Credit allowance window fixtures — `DatedAllowance[]`
// (`dashboard-config.ts`) demonstrating a negotiated allowance change
// effective mid-scenario, plus the static fallback that applies to any
// period neither window covers.

import type { DatedAllowance } from "@/lib/config/dashboard-config";

/** Static, undated fallback allowance (would apply to any period outside both dated windows below — not exercised directly by this scenario's periods, but present for realism). */
export const STATIC_AIC_ALLOWANCE = { business: 300, enterprise: 600, unknown: 0 };

/**
 * Two non-overlapping, consecutive windows: a lower business-plan allowance
 * for January, replaced by a higher one from February onward — modeling a
 * real negotiated allowance increase effective on a specific date, per
 * `DatedAllowance`'s contract (`end` is inclusive; an absent `end` means
 * open-ended).
 */
export const ALPHA_DATED_ALLOWANCES: DatedAllowance[] = [
  { start: "2026-01-01", end: "2026-01-31", credits: { business: 250 } },
  { start: "2026-02-01", credits: { business: 400 } },
];
