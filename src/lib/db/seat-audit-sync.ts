// Audit-log seat lifecycle sync — the authoritative offboarding source.
//
// WHY THIS EXISTS
// ---------------
// Offboarding used to be derived only from seat-snapshot diffs: `copilot_seats`
// is replaced wholesale on every sync, so a seat that disappears between two
// syncs is inferred to have been removed "sometime in between". That is both
// imprecise (the recorded date is the sync date, not the removal date) and
// blind to anything that happened before snapshot tracking started — so asking
// "who was offboarded this month?" could not be answered for the part of the
// month that preceded the first tracked sync.
//
// GitHub's audit log answers the question exactly: every Copilot seat
// assign/cancel carries the instant it happened. This module fetches those
// events on every regular sync and persists them into the same ledger the
// dashboard already reads, tagged `source = 'audit_log'`, so the data is in
// SQLite and renders instantly with no API call on the request path.
//
// RELATIONSHIP TO THE LICENSING-HISTORY SYNC
// ------------------------------------------
// `license-history-sync-service.ts` also reads the audit log, but only when the
// optional `licensing.history.enabled` flag is on — which is off by default, so
// almost no install had an audit-log source at all. This module is deliberately
// independent of that flag and runs for every install that syncs seats. Both
// write `source = 'audit_log'` rows keyed by the ledger's primary key, so when
// both run they converge on the same rows rather than duplicating them.
//
// INCREMENTALITY
// --------------
// `copilot_seat_audit_sync_state.covered_through` is the watermark. Each run
// re-reads a small overlap before it (audit entries can be indexed slightly out
// of order), and a first run reaches back `SEAT_AUDIT_LOOKBACK_DAYS`. Writes are
// idempotent (`INSERT OR REPLACE` on the ledger's primary key), so overlap is
// free. The audit log paginates newest-first, so if the pagination cap is hit
// the missing part of the window is its OLDEST end — the recorded `covered_from`
// is then the oldest event actually seen, never the requested cutoff.
//
// FAILURE POSTURE
// ---------------
// The audit log is optional capability, not a guarantee: an enterprise may not
// expose it, and the credential may lack `read:audit_log`. Every outcome —
// including "we could not check" — is recorded in
// `copilot_seat_audit_sync_state` so the dashboard can name the active source
// and its true coverage rather than implying completeness. This never throws
// into the caller: seat sync is the primary job.

import {
  copilotAuditClient,
  type AuditFetchResult,
  type NormalizedCopilotAuditEvent,
} from "@/lib/github/copilot-audit-client";
import {
  recordSeatLifecycleEvents,
  recordSeatAuditSyncState,
  getSeatAuditSyncStates,
  enrichAuditLifecycleFromSeats,
  type SeatAuditSyncState,
  type SeatLifecycleEventInput,
} from "./seat-lifecycle-repo";
import {
  getResolvedOrgsForEnterprise,
  isCopilotSubEnabledForEnterprise,
} from "@/lib/config/enterprise-config";

/** Strip newlines/carriage returns before logging to prevent log injection. */
function sanitizeForLog(value: string): string {
  return value.replace(/\n|\r/g, "");
}

/** How far back a first run reads the audit log. */
export const SEAT_AUDIT_LOOKBACK_DAYS =
  parseInt(process.env.SEAT_AUDIT_LOOKBACK_DAYS || "90", 10) || 90;

/**
 * Overlap re-read before the stored watermark on incremental runs. Audit log
 * entries are not strictly ordered by the instant they occurred (indexing lag),
 * so resuming exactly at the watermark can miss a late-indexed event.
 */
export const SEAT_AUDIT_OVERLAP_HOURS = 48;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface SeatAuditSyncResult {
  enterpriseSlug: string;
  status: "ok" | "unavailable" | "error" | "skipped";
  /** Which API answered, when one did. */
  target: "enterprise" | "org" | null;
  /** Ledger rows written (idempotent re-writes included). */
  eventsWritten: number;
  /** Audit events fetched and recognized as seat assign/cancel. */
  eventsFetched: number;
  coveredFrom: string | null;
  coveredThrough: string | null;
  truncated: boolean;
  reason: string | null;
  warnings: string[];
}

/** Injection seam so tests can drive the sync without network or config. */
export interface SeatAuditSyncDeps {
  getEnterpriseAuditEvents: (
    enterpriseSlug: string,
    cutoffMs: number,
  ) => Promise<AuditFetchResult>;
  getOrgAuditEvents: (
    org: string,
    enterpriseSlug: string,
    cutoffMs: number,
  ) => Promise<AuditFetchResult>;
  getOrgs: (enterpriseSlug: string) => string[];
  isEnterpriseScopeEnabled: (enterpriseSlug: string) => boolean;
  now: () => Date;
}

