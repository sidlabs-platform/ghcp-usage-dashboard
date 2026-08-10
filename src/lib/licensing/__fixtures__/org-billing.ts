// Org Copilot-billing snapshot fixtures — the shape `getOrgBilling()` returns
// (`copilot-org-billing-client.ts`'s `OrgBillingResult`). These back the
// `checkSeatCount` reconciliation check's authoritative seat-count
// comparator, and are current-period-only (mirrors the real client, which
// has no historical-period parameter).

import type { OrgBillingResult } from "@/lib/github/copilot-org-billing-client";
import { FIXTURE_CURRENT_PERIOD, FIXTURE_ORGS } from "./identifiers";

/**
 * alpha-eng's authoritative seat count (4) matches its four active current
 * holders (alice, carol, dana, erin — see seats.ts) exactly, so
 * `checkSeatCount` passes for this org.
 */
export const ALPHA_ENG_ORG_BILLING: OrgBillingResult = {
  status: "ok",
  snapshot: {
    orgLogin: FIXTURE_ORGS.ALPHA_ENG,
    billingPeriod: FIXTURE_CURRENT_PERIOD,
    planType: "business",
    totalSeats: 4,
    pendingCancellation: 0,
    observedAt: "2026-03-20T00:00:00.000Z",
    raw: {} as never,
  },
};

/**
 * alpha-data's authoritative seat count (1) substantially disagrees with
 * its three actual active current holders (dana, frank, the obfuscated
 * holder), deliberately beyond the check's default absolute/percentage
 * tolerance — `checkSeatCount` fails for this org.
 */
export const ALPHA_DATA_ORG_BILLING: OrgBillingResult = {
  status: "ok",
  snapshot: {
    orgLogin: FIXTURE_ORGS.ALPHA_DATA,
    billingPeriod: FIXTURE_CURRENT_PERIOD,
    planType: "business",
    totalSeats: 1,
    pendingCancellation: 0,
    observedAt: "2026-03-20T00:00:00.000Z",
    raw: {} as never,
  },
};

/**
 * Missing optional source: beta-main's org billing summary is unavailable
 * (e.g. the credential lacks the relevant scope, or org billing simply
 * hasn't been enabled) — `checkSeatCount` must warn ("no comparator
 * available"), never fail or throw, and the sync must still complete.
 */
export const BETA_MAIN_ORG_BILLING: OrgBillingResult = {
  status: "unavailable",
  reason: "forbidden",
  orgLogin: FIXTURE_ORGS.BETA_MAIN,
};
