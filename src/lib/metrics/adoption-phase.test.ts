import { describe, it, expect } from "vitest";
import {
  resolvePhaseNumber,
  phaseLabel,
  normalizePhaseTotals,
  parsePhaseTotals,
  PHASE_LABELS,
} from "./adoption-phase";

// ── resolvePhaseNumber ────────────────────────────────────────────────

describe("resolvePhaseNumber", () => {
  it("passes through finite numbers", () => {
    expect(resolvePhaseNumber(0)).toBe(0);
    expect(resolvePhaseNumber(3)).toBe(3);
  });

  it("rejects non-finite numbers rather than producing a NaN bucket", () => {
    expect(resolvePhaseNumber(NaN)).toBeNull();
    expect(resolvePhaseNumber(Infinity)).toBeNull();
  });

  it("parses the current API's display strings", () => {
    expect(resolvePhaseNumber("Phase 1")).toBe(1);
    expect(resolvePhaseNumber("Phase 2")).toBe(2);
    expect(resolvePhaseNumber("Phase 3")).toBe(3);
  });

  it("maps the zero cohort in any casing or separator", () => {
    expect(resolvePhaseNumber("No Cohort")).toBe(0);
    expect(resolvePhaseNumber("No cohort")).toBe(0);
    expect(resolvePhaseNumber("no-cohort")).toBe(0);
    expect(resolvePhaseNumber("no_cohort")).toBe(0);
  });

  it("parses numeric strings and tolerates surrounding whitespace", () => {
    expect(resolvePhaseNumber("2")).toBe(2);
    expect(resolvePhaseNumber("  Phase 3  ")).toBe(3);
  });

  it("returns null for values it cannot resolve", () => {
    expect(resolvePhaseNumber(null)).toBeNull();
    expect(resolvePhaseNumber(undefined)).toBeNull();
    expect(resolvePhaseNumber("")).toBeNull();
    expect(resolvePhaseNumber("   ")).toBeNull();
    expect(resolvePhaseNumber("Multi-agent")).toBeNull();
    expect(resolvePhaseNumber({})).toBeNull();
  });
});

// ── phaseLabel ────────────────────────────────────────────────────────

describe("phaseLabel", () => {
  it("returns the canonical descriptive names", () => {
    expect(phaseLabel(0)).toBe("No cohort");
    expect(phaseLabel(1)).toBe("Code first");
    expect(phaseLabel(2)).toBe("Agent first");
    expect(phaseLabel(3)).toBe("Multi-agent");
  });

  it("never renders NaN for an unresolved phase", () => {
    expect(phaseLabel(null)).toBe("Unknown phase");
    expect(phaseLabel(undefined)).toBe("Unknown phase");
    expect(phaseLabel(NaN)).toBe("Unknown phase");
  });

  it("falls back to the bare number for a phase the API adds later", () => {
    expect(phaseLabel(4)).toBe("Phase 4");
  });

  it("covers every documented phase", () => {
    expect(Object.keys(PHASE_LABELS)).toEqual(["0", "1", "2", "3"]);
  });
});

// ── normalizePhaseTotals ──────────────────────────────────────────────