export function createDefaultSeatAuditSyncDeps(): SeatAuditSyncDeps {
  return {
    getEnterpriseAuditEvents: (enterpriseSlug, cutoffMs) =>
      copilotAuditClient.getEnterpriseAuditEvents(enterpriseSlug, { cutoffMs, enterpriseSlug }),
    getOrgAuditEvents: (org, enterpriseSlug, cutoffMs) =>
      copilotAuditClient.getOrgAuditEvents(org, { cutoffMs, enterpriseSlug }),
    getOrgs: (enterpriseSlug) => getResolvedOrgsForEnterprise(enterpriseSlug),
    isEnterpriseScopeEnabled: (enterpriseSlug) =>
      isCopilotSubEnabledForEnterprise(enterpriseSlug, "enterprise"),
    now: () => new Date(),
  };
}

/**
 * Resolve the instant this run should start reading from.
 *
 * Exported for testing: the choice between "resume from the watermark" and
 * "reach back the full lookback" is the whole of the incremental contract.
 */
export function resolveAuditCutoff(
  watermark: string | null,
  now: Date,
  lookbackDays = SEAT_AUDIT_LOOKBACK_DAYS,
): number {
  const floor = now.getTime() - lookbackDays * MS_PER_DAY;
  if (!watermark) return floor;

  const parsed = Date.parse(watermark);
  if (Number.isNaN(parsed)) return floor;

  // Never read further back than the lookback allows, and never resume so far
  // forward that a late-indexed event slips through the gap.
  return Math.max(floor, parsed - SEAT_AUDIT_OVERLAP_HOURS * MS_PER_HOUR);
}

function reasonForUnavailable(result: AuditFetchResult): string {
  if (result.status === "unavailable") {
    return result.reason === "forbidden"
      ? `Audit log access denied for "${result.target}" — the configured credential needs the read:audit_log scope.`
      : `No audit log available for "${result.target}".`;
  }
  if (result.status === "unknown") return result.message;
  return "Audit log unavailable.";
}

/**
 * Map audit events to ledger rows.
 *
 * `assign` and `cancel` are the only actions the client emits, and they map
 * directly onto the ledger's two event types. Plan/team/last-activity are left
 * null here and backfilled from the seat snapshot afterwards, because the audit
 * log does not carry them.
 */
export function toLifecycleEvents(
  events: readonly NormalizedCopilotAuditEvent[],
): SeatLifecycleEventInput[] {
  const mapped: SeatLifecycleEventInput[] = [];
  for (const event of events) {
    // The ledger's primary key is (enterprise, org, login, type, date, source),
    // so a row with no usable login identity has no stable key and would
    // collide with every other identity-less row for the same day.
    const login = event.observedLogin?.trim()
      || (event.githubUserId != null ? `user-${event.githubUserId}` : "");
    if (!login) continue;

    mapped.push({
      orgSlug: event.orgLogin ?? "",
      userLogin: login,
      userId: event.githubUserId,
      eventType: event.action === "cancel" ? "offboarded" : "onboarded",
      occurredAt: event.occurredAt,
      assigningTeamSlug: event.team,
      source: "audit_log",
    });
  }
  return mapped;
}

/**
 * Fetch and persist audit-log seat lifecycle events for one enterprise.
 *
 * Tries the enterprise audit log first, falling back to each configured org's
 * audit log when the enterprise endpoint is unavailable — org-only installs and
 * enterprises without enterprise-level audit access still get exact data that
 * way. Always resolves; never throws.
 */
