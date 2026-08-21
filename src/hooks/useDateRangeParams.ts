"use client";

import { useCallback, useMemo } from "react";
import { useDateRange } from "@/contexts/DateRangeContext";
import { periodLabel } from "@/lib/date/month-range";

/** Query params that describe the active window, ready to merge into a request. */
export interface DateRangeQuery {
  readonly [key: string]: string;
}

export interface UseDateRangeParamsResult {
  /**
   * The active window as query params. Carries explicit `startDate`/`endDate`
   * for month and custom ranges, and `days` for a rolling preset.
   */
  dateParams: DateRangeQuery;
  /** Merge the date params with scope (or any other) params into one query. */
  buildParams: (extra?: URLSearchParams | Record<string, string>) => URLSearchParams;
  /** Human-readable window description, for export metadata and captions. */
  dateLabel: string;
  /** Stable, filesystem-safe suffix for export filenames. */
  filenameSuffix: string;
  /** Selected calendar period ("YYYY-MM"), or null. Billing surfaces send this as `period`. */
  period: string | null;
  mode: "preset" | "custom" | "month";
  days: number;
  startDate: string;
  endDate: string;
}

/**
 * Translate the app-wide date selection into API query params.
 *
 * A rolling preset is sent as `days`, because that is what it means: the last
 * N days ending yesterday, recomputed per request. A month or a custom range is
 * sent as explicit `startDate`/`endDate` bounds.
 *
 * That distinction is the whole point of this hook. In month mode
 * `DateRangeContext` reports `days` as the *span* of the selected month, so a
 * page that forwarded only `days` turned "March 2026" into "the last 31 days
 * ending yesterday" — a different window, silently, with no visible error.
 * Routing every page through one builder makes that class of bug impossible to
 * reintroduce one page at a time.
 */
export function useDateRangeParams(): UseDateRangeParamsResult {
  const { mode, days, startDate, endDate, period } = useDateRange();

  const dateParams = useMemo<DateRangeQuery>(() => {
    if (mode !== "preset" && startDate && endDate) {
      const params: DateRangeQuery = { startDate, endDate };
      return params;
    }
    const params: DateRangeQuery = { days: String(days) };
    return params;
  }, [mode, days, startDate, endDate]);

  const buildParams = useCallback(
    (extra?: URLSearchParams | Record<string, string>) => {
      const params = new URLSearchParams(dateParams);
      if (extra instanceof URLSearchParams) {
        extra.forEach((value, key) => params.set(key, value));
      } else if (extra) {
        for (const [key, value] of Object.entries(extra)) params.set(key, value);
      }
      return params;
    },
    [dateParams],
  );

  const dateLabel = useMemo(() => {
    if (mode === "month" && period) return periodLabel(period);
    if (mode === "custom" && startDate && endDate) return `${startDate} to ${endDate}`;
    return `Last ${days} day${days === 1 ? "" : "s"}`;
  }, [mode, period, startDate, endDate, days]);

  const filenameSuffix = useMemo(() => {
    if (mode === "month" && period) return period;
    if (mode === "custom" && startDate && endDate) return `${startDate}_${endDate}`;
    return `${days}d`;
  }, [mode, period, startDate, endDate, days]);

  return { dateParams, buildParams, dateLabel, filenameSuffix, period, mode, days, startDate, endDate };
}
