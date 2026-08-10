// Seat-lifecycle audit event fixtures — the shape `getEnterpriseAuditEvents()`
// (audit-log API, `NormalizedCopilotAuditEvent`) and `importAuditArchive()`
// (archive import, `NormalizedAuditEvent`) return. Together with the live
// seats in `seats.ts`, these events let the seat ledger reconstruct
// assign/cancel/reassign intervals across historical billing months.

import type { NormalizedCopilotAuditEvent } from "@/lib/github/copilot-audit-client";
import type { RawCopilotAuditEvent } from "@/lib/github/copilot-audit-client";
import type { NormalizedAuditEvent } from "@/lib/licensing/audit-archive-import";
import { FIXTURE_ORGS } from "./identifiers";
import { OBFUSCATED_GUID_LOGIN } from "./seats";

const RAW_EVENT_STUB = {} as RawCopilotAuditEvent;

function apiEvent(overrides: Partial<NormalizedCopilotAuditEvent> & Pick<NormalizedCopilotAuditEvent, "eventId" | "orgLogin" | "action" | "occurredAt">): NormalizedCopilotAuditEvent {
  return {
    githubUserId: null,
    observedLogin: null,
    externalIdentity: null,
    team: null,
    source: "audit_log",
    raw: RAW_EVENT_STUB,
    ...overrides,
  };
}

function archiveEvent(overrides: Partial<NormalizedAuditEvent> & Pick<NormalizedAuditEvent, "eventId" | "action" | "occurredAt">): NormalizedAuditEvent {
  return {
    orgLogin: null,
    observedLogin: null,
    externalIdentity: null,
    assignedVia: null,
    source: "audit_archive",
    raw: {},
    ...overrides,
  };
}

/**
 * Enterprise alpha's live audit-log API events, spanning every historical
 * period in the scenario. Covers: a plain active holder (alice), a
 * cancellation (bob), a reassignment into bob's freed org seat (carol), a
 * multi-org assignment (dana, two org-scoped assign events), a holder whose
 * seat stays active while flagged suspended/deprovisioned elsewhere (erin,
 * frank — see identities.ts), and an obfuscated/never-resolves holder.
 *
 * Bob's cancel event intentionally duplicates {@link ALPHA_ARCHIVE_EVENTS}'
 * single record (same org/login/action/timestamp, different `eventId`) to
 * exercise archive-vs-API overlap deduplication.
 */
export const ALPHA_AUDIT_API_EVENTS: NormalizedCopilotAuditEvent[] = [
  // alice is deliberately login-only (no githubUserId) — see seats.ts's doc
  // comment on why AI-Credit-consumption-bearing holders must be login-only.
  apiEvent({ eventId: "api-alice-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "assign", occurredAt: "2026-01-02T00:00:00.000Z", githubUserId: null, observedLogin: "alice" }),
  apiEvent({ eventId: "api-bob-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "assign", occurredAt: "2026-01-03T00:00:00.000Z", githubUserId: 102, observedLogin: "bob" }),
  apiEvent({ eventId: "api-bob-cancel-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "cancel", occurredAt: "2026-02-05T00:00:00.000Z", githubUserId: 102, observedLogin: "bob" }),
  apiEvent({ eventId: "api-carol-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "assign", occurredAt: "2026-02-10T00:00:00.000Z", githubUserId: 103, observedLogin: "carol" }),
  apiEvent({ eventId: "api-dana-assign-eng-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "assign", occurredAt: "2026-02-01T00:00:00.000Z", githubUserId: 104, observedLogin: "dana" }),
  apiEvent({ eventId: "api-dana-assign-data-1", orgLogin: FIXTURE_ORGS.ALPHA_DATA, action: "assign", occurredAt: "2026-02-01T00:00:00.000Z", githubUserId: 104, observedLogin: "dana" }),
  apiEvent({ eventId: "api-erin-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "assign", occurredAt: "2026-01-05T00:00:00.000Z", githubUserId: 105, observedLogin: "erin" }),
  apiEvent({ eventId: "api-frank-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_DATA, action: "assign", occurredAt: "2026-01-06T00:00:00.000Z", githubUserId: 106, observedLogin: "frank" }),
  apiEvent({ eventId: "api-obfuscated-assign-1", orgLogin: FIXTURE_ORGS.ALPHA_DATA, action: "assign", occurredAt: "2026-01-07T00:00:00.000Z", githubUserId: null, observedLogin: OBFUSCATED_GUID_LOGIN }),
];

/**
 * Enterprise alpha's configured audit-archive import result — one record
 * describing the exact same real-world cancellation as
 * `ALPHA_AUDIT_API_EVENTS`' `"api-bob-cancel-1"` entry (same org/login/
 * action/timestamp), under a different `eventId`, the way a periodically
 * re-exported archive dump and the live API would both legitimately observe
 * the same historical event. `license-history-sync-service.ts`'s two-pass
 * merge (exact `eventId`, then semantic `(org, holder, action, occurredAt)`
 * key) must collapse these into a single ledger event.
 */
export const ALPHA_ARCHIVE_EVENTS: NormalizedAuditEvent[] = [
  archiveEvent({ eventId: "archive-bob-cancel-1", orgLogin: FIXTURE_ORGS.ALPHA_ENG, action: "cancel", occurredAt: "2026-02-05T00:00:00.000Z", observedLogin: "bob", assignedVia: "direct" }),
];

/**
 * Enterprise beta's live audit-log API events. Only `iris` has any audit
 * history at all — `hank` (see seats.ts) has none, so his 2026-01/2026-02
 * rows cannot be reconstructed from any source, demonstrating the
 * `unrecoverable` confidence tier.
 */
export const BETA_AUDIT_API_EVENTS: NormalizedCopilotAuditEvent[] = [
  // iris is deliberately login-only, for the same AI-Credit-consumption-keying reason as alice.
  apiEvent({ eventId: "api-iris-assign-1", orgLogin: FIXTURE_ORGS.BETA_MAIN, action: "assign", occurredAt: "2026-01-04T00:00:00.000Z", githubUserId: null, observedLogin: "iris" }),
];

/** Enterprise beta configures an audit archive path, but the file is missing — a real, non-fatal "missing optional source" outcome (see aic-consumption.ts/org-billing.ts for the other missing-source variants). */
export const BETA_ARCHIVE_EVENTS: NormalizedAuditEvent[] = [];