describe("normalizePhaseTotals", () => {
  it("normalizes the current enterprise shape", () => {
    const result = normalizePhaseTotals({
      phase: "Phase 2",
      phase_number: 2,
      total_engaged_users: 218,
      avg_user_initiated_interactions: 35.84,
      avg_code_generation_activities: 51.99,
      avg_code_acceptance_activities: 41.12,
      avg_loc_added: 2130.66,
      avg_loc_deleted: 338.5,
      avg_pull_requests_created: 0.01,
      avg_pull_requests_merged: 0,
      avg_pull_requests_reviewed: 0,
      avg_pull_requests_median_minutes_to_merge: 10.53,
      total_pull_requests_merged: 1,
    });

    expect(result).not.toBeNull();
    expect(result!.phase).toBe(2);
    expect(result!.label).toBe("Agent first");
    expect(result!.engaged_users).toBe(218);
    expect(result!.user_initiated_interaction_avg).toBe(35.84);
    expect(result!.code_generation_activity_avg).toBe(51.99);
    expect(result!.code_acceptance_activity_avg).toBe(41.12);
    expect(result!.loc_added_avg).toBe(2130.66);
    expect(result!.loc_deleted_avg).toBe(338.5);
    expect(result!.pull_requests_created_avg).toBe(0.01);
    expect(result!.median_minutes_to_merge_avg).toBe(10.53);
    expect(result!.total_pull_requests_merged).toBe(1);
  });

  it("normalizes the legacy enterprise shape", () => {
    const result = normalizePhaseTotals({
      phase: 3,
      label: "Multi-agent",
      version: "v1",
      engaged_users: 725,
      user_initiated_interaction_avg: 15.04,
      code_generation_activity_avg: 60.09,
      code_acceptance_activity_avg: 48.54,
      loc_added_avg: 2855.28,
      loc_deleted_avg: 700.01,
      pull_requests_created_avg: 0.11,
      pull_requests_merged_avg: 0.03,
      pull_requests_reviewed_avg: 0.02,
      median_minutes_to_merge_avg: 2,
    });

    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.label).toBe("Multi-agent");
    expect(result!.engaged_users).toBe(725);
    expect(result!.loc_added_avg).toBe(2855.28);
    expect(result!.pull_requests_merged_avg).toBe(0.03);
  });

  it("resolves the zero cohort from the string form", () => {
    const result = normalizePhaseTotals({ phase: "No Cohort", total_engaged_users: 73 });
    expect(result!.phase).toBe(0);
    expect(result!.label).toBe("No cohort");
    expect(result!.engaged_users).toBe(73);
  });

  it("prefers phase_number when the two disagree", () => {
    const result = normalizePhaseTotals({ phase: "Phase 9", phase_number: 2 });
    expect(result!.phase).toBe(2);
  });

  it("drops an entry whose phase cannot be resolved", () => {
    expect(normalizePhaseTotals({ phase: "something else" })).toBeNull();
    expect(normalizePhaseTotals({})).toBeNull();
  });

  it("defaults missing numeric fields to 0, not NaN", () => {
    const result = normalizePhaseTotals({ phase_number: 1 })!;
    expect(result.engaged_users).toBe(0);
    expect(result.loc_added_avg).toBe(0);
    expect(Number.isNaN(result.code_generation_activity_avg)).toBe(false);
  });

  it("leaves total_pull_requests_merged undefined when absent", () => {
    const result = normalizePhaseTotals({ phase_number: 1 })!;
    expect(result.total_pull_requests_merged).toBeUndefined();
  });

  it("preserves an explicit zero merge count", () => {
    const result = normalizePhaseTotals({ phase_number: 1, total_pull_requests_merged: 0 })!;
    expect(result.total_pull_requests_merged).toBe(0);
  });

  it("reports median_minutes_to_merge_avg as null when absent", () => {
    const result = normalizePhaseTotals({ phase_number: 1 })!;
    expect(result.median_minutes_to_merge_avg).toBeNull();
  });
});

// ── parsePhaseTotals ──────────────────────────────────────────────────

describe("parsePhaseTotals", () => {
  it("parses and sorts a current-shape column by phase", () => {
    const json = JSON.stringify([
      { phase: "Phase 3", phase_number: 3, total_engaged_users: 725 },
      { phase: "No Cohort", phase_number: 0, total_engaged_users: 73 },
      { phase: "Phase 1", phase_number: 1, total_engaged_users: 41 },
    ]);

    const result = parsePhaseTotals(json);
    expect(result.map((p) => p.phase)).toEqual([0, 1, 3]);
    expect(result.map((p) => p.label)).toEqual(["No cohort", "Code first", "Multi-agent"]);
    expect(result.map((p) => p.engaged_users)).toEqual([73, 41, 725]);
  });

  it("returns an empty array for null, empty, and malformed input", () => {
    expect(parsePhaseTotals(null)).toEqual([]);
    expect(parsePhaseTotals(undefined)).toEqual([]);
    expect(parsePhaseTotals("")).toEqual([]);
    expect(parsePhaseTotals("[]")).toEqual([]);
    expect(parsePhaseTotals("not json")).toEqual([]);
    expect(parsePhaseTotals('{"phase":1}')).toEqual([]);
  });

  it("skips unusable entries instead of failing the whole column", () => {
    const json = JSON.stringify([
      { phase: "Phase 1", total_engaged_users: 10 },
      null,
      "garbage",
      { phase: "not a phase" },
      { phase: "Phase 2", total_engaged_users: 20 },
    ]);

    const result = parsePhaseTotals(json);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.phase)).toEqual([1, 2]);
  });
});
