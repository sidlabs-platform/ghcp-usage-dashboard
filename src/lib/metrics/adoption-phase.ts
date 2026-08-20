/**
 * Normalization for AI adoption phase data.
 *
 * The GitHub Copilot usage metrics API has shipped this data under two
 * different shapes, and a dashboard holding already-synced rows can contain
 * either. Nothing downstream should branch on which one it got, so every read
 * path funnels through this module.
 *
 * Current shape (what the API returns today):
 *   user-level        `{ "phase_number": 3, "phase": "Phase 3", "version": "v1" }`
 *   enterprise-level  `{ "phase": "No Cohort", "phase_number": 0,
 *                        "total_engaged_users": 73,
 *                        "avg_user_initiated_interactions": 4.56, ... }`
 *
 * Legacy shape (what the original integration was written against):
 *   user-level        `{ "phase": 3, "label": "Multi-agent", "version": "v1" }`
 *   enterprise-level  `{ "phase": 0, "label": "No cohort",
 *                        "engaged_users": 73,
 *                        "user_initiated_interaction_avg": 4.56, ... }`
 *
 * Note that `phase` means different things in the two shapes — a number in the
 * legacy one, a display string in the current one. Reading it as a numeric key
 * against current data yields `NaN` buckets and silently zeroed metrics, so
 * always resolve it through {@link resolvePhaseNumber}.
 */

import type { TotalsByAIAdoptionPhase } from "@/lib/types/metrics";

/**
 * Canonical, human-meaningful phase names.
 *
 * Preferred over the API's own `phase` string ("Phase 2"), which names the
 * cohort without saying what it means. Phase 1 is code-completion / IDE agent
 * usage, phase 2 a single GitHub agent surface, phase 3 two or more.
 */
export const PHASE_LABELS: Record<number, string> = {
  0: "No cohort",
  1: "Code first",
  2: "Agent first",
  3: "Multi-agent",
};

/** Highest phase number the API currently defines. */
export const MAX_PHASE = 3;

/**
 * Resolve a phase identifier from either shape into its number.
 *
 * Accepts an integer (`2`), a numeric string (`"2"`), the current API's
 * display string (`"Phase 2"`), and the zero-cohort spelling in either casing
 * (`"No Cohort"` / `"No cohort"`). The grammar is deliberately ASCII-only
 * because the upstream API emits ASCII phase values; exotic Unicode whitespace
 * is rejected rather than normalized. Returns `null` for anything else so
 * callers can drop the row rather than fold it into a bogus bucket.
 */
export function resolvePhaseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = trimAsciiPhaseWhitespace(value);
  if (trimmed === "") return null;

  // "2"
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // "Phase 2"
  const match = /^phase[\t\n\v\f\r ]*(\d+)$/i.exec(trimmed);
  if (match) return Number(match[1]);

  // "No Cohort" / "No cohort" / "no-cohort"
  if (/^no[\t\n\v\f\r _-]*cohort$/i.test(trimmed)) return 0;

  return null;
}

const ASCII_PHASE_EDGE_WHITESPACE_RE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

function trimAsciiPhaseWhitespace(value: string): string {
  return value.replace(ASCII_PHASE_EDGE_WHITESPACE_RE, "");
}

const ASCII_WHITESPACE_SQL_CHARS = [
  "char(9)",
  "char(10)",
  "char(11)",
  "char(12)",
  "char(13)",
  "' '",
];
const ASCII_WHITESPACE_SQL = ASCII_WHITESPACE_SQL_CHARS.join("||");

function trimAsciiWhitespaceSql(value: string): string {
  return `trim(${value},${ASCII_WHITESPACE_SQL})`;
}

function ltrimAsciiWhitespaceSql(value: string): string {
  return `ltrim(${value},${ASCII_WHITESPACE_SQL})`;
}

function removeAsciiWhitespaceSql(value: string): string {
  return ASCII_WHITESPACE_SQL_CHARS.reduce(
    (expression, char) => `replace(${expression}, ${char}, '')`,
    value,
  );
}

function removeNoCohortMiddleSeparatorsSql(value: string): string {
  return `replace(replace(${removeAsciiWhitespaceSql(value)}, '-', ''), '_', '')`;
}

/** Display name for a phase, falling back to the bare number if unrecognized. */
export function phaseLabel(phase: number | null | undefined): string {
  if (phase == null || !Number.isInteger(phase)) return "Unknown phase";
  return PHASE_LABELS[phase] ?? `Phase ${phase}`;
}

/**
 * SQL expression resolving `<column>`'s adoption phase to an INTEGER, applying
 * the same grammar as {@link resolvePhaseNumber}. The explicit `phase_number`
 * is used first when present and non-null; otherwise `phase` is resolved as an
 * integer, a numeric string, `"Phase N"` with optional ASCII whitespace before
 * `N`, or `"No Cohort"` with optional ASCII whitespace, hyphens, or underscores.
 * The upstream API emits ASCII phase values, so SQL intentionally mirrors the
 * narrower JS grammar rather than paying per row to normalize every ECMAScript
 * whitespace code point. Evaluates to NULL when none match, so callers can
 * filter the row out with a plain `IS NOT NULL`.
 *
 * Kept as a shared fragment rather than inlined, so the JS and SQL paths cannot
 * drift apart.
 */
