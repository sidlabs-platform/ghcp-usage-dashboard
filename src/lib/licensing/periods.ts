// Pure date/period helpers for historical licensing reconciliation.
//
// All functions here are side-effect free and operate on plain strings/Dates so
// they can be unit-tested in isolation from the config and DB layers. Periods
// are represented as "YYYY-MM" strings (a billing/report month); intervals use
// half-open [start, end) semantics to match GitHub seat assignment/revocation
// event modeling.

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const RANGE_RE = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/;
const LAST_N_RE = /^last_(\d+)_months$/;

/**
 * Upper bound on how many months a single `reportMonths` token (an inclusive
 * "start..end" range or "last_N_months") may expand to. Enforced *before*
 * allocating/looping so a mistyped/malicious config value (e.g. a decades-long
 * range or "last_999999_months") can't force an unbounded array allocation or
 * loop.
 */
export const MAX_REPORT_MONTHS = 120;

/** Parsed {year, month} where month is 1-12. */
interface YearMonth {
  year: number;
  month: number;
}

/** Validate and parse a single "YYYY-MM" token into a YearMonth, throwing on malformed input. */
function parseMonthToken(token: string): YearMonth {
  const match = MONTH_RE.exec(token);
  if (!match) {
    throw new Error(`Invalid report month "${token}": expected format YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid report month "${token}": month must be between 01 and 12`);
  }
  return { year, month };
}

/** Format a YearMonth back into a "YYYY-MM" string. */
function formatYearMonth({ year, month }: YearMonth): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** Return the YearMonth immediately following the given one (handles year rollover). */
function nextYearMonth({ year, month }: YearMonth): YearMonth {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** Total month index (year*12 + month) used to compare/iterate YearMonths. */
function monthIndex({ year, month }: YearMonth): number {
  return year * 12 + (month - 1);
}

function yearMonthFromIndex(index: number): YearMonth {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month };
}

/** Expand an inclusive "start..end" month range into a list of "YYYY-MM" strings. */
function expandRange(startToken: string, endToken: string): string[] {
  const start = parseMonthToken(startToken);
  const end = parseMonthToken(endToken);
  const startIdx = monthIndex(start);
  const endIdx = monthIndex(end);
  if (endIdx < startIdx) {
    throw new Error(`Invalid report month range "${startToken}..${endToken}": end is before start`);
  }
  const span = endIdx - startIdx + 1;
  if (span > MAX_REPORT_MONTHS) {
    throw new Error(
      `Invalid report month range "${startToken}..${endToken}": spans ${span} months, exceeding the maximum of ${MAX_REPORT_MONTHS}`
    );
  }
  const months: string[] = [];
  for (let idx = startIdx; idx <= endIdx; idx++) {
    months.push(formatYearMonth(yearMonthFromIndex(idx)));
  }
  return months;
}

