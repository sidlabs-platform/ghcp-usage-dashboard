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
