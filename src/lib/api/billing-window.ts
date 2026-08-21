// The single date-window resolver for every billing surface.
//
// Billing is billed on calendar cycles, so a selected month remains the
// highest-precedence basis on which Billing, Metered Usage and License & AI
// Credits can agree. Custom ranges must also flow through this resolver as
// explicit bounds; translating them to a `days` span would silently turn a
// historical selection into a rolling window ending yesterday.

import { getDateRange, MAX_DAYS, parseAndClampDays } from "@/lib/utils";
import { isValidPeriod, monthBounds, monthDayCount } from "@/lib/date/month-range";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive `YYYY-MM-DD` bounds plus the calendar period they represent, if any. */
export interface BillingWindow {
  start: string;
  end: string;
  /** Days covered by the window (the elapsed count for an in-progress month). */
  days: number;
  /** The selected "YYYY-MM", or null for an explicit/custom or rolling window. */
  period: string | null;
}

function parseExplicitBounds(params: URLSearchParams): BillingWindow | { error: string } | null {
  const rawStart = params.get("startDate");
  const rawEnd = params.get("endDate");

  if (rawStart === null && rawEnd === null) return null;
  if (!rawStart || !rawEnd) {
    return { error: "Both startDate and endDate must be provided together." };
  }
  if (!DATE_RE.test(rawStart) || !DATE_RE.test(rawEnd)) {
    return { error: "startDate and endDate must be in YYYY-MM-DD format." };
  }

  const s = new Date(`${rawStart}T00:00:00Z`);
  const e = new Date(`${rawEnd}T00:00:00Z`);
  if (
    Number.isNaN(s.getTime()) ||
    Number.isNaN(e.getTime()) ||
    s.toISOString().slice(0, 10) !== rawStart ||
    e.toISOString().slice(0, 10) !== rawEnd
  ) {
    return { error: "startDate or endDate is not a valid date." };
  }
  if (s > e) {
    return { error: "startDate must be on or before endDate." };
  }

  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  if (days > MAX_DAYS) {
    return { error: `Date range spans ${days} days, which exceeds the maximum of ${MAX_DAYS}.` };
  }

  // Billing periods clamp an in-progress month to today, so explicit billing
  // bounds allow today but reject dates beyond the period branch's upper bound.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (e > today) {
    return { error: "endDate cannot be in the future." };
  }

  return { start: rawStart, end: rawEnd, days, period: null };
}

/**
 * Resolve `period` (a calendar month), explicit `startDate`/`endDate`, or
 * `days` (a rolling window) into one set of bounds.
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

  const explicit = parseExplicitBounds(params);
  if (explicit) return explicit;

  const daysResult = parseAndClampDays(params.get("days"), defaultDays);
  if ("error" in daysResult) return { error: daysResult.error };
  const { start, end } = getDateRange(daysResult.days);
  return { start, end, days: daysResult.days, period: null };
}