/** Expand "last_N_months" (inclusive of the current month) relative to `now`. */
function expandLastNMonths(token: string, now: Date): string[] {
  const match = LAST_N_RE.exec(token);
  if (!match) {
    throw new Error(`Invalid report month token "${token}": expected format last_N_months`);
  }
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid report month token "${token}": N must be a positive integer`);
  }
  if (n > MAX_REPORT_MONTHS) {
    throw new Error(`Invalid report month token "${token}": N must not exceed ${MAX_REPORT_MONTHS}`);
  }
  const currentIdx = monthIndex({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const months: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    months.push(formatYearMonth(yearMonthFromIndex(currentIdx - i)));
  }
  return months;
}

/**
 * Parse the `metrics.billing.licensing.history.reportMonths` config value into a
 * sorted, de-duplicated list of "YYYY-MM" strings.
 *
 * Supports:
 *  - A single month: "2026-01"
 *  - An inclusive range: "2026-01..2026-03"
 *  - "last_N_months" (inclusive of the current month, relative to `now`)
 *  - An array mixing any of the above
 *  - `undefined`, which resolves to just the current month
 *
 * Throws a descriptive `Error` on malformed syntax so callers (config
 * validation) can catch it and fall back to safe defaults.
 */
export function parseReportMonths(input: string | string[] | undefined, now: Date = new Date()): string[] {
  if (input === undefined) {
    return [formatYearMonth({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 })];
  }

  const tokens = Array.isArray(input) ? input : [input];
  if (tokens.length === 0) {
    return [formatYearMonth({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 })];
  }

  const months = new Set<string>();
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (LAST_N_RE.test(token)) {
      for (const m of expandLastNMonths(token, now)) months.add(m);
      continue;
    }
    const rangeMatch = RANGE_RE.exec(token);
    if (rangeMatch) {
      for (const m of expandRange(rangeMatch[1], rangeMatch[2])) months.add(m);
      continue;
    }
    if (token.includes("..")) {
      // Looks like it's attempting a range but doesn't exactly match a single
      // "YYYY-MM..YYYY-MM" range (e.g. three+ segments, a trailing/leading
      // separator, or a malformed side) — reject rather than guessing intent.
      throw new Error(`Invalid report month range "${token}": expected exactly one "YYYY-MM..YYYY-MM" range`);
    }
    months.add(formatYearMonth(parseMonthToken(token)));
  }

  return [...months].sort();
}

/** Start/end ISO instant bounds for a billing cycle, half-open [start, end). */
export interface PeriodBounds {
  start: string;
  end: string;
}

/**
 * Resolve the UTC billing-cycle bounds for a "YYYY-MM" period: the instant the
 * month begins and the instant the next month begins (exclusive end).
 */
export function cycleBoundsUtc(period: string): PeriodBounds {
  const ym = parseMonthToken(period);
  const next = nextYearMonth(ym);
  const start = new Date(Date.UTC(ym.year, ym.month - 1, 1)).toISOString();
  const end = new Date(Date.UTC(next.year, next.month - 1, 1)).toISOString();
  return { start, end };
}

/**
 * Determine whether a seat's assignment interval `[assignedAt, revokedAt)`
 * overlaps the given "YYYY-MM" report period.
 *
 * `null`/`undefined` are explicitly documented open bounds: a missing
 * `assignedAt` is treated as "always started" (-Infinity); a missing
 * `revokedAt` is treated as "still active" (+Infinity, i.e. never revoked).
 * Any other value (including a non-null empty string) must be a parseable
 * date string — a malformed or empty-but-non-null value throws rather than
 * silently being treated as an open bound.
 */
export function intervalOverlapsPeriod(
  assignedAt: string | null | undefined,
  revokedAt: string | null | undefined,
  period: string
): boolean {
  const { start, end } = cycleBoundsUtc(period);
  const periodStart = Date.parse(start);
  const periodEnd = Date.parse(end);

  const assignedMs = assignedAt == null ? -Infinity : Date.parse(assignedAt);
  const revokedMs = revokedAt == null ? Infinity : Date.parse(revokedAt);

  if (Number.isNaN(assignedMs)) {
    throw new Error(`Invalid assignedAt date: "${assignedAt}"`);
  }
  if (Number.isNaN(revokedMs)) {
    throw new Error(`Invalid revokedAt date: "${revokedAt}"`);
  }

  return assignedMs < periodEnd && revokedMs > periodStart;
}

/** Options for {@link earliestRecoverablePeriod}. */
export interface EarliestRecoverablePeriodOptions {
  /** ISO date/datetime strings of available monthly snapshot files, if any. */
  snapshotDates?: string[];
  /** ISO date/datetime strings of available audit archive files, if any. */
  archiveDates?: string[];
  /** Configured audit log retention window, in days. */
  auditRetentionDays: number;
  now?: Date;
}

/**
 * Determine the earliest "YYYY-MM" period that can still be reconstructed,
 * given the configured audit retention window and any available monthly
 * snapshot/archive files (which may extend recoverability further back than
 * the live audit log retention window covers).
 *
 * Returns `null` when nothing is recoverable (no snapshots/archives and a
 * zero/negative retention window).
 *
 * Throws if any provided `snapshotDates`/`archiveDates` entry fails to parse
 * as a date, rather than silently skipping it — a malformed date here would
 * otherwise cause recoverability to be silently understated.
 */
export function earliestRecoverablePeriod(options: EarliestRecoverablePeriodOptions): string | null {
  const { snapshotDates = [], archiveDates = [], auditRetentionDays, now = new Date() } = options;

  const allDates = [...snapshotDates, ...archiveDates];
  let earliestFromFiles: YearMonth | null = null;
  for (const dateStr of allDates) {
    const ms = Date.parse(dateStr);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid snapshot/archive date: "${dateStr}"`);
    }
    const d = new Date(ms);
    const ym: YearMonth = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    if (!earliestFromFiles || monthIndex(ym) < monthIndex(earliestFromFiles)) {
      earliestFromFiles = ym;
    }
  }

  const retentionCutoffMs = now.getTime() - auditRetentionDays * 24 * 60 * 60 * 1000;
  const hasRetention = auditRetentionDays > 0;
  const retentionCutoff: YearMonth | null = hasRetention
    ? {
        year: new Date(retentionCutoffMs).getUTCFullYear(),
        month: new Date(retentionCutoffMs).getUTCMonth() + 1,
      }
    : null;

  if (!earliestFromFiles && !retentionCutoff) {
    return null;
  }
  if (!earliestFromFiles) {
    return formatYearMonth(retentionCutoff as YearMonth);
  }
  if (!retentionCutoff) {
    return formatYearMonth(earliestFromFiles);
  }

  const earliest =
    monthIndex(earliestFromFiles) <= monthIndex(retentionCutoff) ? earliestFromFiles : retentionCutoff;
  return formatYearMonth(earliest);
}