export function phaseNumberSql(column: string): string {
  const phaseNumberPresent = "a IS NOT NULL AND a<>'null'";
  const phaseSuffix = ltrimAsciiWhitespaceSql("substr(lower(z),6)");
  const noCohortMiddle = removeNoCohortMiddleSeparatorsSql(
    "substr(lower(z),3,length(lower(z))-8)",
  );

  return `(WITH r(a,b,c,d) AS (
    SELECT json_type(${column},'$.phase_number'),json_extract(${column},'$.phase_number'),
           json_type(${column},'$.phase'),json_extract(${column},'$.phase')
  ), x(t,v) AS (
    SELECT CASE WHEN ${phaseNumberPresent} THEN a ELSE c END,
           CASE WHEN ${phaseNumberPresent} THEN b ELSE d END FROM r
  ), s(t,v,z) AS (
    SELECT t,v,${trimAsciiWhitespaceSql("v")} FROM x
  ), n(t,v,z,l,p,q) AS (
    SELECT t,v,z,lower(z),${phaseSuffix},${noCohortMiddle} FROM s
  )
  SELECT CASE
    WHEN t IN ('integer','real') AND CAST(v AS INTEGER)=v THEN CAST(v AS INTEGER)
    WHEN t='text' AND z<>'' AND z NOT GLOB '*[^0-9]*' THEN CAST(z AS INTEGER)
    WHEN t='text' AND substr(l,1,5)='phase' AND p<>'' AND p NOT GLOB '*[^0-9]*'
      THEN CAST(p AS INTEGER)
    WHEN t='text' AND length(l)>=8 AND substr(l,1,2)='no'
      AND substr(l,length(l)-5)='cohort' AND q='' THEN 0
  END FROM n)`;
}

/** A `totals_by_ai_adoption_phase` entry in either shape, before normalization. */
export interface RawPhaseTotals {
  phase?: number | string;
  phase_number?: number;
  label?: string;
  version?: string;

  // Current field names
  total_engaged_users?: number;
  avg_user_initiated_interactions?: number;
  avg_code_generation_activities?: number;
  avg_code_acceptance_activities?: number;
  avg_loc_added?: number;
  avg_loc_deleted?: number;
  avg_pull_requests_created?: number;
  avg_pull_requests_merged?: number;
  avg_pull_requests_reviewed?: number;
  avg_pull_requests_median_minutes_to_merge?: number | null;

  // Legacy field names
  engaged_users?: number;
  user_initiated_interaction_avg?: number;
  code_generation_activity_avg?: number;
  code_acceptance_activity_avg?: number;
  loc_added_avg?: number;
  loc_deleted_avg?: number;
  pull_requests_created_avg?: number;
  pull_requests_merged_avg?: number;
  pull_requests_reviewed_avg?: number;
  median_minutes_to_merge_avg?: number | null;

  // Same name in both shapes
  total_pull_requests_merged?: number;
}

/** First finite number among the candidates, else 0. */
function num(...candidates: (number | undefined)[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return 0;
}

/** First finite number among the candidates, else null (a real "no value"). */
function nullableNum(...candidates: (number | null | undefined)[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * Normalize one raw entry. Returns `null` when the phase cannot be resolved,
 * so an unrecognized cohort is dropped rather than rendered as `Phase NaN`.
 */
export function normalizePhaseTotals(raw: RawPhaseTotals): TotalsByAIAdoptionPhase | null {
  const phase = resolvePhaseNumber(raw.phase_number ?? raw.phase);
  if (phase === null) return null;

  return {
    phase,
    label: phaseLabel(phase),
    version: raw.version ?? "",
    engaged_users: num(raw.total_engaged_users, raw.engaged_users),
    user_initiated_interaction_avg: num(
      raw.avg_user_initiated_interactions,
      raw.user_initiated_interaction_avg,
    ),
    code_generation_activity_avg: num(
      raw.avg_code_generation_activities,
      raw.code_generation_activity_avg,
    ),
    code_acceptance_activity_avg: num(
      raw.avg_code_acceptance_activities,
      raw.code_acceptance_activity_avg,
    ),
    loc_added_avg: num(raw.avg_loc_added, raw.loc_added_avg),
    loc_deleted_avg: num(raw.avg_loc_deleted, raw.loc_deleted_avg),
    pull_requests_created_avg: num(raw.avg_pull_requests_created, raw.pull_requests_created_avg),
    pull_requests_merged_avg: num(raw.avg_pull_requests_merged, raw.pull_requests_merged_avg),
    pull_requests_reviewed_avg: num(raw.avg_pull_requests_reviewed, raw.pull_requests_reviewed_avg),
    median_minutes_to_merge_avg: nullableNum(
      raw.avg_pull_requests_median_minutes_to_merge,
      raw.median_minutes_to_merge_avg,
    ),
    // Absent (rather than 0) for data synced before the June 2026 API addition,
    // so `hasMergeData` can distinguish "no merges" from "field not available".
    total_pull_requests_merged:
      typeof raw.total_pull_requests_merged === "number"
        ? raw.total_pull_requests_merged
        : undefined,
  };
}

/**
 * Parse and normalize a stored `totals_by_ai_adoption_phase` JSON column.
 * Malformed JSON and unresolvable phases yield an empty array / dropped rows
 * rather than throwing, so one bad row cannot take down a page.
 */
export function parsePhaseTotals(json: string | null | undefined): TotalsByAIAdoptionPhase[] {
  if (!json) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: TotalsByAIAdoptionPhase[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const normalized = normalizePhaseTotals(entry as RawPhaseTotals);
    if (normalized) out.push(normalized);
  }
  out.sort((a, b) => a.phase - b.phase);
  return out;
}
