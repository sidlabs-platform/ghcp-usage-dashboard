// Enterprise/org SAML identity and enterprise SCIM membership fixtures — the
// shapes `getEnterpriseIdentities()`/`getOrgIdentities()`
// (`NormalizedIdentityRecord`, copilot-identity-client.ts) and
// `getEnterpriseScimUsers()` (`NormalizedMembershipRecord`,
// copilot-membership-client.ts) return.
//
// These fixtures demonstrate: (1) an external identity that is observed but
// never promoted into a login (the obfuscated holder has no verified GitHub
// login anywhere, so `resolvedUserLogin` must stay null), and (2)
// `suspended`/`deprovisioned` account states that disagree with an
// otherwise-still-active seat (erin, frank — see seats.ts), which the
// `status_agreement` reconciliation check is designed to flag.

import type { NormalizedIdentityRecord } from "@/lib/github/copilot-identity-client";
import type { NormalizedMembershipRecord } from "@/lib/github/copilot-membership-client";
import { OBFUSCATED_GUID_LOGIN } from "./seats";

/**
 * Enterprise alpha's SAML/SCIM identity mapping. Only the obfuscated holder
 * appears here: every other alpha holder already resolves a real login
 * directly from their seat/audit trail (a higher-precedence source), so an
 * enterprise-identity entry for them would never be consulted. This entry
 * deliberately supplies an external identity but NO verified `resolvedLogin`
 * — safety-critical: it must never be promoted into `user_login`.
 */
export const ALPHA_ENTERPRISE_IDENTITIES: NormalizedIdentityRecord[] = [
  {
    identityKey: `login:${OBFUSCATED_GUID_LOGIN}`,
    githubUserId: null,
    resolvedLogin: null,
    externalIdentity: "obfuscated-holder@example.test",
    source: "enterprise_identity",
    observedAt: "2026-01-07T00:00:00.000Z",
    raw: {} as never,
  },
];

/** Enterprise alpha has no org-level SAML identity provider configured — always empty. */
export const ALPHA_ORG_IDENTITIES: NormalizedIdentityRecord[] = [];

/**
 * Enterprise alpha's enterprise SCIM membership records: erin is
 * `suspended` (identity-provider deactivated, GitHub link retained) and
 * frank is `deprovisioned` (GitHub link severed) — while both of their
 * seats (see seats.ts) still show `active`, a genuine data-quality
 * disagreement the reconciliation checks must surface, never silently
 * resolve either way.
 */
export const ALPHA_SCIM_MEMBERSHIP: NormalizedMembershipRecord[] = [
  {
    identityKey: "scim:alpha-erin-1",
    githubUserId: 105,
    observedLogin: "erin",
    externalIdentity: "erin@example.test",
    accountState: "suspended",
    source: "scim_enterprise",
    observedAt: "2026-03-01T00:00:00.000Z",
    raw: {} as never,
  },
  {
    identityKey: "scim:alpha-frank-1",
    githubUserId: 106,
    observedLogin: null,
    externalIdentity: "frank@example.test",
    accountState: "deprovisioned",
    source: "scim_enterprise",
    observedAt: "2026-03-01T00:00:00.000Z",
    raw: {} as never,
  },
];

/**
 * Enterprise beta has no org-level SAML identity provider configured —
 * always empty (mirrors alpha's org-identity fixture).
 */
export const BETA_ORG_IDENTITIES: NormalizedIdentityRecord[] = [];
