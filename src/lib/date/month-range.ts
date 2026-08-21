// Calendar-month helpers shared by the date-range context and the billing /
// licensing surfaces.
//
// Billing and licensing are inherently monthly: GitHub bills on calendar
// cycles and the licensing history tables are keyed by a "YYYY-MM" period.
// Reading those pages through a rolling "last N days" window is what allowed
// the Billing and License Reconciliation pages to report different figures for
// what a reader reasonably assumes is the same thing. Selecting a calendar
// month puts both on an identical basis.
//
// A period here is the same "YYYY-MM" string used by
// `src/lib/licensing/periods.ts`; bounds are inclusive `YYYY-MM-DD` dates,
// because the metrics/billing query layer filters on inclusive day columns
// (the licensing module's half-open instant bounds serve a different purpose).

const PERIOD_RE = /^(\d{4})-(\d{2})$/;

/** Inclusive `YYYY-MM-DD` bounds for a calendar month. */
export interface MonthBounds {
  startDate: string;
  endDate: string;
}

/** Narrow a string to a well-formed "YYYY-MM" period. */
export function isValidPeriod(period: string): boolean {
  const match = PERIOD_RE.exec(period);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format a Date as `YYYY-MM-DD` in UTC. */
function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The "YYYY-MM" period a Date falls in, in UTC. */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

/**
 * Latest day that synced Copilot data can cover.
 *
 * GitHub's daily usage reports lag by one calendar day, and the rest of the
 * date layer treats that boundary as UTC. Sharing this helper keeps client URL
 * parsing and picker validation aligned with the API's "UTC yesterday" cap.
 */
export function latestAvailableDate(now: Date = new Date()): string {
  const latest = new Date(now.getTime());
  latest.setUTCDate(latest.getUTCDate() - 1);
  return toIsoDate(latest);
}

/**
 * Inclusive day bounds for a calendar month.
 *
 * The end is clamped to `now` so the *current* month reports only elapsed
 * days. Without the clamp an in-progress month would advertise a window
 * running into the future, which makes per-day averages wrong and invites the
 * reader to compare a partial month against a whole one without noticing.
 */
export function monthBounds(period: string, now: Date = new Date()): MonthBounds {
  const match = PERIOD_RE.exec(period);
  if (!match) {
    throw new Error(`Invalid period "${period}": expected format YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid period "${period}": month must be between 01 and 12`);
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = lastDay.getTime() > today.getTime() ? today : lastDay;

  return {
    startDate: toIsoDate(start),
    // A future month has no elapsed days at all; collapse it to its start
    // rather than emitting an end that precedes the start.
    endDate: end.getTime() < start.getTime() ? toIsoDate(start) : toIsoDate(end),
  };
}

/** True when `period` is still accruing data (i.e. it is the current month). */
export function isPartialMonth(period: string, now: Date = new Date()): boolean {
  return period === periodOf(now);
}

/** Number of inclusive days covered by a period, after clamping to `now`. */
export function monthDayCount(period: string, now: Date = new Date()): number {
  const { startDate, endDate } = monthBounds(period, now);
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * The most recent `count` periods, newest first, inclusive of the current
 * month. Used to populate the month selector when the API has not told us
 * which periods actually hold data.
 */
export function recentPeriods(count: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(year, month - i, 1));
    out.push(periodOf(d));
  }
  return out;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Human label for a period, e.g. "August 2026". */
export function periodLabel(period: string): string {
  const match = PERIOD_RE.exec(period);
  if (!match) return period;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return period;
  return `${MONTH_NAMES[month - 1]} ${match[1]}`;
}

/** Compact label for a period, e.g. "Aug 2026". */
export function periodLabelShort(period: string): string {
  const full = periodLabel(period);
  if (full === period) return period;
  const [name, year] = full.split(" ");
  return `${name.slice(0, 3)} ${year}`;
}

/** The calendar months an inclusive day range touches, and whether it fills them. */
export interface RangeMonthCoverage {
  /** Every "YYYY-MM" period the range overlaps, in ascending order. */
  months: string[];
  /**
   * True when the range does *not* start on the first day of its first month
   * and end on the last day of its last month — i.e. month-keyed data answering
   * this range covers strictly more days than the range itself.
   */
  partial: boolean;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when a `YYYY-MM-DD` string names a date that actually exists.
 *
 * A shape check alone accepts `2026-02-29` and `2026-04-31`, which JavaScript
 * silently rolls forward into the next month. Comparing the parsed date back to
 * its input is what rejects them. Mirrors the strict check that
 * `parseDateRangeParams` and `parseExplicitBounds` apply server-side, so a URL
 * the client accepts is one the API will accept too.
 */
export function isRealCalendarDate(raw: string): boolean {
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toIsoDate(parsed) === raw;
}

/**
 * Expand an inclusive `YYYY-MM-DD` range to the calendar months it touches.
 *
 * Month-keyed tables (licensing history, billing periods) can only answer a
 * day range by widening it to whole months. Surfaces that render such data for
 * an arbitrary range need to say so, otherwise a six-day selection silently
 * labels a whole month's rows.
 *
 * Returns `null` for input that is malformed, inverted, or not a real calendar
 * date. The last case matters because these bounds can arrive from a
 * deep-linked URL, and a shape check alone accepts impossible days such as
 * `2026-02-29`, which JavaScript would otherwise roll forward into March.
 */
export function monthsCoveringRange(startDate: string, endDate: string): RangeMonthCoverage | null {
  const start = ISO_DATE_RE.exec(startDate);
  const end = ISO_DATE_RE.exec(endDate);
  if (!start || !end) return null;
  // The round-trip also subsumes the month number, so nothing below needs a
  // separate 1-12 check: "2026-13-01" never parses in the first place.
  if (!isRealCalendarDate(startDate) || !isRealCalendarDate(endDate)) return null;
  if (startDate > endDate) return null;

  const startYear = Number(start[1]);
  const startMonth = Number(start[2]);
  const endYear = Number(end[1]);
  const endMonth = Number(end[2]);

  const months: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  // Day 0 of the following month is the last day of this one.
  const lastDayOfEndMonth = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const fillsMonths = Number(start[3]) === 1 && Number(end[3]) === lastDayOfEndMonth;
  return { months, partial: !fillsMonths };
}
