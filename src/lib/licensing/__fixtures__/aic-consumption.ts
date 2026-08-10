// Per-user AI-Credit consumption fixtures — the shapes
// `fetchAicConsumptionForUsers()` returns (`aic-consumption-client.ts`) and
// the CSV-import result shape (`aic-csv-import.ts`'s `AicCsvConsumptionRecord`,
// via `importAicConsumptionCsv()`).
//
// Covers: an enterprise-wide successful batch with one isolated per-user 404
// (alpha — must NOT trigger an org fallback), an enterprise-wide capability
// failure that DOES force a per-org fallback (beta), and gross-vs-net USD
// figures spanning both a tolerable and an over-tolerance variance.

import type {
  AicConsumptionUserResult,
  FetchAicConsumptionOptions,
  FetchAicConsumptionResult,
} from "@/lib/github/aic-consumption-client";
import type { AicCsvConsumptionRecord } from "@/lib/licensing/aic-csv-import";
import { FIXTURE_ORGS } from "./identifiers";
import { OBFUSCATED_GUID_LOGIN } from "./seats";

function ok(
  userLogin: string,
  options: FetchAicConsumptionOptions,
  overrides: Partial<Extract<AicConsumptionUserResult, { status: "ok" }>["record"]> = {},
): AicConsumptionUserResult {
  return {
    status: "ok",
    userLogin,
    record: {
      billingPeriod: `${options.year}-${String(options.month).padStart(2, "0")}`,
      orgLogin: options.orgLogin ?? null,
      userLogin,
      credits: 0,
      grossUsd: 0,
      netUsd: 0,
      source: options.orgLogin ? "org_api" : "enterprise_api",
      raw: {},
      ...overrides,
    },
  };
}

/**
 * Enterprise alpha's current-period (2026-03) enterprise-wide AIC batch:
 * every holder succeeds except carol, who gets an isolated 404 (no
 * consumption on record for her yet, since her seat was only reassigned to
 * her in February) — this single per-user 404, alongside four "ok" results,
 * must never be treated as a capability-wide failure (see
 * `isCapabilityWideAicFailure` in `license-history-sync-service.ts`), so no
 * org-scoped fallback call is ever made for alpha.
 *
 * Each "ok" result explicitly carries the holder's real org (mirroring a
 * real enterprise-wide AIC response, which does report per-activity org
 * attribution) — `materializeLicensePeriodRows` joins consumption to a seat
 * row by an exact `(orgLogin, holderKey)` canonical key, so consumption
 * left org-unattributed (`orgLogin: null`) would land in a separate
 * "(unattributed)" row instead of the holder's real seat row.
 *
 * Erin's gross ($5.00) vs. net ($3.00) figures diverge by 40% — well beyond
 * the default 5% reconciliation tolerance. Note, however, that the sync
 * orchestrator currently always compares gross consumption against a
 * hardcoded `null` net comparator (see `license-history-sync-service.ts`'s
 * `checkAicGrossVsNet` call site), so `aic_gross_vs_net` can only ever
 * legitimately warn today, never actually fail/pass on this variance — see
 * this scenario's integration test and the final report for the exact
 * citation. `netUsd` is still captured/persisted here for realism and to
 * prove the persistence side works even though the live check does not yet
 * consume it.
 */
export function buildAlphaEnterpriseAicResult(options: FetchAicConsumptionOptions): FetchAicConsumptionResult {
  const results: AicConsumptionUserResult[] = [
    ok("alice", options, { orgLogin: FIXTURE_ORGS.ALPHA_ENG, credits: 120, grossUsd: 1.2, netUsd: 1.18 }),
    { status: "not_found", userLogin: "carol", message: "No AI-Credit consumption on record for carol this period." },
    ok("dana", options, { orgLogin: FIXTURE_ORGS.ALPHA_ENG, credits: 80, grossUsd: 0.8, netUsd: 0.8 }),
    ok("erin", options, { orgLogin: FIXTURE_ORGS.ALPHA_ENG, credits: 500, grossUsd: 5.0, netUsd: 3.0 }),
    ok("frank", options, { orgLogin: FIXTURE_ORGS.ALPHA_DATA, credits: 10, grossUsd: 0.1, netUsd: 0.098 }),
    ok(OBFUSCATED_GUID_LOGIN, options, { orgLogin: FIXTURE_ORGS.ALPHA_DATA, credits: 0, grossUsd: 0, netUsd: 0 }),
  ];
  return { results, source: "enterprise_api", fellBackToOrg: false };
}

/**
 * Enterprise beta's current-period enterprise-wide AIC batch: BOTH
 * requested holders (hank, iris) receive the identical "forbidden"
 * classification — a genuine capability-wide failure (every non-"not_found"
 * result shares one status), which is the *only* condition that should
 * trigger the per-org fallback below.
 */
export function buildBetaEnterpriseAicFailureResult(): FetchAicConsumptionResult {
  const results: AicConsumptionUserResult[] = [
    { status: "forbidden", userLogin: "hank", message: "AI-Credit consumption access is forbidden for hank." },
    { status: "forbidden", userLogin: "iris", message: "AI-Credit consumption access is forbidden for iris." },
  ];
  return { results, source: "enterprise_api", fellBackToOrg: false };
}

/**
 * Enterprise beta's per-org fallback for `beta-main`, triggered only after
 * the enterprise-wide failure above. Both holders succeed here.
 */
export function buildBetaOrgFallbackAicResult(options: FetchAicConsumptionOptions): FetchAicConsumptionResult {
  const results: AicConsumptionUserResult[] = [
    ok("hank", options, { credits: 50, grossUsd: 0.5, netUsd: 0.49 }),
    ok("iris", options, { credits: 200, grossUsd: 2.0, netUsd: 1.95 }),
  ];
  return { results, source: "org_api", fellBackToOrg: true };
}

/**
 * Historical (pre-current-period) AI-Credit consumption for enterprise
 * alpha, backfilled entirely via a configured CSV import — the *only*
 * source that can ever cover a non-current period, since the per-user API
 * is current-period-only (see `FetchAicConsumptionOptions`'s `year`/`month`,
 * always the sync's current period in production). Demonstrates source
 * precedence: a configured CSV import always outranks the (here, entirely
 * absent for historical periods) API/billing-report sources.
 */
export const ALPHA_AIC_CSV_RECORDS: AicCsvConsumptionRecord[] = [
  { billingPeriod: "2026-01", orgLogin: FIXTURE_ORGS.ALPHA_ENG, userLogin: "alice", credits: 100, grossUsd: 1.0, netUsd: 0.98, source: "csv_import", raw: {} },
  { billingPeriod: "2026-02", orgLogin: FIXTURE_ORGS.ALPHA_ENG, userLogin: "alice", credits: 150, grossUsd: 1.5, netUsd: 1.47, source: "csv_import", raw: {} },
  { billingPeriod: "2026-02", orgLogin: FIXTURE_ORGS.ALPHA_ENG, userLogin: "carol", credits: 30, grossUsd: 0.3, netUsd: 0.29, source: "csv_import", raw: {} },
];
