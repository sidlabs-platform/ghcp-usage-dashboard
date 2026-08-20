import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(value: number): string {
  if (value == null || typeof value !== 'number' || isNaN(value)) return "0";
  // Use 999_950 as the K→M boundary: any value that would round to "1000.0K"
  // (i.e. value/1000 ≥ 999.95, meaning value ≥ 999_950) is promoted to M.
  if (value >= 999_950) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000)   return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function formatPercent(value: number, decimals = 1): string {
  if (value == null || typeof value !== 'number' || isNaN(value)) return "0%";
  return `${value.toFixed(decimals)}%`;
}

export function formatDelta(current: number, previous: number): { value: string; positive: boolean } {
  if (previous == null || typeof previous !== 'number' || previous === 0) return { value: "N/A", positive: true };
  if (current == null || typeof current !== 'number') return { value: "N/A", positive: true };
  const delta = ((current - previous) / previous) * 100;
  return {
    value: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
    positive: delta >= 0,
  };
}

export function formatMinutes(minutes: number): string {
  if (minutes == null || typeof minutes !== 'number' || isNaN(minutes)) return "0m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

/**
 * Safely coerce a value to a number, returning `fallback` (default 0) when
 * the input is null, undefined, or NaN.
 */
export function safeNum(v: unknown, fallback = 0): number {
  if (v == null || typeof v !== 'number' || isNaN(v)) return fallback;
  return v;
}

/** Maximum allowed value for the `days` query parameter. */
export const MAX_DAYS = 365;

/**
 * Parse and validate the `days` query parameter.
 * Returns a clamped value in [1, MAX_DAYS] or an error string.
 * Returns 400-worthy error if the raw value is invalid or exceeds the cap.
 */
export function parseAndClampDays(
  raw: string | null,
  defaultValue = 7,
): { days: number } | { error: string } {
  const parsed = raw != null ? Number(raw) : defaultValue;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { error: `Invalid days parameter: value must be a positive integer (got "${raw}").` };
  }
  if (parsed > MAX_DAYS) {
    return {
      error: `days parameter exceeds maximum allowed value of ${MAX_DAYS} (got ${parsed}). Please use a smaller date range.`,
    };
  }
  return { days: Math.floor(parsed) };
}

export function getDateRange(days: number): { start: string; end: string } {
  const end = new Date();
  end.setDate(end.getDate() - 1); // yesterday (latest available)
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}

export function datesBetween(startDay: string, endDay: string): string[] {
  const dates: string[] = [];
  const current = new Date(startDay);
  const end = new Date(endDay);
  while (current <= end) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse date-range query params. Accepts either `days` OR explicit
 * `startDate` + `endDate` (YYYY-MM-DD). Returns `{ start, end }` on
 * success or `{ error }` on validation failure.
 *
 * When both `days` and `startDate`/`endDate` are provided, explicit
 * dates take precedence.
 */
export function parseDateRangeParams(
  params: URLSearchParams,
  defaultDays = 7,
): { start: string; end: string } | { error: string } {
  const rawStart = params.get("startDate");
  const rawEnd = params.get("endDate");

  if (rawStart || rawEnd) {
    if (!rawStart || !rawEnd) {
      return { error: "Both startDate and endDate must be provided together." };
    }
    if (!DATE_RE.test(rawStart) || !DATE_RE.test(rawEnd)) {
      return { error: "startDate and endDate must be in YYYY-MM-DD format." };
    }
    const s = new Date(rawStart);
    const e = new Date(rawEnd);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      return { error: "startDate or endDate is not a valid date." };
    }
    if (s > e) {
      return { error: "startDate must be on or before endDate." };
    }
    const diffDays = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    if (diffDays > MAX_DAYS) {
      return {
        error: `Date range spans ${diffDays} days, which exceeds the maximum of ${MAX_DAYS}.`,
      };
    }
    // Reject future end dates — data is only available up to yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    if (e > yesterday) {
      return { error: "endDate cannot be in the future. Latest available data is from yesterday." };
    }
    return { start: rawStart, end: rawEnd };
  }

  // Fall back to `days` param
  const daysResult = parseAndClampDays(params.get("days"), defaultDays);
  if ("error" in daysResult) return daysResult;
  return getDateRange(daysResult.days);
}
