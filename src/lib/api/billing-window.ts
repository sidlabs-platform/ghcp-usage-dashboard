// The single date-window resolver for every billing surface.
//
// Billing is billed on calendar cycles, so a selected month is the only basis
// on which Billing, Metered Usage and License & AI Credits can agree. Each
// route previously resolved its own window, and Metered Usage understood only
// `days` — so selecting "July 2026" moved two pages to July while the third
// silently kept showing a rolling 28-day window, presenting three different
// periods as one view.

import { getDateRange, parseAndClampDays } from "@/lib/utils";
import { isValidPeriod, monthBounds, monthDayCount } from "@/lib/date/month-range";

/** Inclusive `YYYY-MM-DD` bounds plus the calendar period they represent, if any. */
export interface BillingWindow {
  start: string;
  end: string;
  /** Days covered by the window (the elapsed count for an in-progress month). */
  days: number;
  /** The selected "YYYY-MM", or null for a rolling `days` window. */
  period: string | null;
}

/**
 * Resolve `period` (a calendar month) or `days` (a rolling window) into one
 * set of bounds.
 *
 * `period` wins when present. The month's end is clamped to today by
 * {@link monthBounds}, so an in-progress month reports only elapsed days.
 */
export function resolveBillingWindow(
  params: URLSearchParams,
  defaultDays = 28,
): BillingWindow | { error: string } {
  const periodParam = params.get("period");
  // `!== null` rather than truthiness: `?period=` yields "", which is a
  // malformed period the caller should hear about, not a silent fallback to a
  // rolling window that answers a different question than the one asked.
  if (periodParam !== null) {
    if (!isValidPeriod(periodParam)) {
      return { error: `Invalid period "${periodParam}": expected format YYYY-MM` };
    }
    // One clock read for both bounds and day count, so an in-progress month
    // cannot report bounds and a span from either side of midnight.
    const now = new Date();
    const { startDate, endDate } = monthBounds(periodParam, now);
    return {
      start: startDate,
      end: endDate,
      days: monthDayCount(periodParam, now),
      period: periodParam,
    };
  }

  const daysResult = parseAndClampDays(params.get("days"), defaultDays);
  if ("error" in daysResult) return { error: daysResult.error };
  const { start, end } = getDateRange(daysResult.days);
  return { start, end, days: daysResult.days, period: null };
}
