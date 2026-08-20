/**
 * URL serialization and deserialization for dashboard filter state.
 *
 * URL shape:
 *   - Preset date range:  ?range=28d
 *   - Month date range:   ?range=2026-08
 *   - Custom date range:  ?from=2026-08-01&to=2026-08-15
 *   - Scope filters:      ?enterprises=foo&entteams=foo:bar&orgteams=baz:qux&orgs=org1
 *
 * The scope params use `entteams` / `orgteams` (separate from the API's
 * combined `teams=`) so that enterprise-team vs org-team membership can be
 * restored exactly without needing `filterOptions` to already be loaded.
 *
 * All parse functions are defensive: malformed or missing params return null /
 * empty arrays and must never throw.
 */

import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";
import { MAX_DAYS } from "@/lib/utils";
import { isValidPeriod, periodOf } from "@/lib/date/month-range";

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

/** Parsed date-range state recovered from URL search params. */
export interface DateRangeURLState {
  mode: "preset" | "custom" | "month";
  days: number;
  customStart: string;
  customEnd: string;
  month: string;
}

const PRESET_RE = /^(\d+)d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the date-range portion of a URL into internal state.
 * Returns `null` when no recognizable params are present (caller uses defaults).
 * Malformed values are silently ignored and also return `null`.
 */
export function parseDateRangeFromURL(
  searchParams: URLSearchParams,
): DateRangeURLState | null {
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const range = searchParams.get("range");

  // Custom range: ?from=...&to=...
  if (from && to) {
    if (DATE_RE.test(from) && DATE_RE.test(to) && from <= to) {
      const ms =
        Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
      if (!Number.isNaN(ms)) {
        const spanDays = Math.round(ms / 86_400_000) + 1;
        if (spanDays >= 1 && spanDays <= MAX_DAYS) {
          return {
            mode: "custom",
            days: DEFAULT_DATE_RANGE_DAYS,
            customStart: from,
            customEnd: to,
            month: periodOf(new Date()),
          };
        }
      }
    }
    return null;
  }

  if (!range) return null;

  // Month: ?range=2026-08
  if (isValidPeriod(range)) {
    return {
      mode: "month",
      days: DEFAULT_DATE_RANGE_DAYS,
      customStart: "",
      customEnd: "",
      month: range,
    };
  }

  // Preset: ?range=28d
  const presetMatch = PRESET_RE.exec(range);
  if (presetMatch) {
    const d = parseInt(presetMatch[1], 10);
    if (!Number.isNaN(d) && d >= 1 && d <= MAX_DAYS) {
      return {
        mode: "preset",
        days: d,
        customStart: "",
        customEnd: "",
        month: periodOf(new Date()),
      };
    }
  }

  return null;
}

/**
 * Serialize date-range state to URL param updates.
 *
 * Returns a record of key→value (or null to delete) suitable for passing to
 * `applyParamsToURL`. Omits the `range` param entirely when at the default
 * so clean URLs stay clean.
 */
export function serializeDateRangeToURL(
  mode: "preset" | "custom" | "month",
  days: number,
  customStart: string,
  customEnd: string,
  month: string,
): Record<string, string | null> {
  if (mode === "month") {
    return { range: month, from: null, to: null };
  }
  if (mode === "custom" && customStart && customEnd) {
    return { range: null, from: customStart, to: customEnd };
  }
  // Preset — omit when at default to keep URLs clean
  const rangeValue = days === DEFAULT_DATE_RANGE_DAYS ? null : `${days}d`;
  return { range: rangeValue, from: null, to: null };
}

// ---------------------------------------------------------------------------
// Scope filter
// ---------------------------------------------------------------------------

/** Parsed scope filter state recovered from URL search params. */
export interface ScopeURLState {
  enterprises: string[];
  entTeams: string[];
  orgTeams: string[];
  orgs: string[];
}

function splitComma(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse scope filters from URL search params.
 * Always returns a valid (possibly empty) state — never throws.
 */
export function parseScopeFromURL(searchParams: URLSearchParams): ScopeURLState {
  return {
    enterprises: splitComma(searchParams.get("enterprises")),
    entTeams: splitComma(searchParams.get("entteams")),
    orgTeams: splitComma(searchParams.get("orgteams")),
    orgs: splitComma(searchParams.get("orgs")),
  };
}

/**
 * Serialize scope filter state to URL param updates.
 * Null values will cause the key to be removed from the URL.
 */
export function serializeScopeToURL(
  enterprises: string[],
  entTeams: string[],
  orgTeams: string[],
  orgs: string[],
): Record<string, string | null> {
  return {
    enterprises: enterprises.length ? enterprises.join(",") : null,
    entteams: entTeams.length ? entTeams.join(",") : null,
    orgteams: orgTeams.length ? orgTeams.join(",") : null,
    orgs: orgs.length ? orgs.join(",") : null,
  };
}

// ---------------------------------------------------------------------------
// Utility: merge param updates into an existing URLSearchParams
// ---------------------------------------------------------------------------

/**
 * Apply a set of key→value updates onto a copy of `existing`, returning the
 * resulting URLSearchParams. Passing `null` for a value removes the key.
 * Unrelated params in `existing` are preserved unchanged.
 */
export function applyParamsToURL(
  existing: URLSearchParams,
  updates: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(existing.toString());
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return next;
}