export async function syncSeatAuditEventsForEnterprise(
  enterpriseSlug: string,
  deps: SeatAuditSyncDeps = createDefaultSeatAuditSyncDeps(),
): Promise<SeatAuditSyncResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const [existing] = getSeatAuditSyncStates([enterpriseSlug]);
  const cutoffMs = resolveAuditCutoff(existing?.coveredThrough ?? null, now);
  const coveredFrom = new Date(cutoffMs).toISOString();

  const warnings: string[] = [];
  let result: AuditFetchResult | null = null;
  let target: "enterprise" | "org" | null = null;
  const events: NormalizedCopilotAuditEvent[] = [];
  let truncated = false;
  let unavailableReason: string | null = null;

  if (deps.isEnterpriseScopeEnabled(enterpriseSlug)) {
    result = await deps.getEnterpriseAuditEvents(enterpriseSlug, cutoffMs);
    if (result.status === "ok") {
      target = "enterprise";
      events.push(...result.events);
      truncated = result.truncated;
      warnings.push(...result.warnings);
    } else {
      unavailableReason = reasonForUnavailable(result);
    }
  }

  if (target === null) {
    // Org fallback. An org that fails is recorded as a warning rather than
    // failing the run — partial coverage from the orgs that answered is still
    // strictly better than none, and the reason is surfaced to the UI.
    const orgs = deps.getOrgs(enterpriseSlug);
    let anyOrgSucceeded = false;
    const orgFailures: string[] = [];

    for (const org of orgs) {
      const orgResult = await deps.getOrgAuditEvents(org, enterpriseSlug, cutoffMs);
      if (orgResult.status === "ok") {
        anyOrgSucceeded = true;
        events.push(...orgResult.events);
        truncated = truncated || orgResult.truncated;
        warnings.push(...orgResult.warnings);
      } else {
        orgFailures.push(reasonForUnavailable(orgResult));
      }
    }

    if (anyOrgSucceeded) {
      target = "org";
      if (orgFailures.length > 0) {
        warnings.push(`Audit log unavailable for ${orgFailures.length} organization(s).`);
      }
    } else if (orgs.length > 0) {
      unavailableReason = orgFailures[0] ?? unavailableReason;
    }
  }

  if (target === null) {
    const reason = unavailableReason
      ?? "No enterprise or organization audit log is reachable for this enterprise.";
    // A transient failure must not be reported as a missing capability — the UI
    // tells the operator to grant a scope for one and to wait for the other.
    const status: SeatAuditSyncState["status"] =
      result?.status === "unknown" ? "error" : "unavailable";

    recordSeatAuditSyncState({
      enterpriseSlug,
      status,
      reason,
      target: null,
      coveredFrom: null,
      coveredThrough: null,
      lastEventAt: null,
      lastSyncedAt: nowIso,
      eventsWritten: 0,
      truncated: false,
    });

    return {
      enterpriseSlug,
      status,
      target: null,
      eventsWritten: 0,
      eventsFetched: 0,
      coveredFrom: null,
      coveredThrough: null,
      truncated: false,
      reason,
      warnings,
    };
  }

  const lifecycleEvents = toLifecycleEvents(events);
  const eventsWritten = recordSeatLifecycleEvents(enterpriseSlug, lifecycleEvents);
  if (eventsWritten > 0) enrichAuditLifecycleFromSeats(enterpriseSlug);

  const lastEventAt = lifecycleEvents.reduce<string | null>(
    (latest, event) => (latest === null || event.occurredAt > latest ? event.occurredAt : latest),
    null,
  );
  const firstEventAt = lifecycleEvents.reduce<string | null>(
    (earliest, event) => (earliest === null || event.occurredAt < earliest ? event.occurredAt : earliest),
    null,
  );

  // The audit log paginates newest-first, so a truncated fetch is missing the
  // OLDEST part of the requested window, not the newest. Claiming coverage back
  // to the cutoff would suppress snapshot-derived rows for a range the audit log
  // never actually read — so fall back to the oldest event we did see.
  const effectiveCoveredFrom = truncated ? firstEventAt ?? coveredFrom : coveredFrom;
  const coveredThrough = nowIso;

  recordSeatAuditSyncState({
    enterpriseSlug,
    status: "ok",
    reason: warnings[0] ?? null,
    target,
    coveredFrom: effectiveCoveredFrom,
    coveredThrough,
    lastEventAt,
    lastSyncedAt: nowIso,
    eventsWritten,
    truncated,
  });

  return {
    enterpriseSlug,
    status: "ok",
    target,
    eventsWritten,
    eventsFetched: events.length,
    coveredFrom: effectiveCoveredFrom,
    coveredThrough,
    truncated,
    reason: warnings[0] ?? null,
    warnings,
  };
}

/**
 * Best-effort wrapper used by the regular sync. Swallows every failure so an
 * audit log problem can never fail seat sync, and reports it as a `skipped`
 * result the caller can log.
 */
export async function syncSeatAuditEventsSafely(
  enterpriseSlug: string,
  deps?: SeatAuditSyncDeps,
): Promise<SeatAuditSyncResult> {
  try {
    return await syncSeatAuditEventsForEnterprise(enterpriseSlug, deps);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      "[Sync] [%s] Audit-log seat lifecycle sync failed (seat sync unaffected):",
      sanitizeForLog(enterpriseSlug),
      err,
    );
    try {
      recordSeatAuditSyncState({
        enterpriseSlug,
        status: "error",
        reason,
        target: null,
        coveredFrom: null,
        coveredThrough: null,
        lastEventAt: null,
        lastSyncedAt: new Date().toISOString(),
        eventsWritten: 0,
        truncated: false,
      });
    } catch {
      // The state table is a reporting aid; failing to write it must not
      // escalate an already-handled failure.
    }
    return {
      enterpriseSlug,
      status: "skipped",
      target: null,
      eventsWritten: 0,
      eventsFetched: 0,
      coveredFrom: null,
      coveredThrough: null,
      truncated: false,
      reason,
      warnings: [],
    };
  }
}
