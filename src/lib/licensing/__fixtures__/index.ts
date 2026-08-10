// Barrel export + a composed two-enterprise, three-billing-month scenario
// bundle, ready to back a `LicenseHistorySyncDeps` override set (see
// `src/lib/db/license-history-parity.integration.test.ts`).

export * from "./identifiers";
export * from "./seats";
export * from "./audit-events";
export * from "./identities";
export * from "./allowances";
export * from "./aic-consumption";
export * from "./org-billing";

import { FIXTURE_CURRENT_PERIOD, FIXTURE_ENTERPRISES, FIXTURE_NOW, FIXTURE_ORGS, FIXTURE_PERIODS } from "./identifiers";
import { ALPHA_LIVE_SEATS, BETA_LIVE_SEATS } from "./seats";
import { ALPHA_ARCHIVE_EVENTS, ALPHA_AUDIT_API_EVENTS, BETA_ARCHIVE_EVENTS, BETA_AUDIT_API_EVENTS } from "./audit-events";
import { ALPHA_ENTERPRISE_IDENTITIES, ALPHA_ORG_IDENTITIES, ALPHA_SCIM_MEMBERSHIP, BETA_ORG_IDENTITIES } from "./identities";
import { ALPHA_DATED_ALLOWANCES } from "./allowances";
import { ALPHA_AIC_CSV_RECORDS } from "./aic-consumption";
import { ALPHA_DATA_ORG_BILLING, ALPHA_ENG_ORG_BILLING, BETA_MAIN_ORG_BILLING } from "./org-billing";

/**
 * A complete, deterministic, sanitized two-enterprise scenario spanning
 * three consecutive billing months. Every named requirement in Task 12's
 * end-to-end parity test is represented somewhere in this bundle — see each
 * fixture file's own doc comments for exactly which scenario it covers.
 */
export const TWO_ENTERPRISE_SCENARIO = {
  now: FIXTURE_NOW,
  currentPeriod: FIXTURE_CURRENT_PERIOD,
  periods: FIXTURE_PERIODS,
  enterprises: {
    [FIXTURE_ENTERPRISES.ALPHA]: {
      slug: FIXTURE_ENTERPRISES.ALPHA,
      orgs: [FIXTURE_ORGS.ALPHA_ENG, FIXTURE_ORGS.ALPHA_DATA],
      liveSeats: ALPHA_LIVE_SEATS,
      auditApiEvents: ALPHA_AUDIT_API_EVENTS,
      archiveEvents: ALPHA_ARCHIVE_EVENTS,
      enterpriseIdentities: ALPHA_ENTERPRISE_IDENTITIES,
      orgIdentities: ALPHA_ORG_IDENTITIES,
      scimMembership: ALPHA_SCIM_MEMBERSHIP,
      datedAllowances: ALPHA_DATED_ALLOWANCES,
      aicCsvRecords: ALPHA_AIC_CSV_RECORDS,
      orgBilling: {
        [FIXTURE_ORGS.ALPHA_ENG]: ALPHA_ENG_ORG_BILLING,
        [FIXTURE_ORGS.ALPHA_DATA]: ALPHA_DATA_ORG_BILLING,
      },
    },
    [FIXTURE_ENTERPRISES.BETA]: {
      slug: FIXTURE_ENTERPRISES.BETA,
      orgs: [FIXTURE_ORGS.BETA_MAIN],
      liveSeats: BETA_LIVE_SEATS,
      auditApiEvents: BETA_AUDIT_API_EVENTS,
      archiveEvents: BETA_ARCHIVE_EVENTS,
      enterpriseIdentities: [],
      orgIdentities: BETA_ORG_IDENTITIES,
      scimMembership: [],
      datedAllowances: [],
      aicCsvRecords: [],
      orgBilling: {
        [FIXTURE_ORGS.BETA_MAIN]: BETA_MAIN_ORG_BILLING,
      },
    },
  },
} as const;
