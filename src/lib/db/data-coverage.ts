import { getDb } from "./database";

/**
 * Which synced day range actually backs a metric, and how much of a requested
 * window it covers.
 *
 * The dashboard's date selector offers any month, but the local database only
 * holds what has been synced — usage metrics typically reach back ~90 days
 * while billing reaches back a year or more. Asking for a month outside that
 * range previously rendered a page of confident zeros that were indistinguishable
 * from "nobody used Copilot". Worse, the two sources disagree about whether a
 * period exists at all: a month can show real billing cost beside zero active
 * users, which reads as a fleet paying for nothing.
 *
 * This turns "no rows" into an explicit, reportable fact.
 */
export interface DataCoverage {
  /** Earliest synced day (YYYY-MM-DD), or null when the source is empty. */
  earliest: string | null;
  /** Latest synced day (YYYY-MM-DD), or null when the source is empty. */
  latest: string | null;
  /** Days of the requested window that fall inside the synced range. */
  daysCovered: number;
  /** Length of the requested window in days. */
  daysRequested: number;
  /** True when no part of the requested window is synced. */
  isEmpty: boolean;
  /** True when the window is only partly synced — the usual cause of a misleading dip. */
  isPartial: boolean;
}

function daysBetweenInclusive(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.floor((e - s) / 86_400_000) + 1;
}

function tableExists(table: string): boolean {
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  return !!row;
}

/**
 * Coverage of one day-keyed table against a requested window.
 *
 * Reads MIN/MAX over the whole table rather than counting rows inside the
 * window, so the answer distinguishes "this period was never synced" from
 * "this period was synced and genuinely had no activity" — the two look
 * identical in the data but mean opposite things to a reader.
 *
 * Returns a fully-zero result rather than throwing when the table is absent,
 * so a database synced before a feature existed degrades instead of erroring.
 */
export function getDataCoverage(
  table: string,
  dayColumn: string,
  start: string,
  end: string,
): DataCoverage {
  const daysRequested = daysBetweenInclusive(start, end);
  const empty: DataCoverage = {
    earliest: null,
    latest: null,
    daysCovered: 0,
    daysRequested,
    isEmpty: true,
    isPartial: false,
  };

  if (!tableExists(table)) return empty;

  // Table and column names are caller-supplied constants, never user input.
  const row = getDb()
    .prepare(`SELECT MIN(${dayColumn}) AS earliest, MAX(${dayColumn}) AS latest FROM ${table}`)
    .get() as { earliest: string | null; latest: string | null } | undefined;

  if (!row?.earliest || !row?.latest) return empty;

  const overlapStart = start > row.earliest ? start : row.earliest;
  const overlapEnd = end < row.latest ? end : row.latest;
  const daysCovered = overlapEnd >= overlapStart ? daysBetweenInclusive(overlapStart, overlapEnd) : 0;

  return {
    earliest: row.earliest,
    latest: row.latest,
    daysCovered,
    daysRequested,
    isEmpty: daysCovered === 0,
    isPartial: daysCovered > 0 && daysCovered < daysRequested,
  };
}

/** Coverage of user-level usage metrics — the source behind most dashboard KPIs. */
export function getUsageCoverage(start: string, end: string): DataCoverage {
  return getDataCoverage("user_daily_metrics", "day", start, end);
}
