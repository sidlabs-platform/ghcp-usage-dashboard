// Shared enterprise/org/period identifiers used across every fixture file in
// this directory. Centralized here so every scenario file stays consistent
// (the same enterprise slug always means the same enterprise) without
// re-declaring string literals everywhere.

/** Fabricated enterprise slugs — no relation to any real GitHub enterprise. */
export const FIXTURE_ENTERPRISES = {
  /** Primary scenario enterprise: active/cancelled/reassigned/multi-org/suspended/deprovisioned/unresolved holders, dated allowance change, isolated AIC 404, CSV-imported historical consumption. */
  ALPHA: "ent-alpha",
  /** Secondary scenario enterprise: enterprise-wide AIC failure -> org fallback, archive/API overlap dedupe, an unrecoverable-history holder, and a missing optional org-billing source. */
  BETA: "ent-beta",
} as const;

/** Fabricated org logins — no relation to any real GitHub organization. */
export const FIXTURE_ORGS = {
  ALPHA_ENG: "alpha-eng",
  ALPHA_DATA: "alpha-data",
  BETA_MAIN: "beta-main",
} as const;

/** Three consecutive "YYYY-MM" billing months this scenario covers. */
export const FIXTURE_PERIODS = ["2026-01", "2026-02", "2026-03"] as const;

/** The scenario's "current" period — the only period the live-seat snapshot and per-user AI-Credit API cover. */
export const FIXTURE_CURRENT_PERIOD = "2026-03";

/** Fixed "now" instant for the whole scenario, inside {@link FIXTURE_CURRENT_PERIOD}. */
export const FIXTURE_NOW = new Date("2026-03-20T00:00:00.000Z");
