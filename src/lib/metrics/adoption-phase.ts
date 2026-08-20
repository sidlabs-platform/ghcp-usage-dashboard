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
 * Accepts a number (`2`), a numeric string (`"2"`), the current API's display
 * string (`"Phase 2"`), and the zero-cohort spelling in either casing
 * (`"No Cohort"` / `"No cohort"`). Returns `null` for anything else so callers
 * can drop the row rather than fold it into a bogus bucket.
 */
export function resolvePhaseNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  // "2"
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  // "Phase 2"
  const match = /^phase\s*(\d+)$/i.exec(trimmed);
  if (match) return Number(match[1]);

  // "No Cohort" / "No cohort" / "no-cohort"
  if (/^no[\s_-]*cohort$/i.test(trimmed)) return 0;

  return null;
}

/** Display name for a phase, falling back to the bare number if unrecognized. */
export function phaseLabel(phase: number | null | undefined): string {
  if (phase == null || !Number.isFinite(phase)) return "Unknown phase";
  return PHASE_LABELS[phase] ?? `Phase ${phase}`;
}

/**
 * SQL expression resolving `<column>`'s adoption phase to an INTEGER, applying
 * the same precedence as {@link resolvePhaseNumber}: the explicit
 * `phase_number` first, then `phase` as a number, then `"Phase N"`, then
 * `"No Cohort"`. Evaluates to NULL when none match, so callers can filter the
 * row out with a plain `IS NOT NULL`.
 *
 * Kept as a shared fragment rather than inlined, so the JS and SQL paths cannot
 * drift apart.
 */
export function phaseNumberSql(column: string): string {
  const phase = `json_extract(${column}, '$.phase')`;
  return `CAST(COALESCE(
    json_extract(${column}, '$.phase_number'),
    CASE
      WHEN typeof(${phase}) IN ('integer', 'real') THEN ${phase}
      WHEN ${phase} GLOB '[0-9]*' THEN ${phase}
      WHEN lower(${phase}) GLOB 'phase [0-9]*' THEN substr(${phase}, 7)
      WHEN lower(replace(${phase}, ' ', '')) = 'nocohort' THEN 0
    END
  ) AS INTEGER)`;
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
