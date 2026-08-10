// Live (current-period) Copilot seat fixtures — the shape
// `getEnterpriseSeatsNormalized()` returns (see `seats-client.ts`'s
// `NormalizedCopilotSeat`). These feed both the current-month authoritative
// snapshot (`exact_snapshot` confidence) and the seat-ledger's live-seat
// fallback for {@link FIXTURE_CURRENT_PERIOD}.

import type { NormalizedCopilotSeat } from "@/lib/github/seats-client";
import type { CopilotSeat } from "@/lib/types/seats";
import { FIXTURE_ORGS } from "./identifiers";

const RAW_SEAT_STUB = {} as CopilotSeat;

function makeSeat(overrides: Partial<NormalizedCopilotSeat> & Pick<NormalizedCopilotSeat, "holderKey" | "orgLogin">): NormalizedCopilotSeat {
  return {
    githubUserId: null,
    observedLogin: null,
    unresolved: false,
    planType: "business",
    assignedVia: "direct",
    lastActivityAt: "2026-03-15T00:00:00.000Z",
    lastActivityEditor: "vscode",
    pendingCancellationDate: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-15T00:00:00.000Z",
    raw: RAW_SEAT_STUB,
    ...overrides,
  };
}

/**
 * A dashless-GUID-shaped seat assignee login — the exact opaque/obfuscated
 * shape `identity-resolver.ts`'s `looksLikeRealGitHubLogin` rejects as a
 * real login (see `HEX_BLOB_RE`/`GUID_RE`). Never a real user identifier.
 */
export const OBFUSCATED_GUID_LOGIN = "9f8e7d6c5b4a3928170615243f3e2d1c";

/** Enterprise alpha's live seats for {@link FIXTURE_CURRENT_PERIOD} (2026-03). */
export const ALPHA_LIVE_SEATS: NormalizedCopilotSeat[] = [
  // active: assigned since 2026-01, never cancelled, real login throughout.
  // Deliberately login-only (no numeric GitHub user id): AI-Credit
  // consumption records (per-user API and CSV import) are always keyed
  // `login:<username>` by the sync orchestrator (see
  // `license-history-sync-service.ts`'s `consumptionRecordsWithPeriod`
  // construction) — only a holder whose own canonical `holderKey` is
  // *also* `login:`-based can ever have that consumption correctly join
  // back to their seat row. This is a real, current characteristic of the
  // orchestrator (not a fixture-side simplification) — see this test
  // file's module doc and the final report for the exact citation.
  makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: FIXTURE_ORGS.ALPHA_ENG }),
  // reassigned: this org seat slot was bob's (cancelled 2026-02), now carol's (assigned 2026-02).
  makeSeat({ holderKey: "id:103", githubUserId: 103, observedLogin: "carol", orgLogin: FIXTURE_ORGS.ALPHA_ENG }),
  // multi-org: dana holds a seat in BOTH alpha-eng and alpha-data simultaneously.
  makeSeat({ holderKey: "id:104", githubUserId: 104, observedLogin: "dana", orgLogin: FIXTURE_ORGS.ALPHA_ENG }),
  makeSeat({ holderKey: "id:104", githubUserId: 104, observedLogin: "dana", orgLogin: FIXTURE_ORGS.ALPHA_DATA, planType: "enterprise" }),
  // suspended: seat still shows active, but the enterprise SCIM record (see
  // identities.ts) reports `suspended` — a real status_agreement mismatch.
  makeSeat({ holderKey: "id:105", githubUserId: 105, observedLogin: "erin", orgLogin: FIXTURE_ORGS.ALPHA_ENG }),
  // deprovisioned: seat still shows active, but the enterprise SCIM record
  // reports `deprovisioned` — the seat has not yet been revoked upstream.
  makeSeat({ holderKey: "id:106", githubUserId: 106, observedLogin: "frank", orgLogin: FIXTURE_ORGS.ALPHA_DATA }),
  // obfuscated/unresolved: no numeric id ever observed; the assignee login
  // itself is an opaque GUID-shaped value, never a real GitHub login.
  makeSeat({
    holderKey: `login:${OBFUSCATED_GUID_LOGIN}`,
    observedLogin: OBFUSCATED_GUID_LOGIN,
    orgLogin: FIXTURE_ORGS.ALPHA_DATA,
  }),
];

/** Enterprise beta's live seats for {@link FIXTURE_CURRENT_PERIOD} (2026-03). */
export const BETA_LIVE_SEATS: NormalizedCopilotSeat[] = [
  // Zero audit history anywhere in this scenario — historical periods for
  // this holder cannot be reconstructed (no snapshot, no audit overlap),
  // demonstrating the `unrecoverable` confidence tier for 2026-01/2026-02.
  // Login-only for the same AI-Credit-consumption-keying reason as alice
  // above (this holder's org-fallback consumption must correctly attribute).
  makeSeat({ holderKey: "login:hank", observedLogin: "hank", orgLogin: FIXTURE_ORGS.BETA_MAIN }),
  // Baseline active holder with real audit history (see audit-events.ts),
  // used as the comparison point for hank's unrecoverable history. Also
  // login-only, for the same AI-Credit-consumption-keying reason.
  makeSeat({ holderKey: "login:iris", observedLogin: "iris", orgLogin: FIXTURE_ORGS.BETA_MAIN }),
];
