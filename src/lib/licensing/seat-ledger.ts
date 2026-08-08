// Historical Copilot seat ledger reconstruction — normalizes audit
// assign/cancel/refresh events, stored monthly snapshots, and current live
// seats into per-(org, holder, billing-period) assignment rows with an
// explicit confidence classification. Pure/side-effect-free: no DB access
// and no writes happen here (orchestration/persistence is a later task).
//
// Seat source precedence, per period+canonical-key:
//   1. `exact_snapshot`      — a stored authoritative monthly snapshot.
//   2. `audit_reconstructed` — an interval reconstructed from audit events.
//   3. `live_snapshot_only`  — the current live snapshot, current period only.
//   4. `unrecoverable`       — no source covers this period; never a
//                              fabricated row, only a typed coverage/warning.
//
// Canonical key grain: (billingPeriod, orgLogin, holderKey) — the caller is
// expected to scope a single `buildSeatLedger` call to one enterprise (the
// `enterpriseSlug` dimension the wider plan's canonical key includes is
// simply "this whole call"), so multi-org users are never collapsed or
// copied across orgs: every group is keyed by (orgLogin, holderKey), never
// by holderKey alone.

import { cycleBoundsUtc, intervalOverlapsPeriod, MAX_REPORT_MONTHS } from "./periods";

// ── Canonical sentinel ─────────────────────────────────────────────────
//
// Mirrors `UNATTRIBUTED_ORG` in `license-history-repo.ts` byte-for-byte,
// but is redefined here (rather than imported) because this module must
// stay import-free of the DB layer — `license-history-repo.ts` transitively
// imports `better-sqlite3` at module load time, which this pure module (and
// its tests) must never depend on.

/** Canonical sentinel for "no attributed organization" — never the empty string. See `license-history-repo.ts`'s `UNATTRIBUTED_ORG`. */
export const UNATTRIBUTED_ORG = "(unattributed)";

// ── Input types ───────────────────────────────────────────────────────

/**
 * Normalized seat lifecycle action. Task 4's audit-log clients
 * (`copilot-audit-client.ts`) currently classify every event as `"assign"`
 * or `"cancel"` (folding `seat_refresh` into `"assign"`), but this ledger
 * accepts `"refresh"` explicitly so a future normalizer that distinguishes
 * it can be consumed safely: a refresh retains/extends activity without
 * ever duplicating an interval.
 */
export type SeatLedgerAction = "assign" | "cancel" | "refresh";

/** A single normalized audit event feeding seat interval reconstruction. Compatible with `NormalizedCopilotAuditEvent`/`NormalizedAuditEvent` (Task 4 outputs). */
export interface SeatLedgerAuditEventInput {
  /** Stable per-event identity. Combined with `source`, used to dedupe exact re-ingested duplicates (e.g. re-importing the same archive). */
  eventId: string;
  /** Origin of this event (e.g. `"audit_log"`, `"audit_archive"`) — never used to fabricate distinctness across genuinely duplicate events beyond the `(eventId, source)` dedupe key. */
  source: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  action: SeatLedgerAction;
  /** ISO 8601 timestamp. */
  occurredAt: string;
}

/** A stored, authoritative monthly seat snapshot (highest-precedence source). Compatible with `license_seat_snapshots` rows. */
export interface SeatLedgerSnapshotInput {
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  observedLogin: string | null;
  snapshotAt: string;
}

/** A current live seat (fallback source, current period only). Compatible with `NormalizedCopilotSeat` (Task 4's `seats-client.ts`). */
export interface SeatLedgerLiveSeatInput {
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  observedLogin: string | null;
  observedAt: string;
}

export interface BuildSeatLedgerOptions {
  auditEvents?: SeatLedgerAuditEventInput[];
  snapshots?: SeatLedgerSnapshotInput[];
  liveSeats?: SeatLedgerLiveSeatInput[];
  /** "YYYY-MM" billing months to materialize. Validated via `periods.ts`'s UTC period helpers. */
  periods: string[];
  /**
   * "YYYY-MM" month treated as "now". Bounds two things: (1) the
   * live-snapshot fallback, which only ever applies to this exact period,
   * and (2) how far an audit-reconstructed interval with a missing
   * cancellation (`revokedAt: null`) is allowed to extend — it is only
   * honored through this period, never fabricated further into the future.
   */
  currentPeriod: string;
}

// ── Output types ──────────────────────────────────────────────────────

/** Exactly the four confidence classifications the wider reconciliation plan (Task 7) expects. */
export type SeatLedgerConfidence = "exact_snapshot" | "audit_reconstructed" | "live_snapshot_only" | "unrecoverable";

/** A single reconstructed (or authoritatively known) seat assignment for one (org, holder, period). */
export interface SeatLedgerRow {
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  observedLogin: string | null;
  /** ISO 8601 instant the assignment interval began, when known. */
  assignedAt: string | null;
  /** ISO 8601 instant the assignment interval ended, or `null` if still open (active as of the source's evidence). */
  revokedAt: string | null;
  confidence: SeatLedgerConfidence;
  /** Specific originating source label (e.g. `"exact_snapshot"`, `"audit_reconstructed"`, `"live_snapshot_only"`). */
  source: SeatLedgerConfidence;
}

/** Per (period, org) reconstruction coverage summary — sufficient for Task 7 materialization to report data-quality gaps rather than silently guessing. */
export interface SeatLedgerCoverage {
  billingPeriod: string;
  orgLogin: string;
  confidence: SeatLedgerConfidence;
  warnings: string[];
}

export interface SeatLedgerResult {
  rows: SeatLedgerRow[];
  coverage: SeatLedgerCoverage[];
  /** Ledger-wide warnings not tied to a single (period, org) pair (e.g. dropped malformed events). */
  warnings: string[];
}

// ── Validation ────────────────────────────────────────────────────────

/** Validate a "YYYY-MM" period token, throwing the same descriptive error `periods.ts` uses elsewhere. Reuses `cycleBoundsUtc` purely for its validation side effect. */
function assertValidPeriod(period: string): void {
  cycleBoundsUtc(period);
}

// ── Deterministic event dedupe ────────────────────────────────────────

/**
 * Collapse events that share the exact same `(eventId, source)` pair —
 * e.g. the same archive file (or the same API page) re-ingested more than
 * once. Cross-source near-duplicates (the same logical assignment observed
 * via both an archive and a live API fetch, but with different `eventId`s)
 * are intentionally *not* collapsed here: they are instead absorbed
 * naturally by the interval state machine below, whose "repeated assign
 * while active" and "repeated cancel while inactive" rules are no-ops.
 */
function dedupeEvents(events: SeatLedgerAuditEventInput[]): SeatLedgerAuditEventInput[] {
  const seen = new Map<string, SeatLedgerAuditEventInput>();
  for (const event of events) {
    const key = `${event.source}\u0000${event.eventId}`;
    if (!seen.has(key)) {
      seen.set(key, event);
    }
  }
  return [...seen.values()];
}

// ── Deterministic same-instant tie-breaking ──────────────────────────

const ACTION_TIE_BREAK_RANK: Record<SeatLedgerAction, number> = {
  assign: 0,
  refresh: 0,
  cancel: 1,
};

/**
 * Sort a single (org, holder) group's events into deterministic processing
 * order: primarily by `occurredAt`; for events at the exact same instant
 * (common when a source only carries day-granularity timestamps), cancel
 * events are always ordered *after* assign/refresh events so a same-instant
 * assign+cancel pair conservatively ends inactive rather than leaving an
 * assignment active due to unstable array order. A final `eventId`
 * comparison guarantees a total, input-order-independent ordering.
 */
function sortEventsDeterministically(events: SeatLedgerAuditEventInput[]): (SeatLedgerAuditEventInput & { occurredAtMs: number })[] {
  const withMs = events.map((event) => {
    const ms = Date.parse(event.occurredAt);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid seat ledger audit event occurredAt: "${event.occurredAt}" (eventId ${event.eventId})`);
    }
    return { ...event, occurredAtMs: ms };
  });

  return withMs.sort((a, b) => {
    if (a.occurredAtMs !== b.occurredAtMs) return a.occurredAtMs - b.occurredAtMs;
    const rankDiff = ACTION_TIE_BREAK_RANK[a.action] - ACTION_TIE_BREAK_RANK[b.action];
    if (rankDiff !== 0) return rankDiff;
    return a.eventId.localeCompare(b.eventId);
  });
}

// ── Interval reconstruction (per org+holder group) ───────────────────

interface ReconstructedInterval {
  assignedAt: string;
  revokedAt: string | null;
}

/**
 * Replay one (org, holder) group's chronologically-sorted events through a
 * small state machine:
 *  - `assign` while inactive opens a new interval; while already active, a
 *    repeated assign is a no-op (never a duplicate interval).
 *  - `refresh` while inactive behaves like an implicit assign (defensive:
 *    today's classifiers never emit a bare refresh with no prior assign,
 *    but the interval must never be silently dropped if one ever does);
 *    while active, it retains activity without altering the interval.
 *  - `cancel` while active closes the current interval; while inactive, a
 *    stray cancel is a no-op (never a negative/fabricated interval).
 *  - A still-active interval at the end of the event stream is left open
 *    (`revokedAt: null`) — a missing cancellation, not an error.
 */
function reconstructIntervals(sortedEvents: SeatLedgerAuditEventInput[]): ReconstructedInterval[] {
  const intervals: ReconstructedInterval[] = [];
  let active = false;
  let currentStart: string | null = null;

  for (const event of sortedEvents) {
    if (event.action === "assign" || event.action === "refresh") {
      if (!active) {
        active = true;
        currentStart = event.occurredAt;
      }
      // else: already active — no-op, regardless of assign vs refresh.
    } else {
      // action === "cancel"
      if (active) {
        intervals.push({ assignedAt: currentStart as string, revokedAt: event.occurredAt });
        active = false;
        currentStart = null;
      }
      // else: nothing active — stray cancel, no-op.
    }
  }

  if (active) {
    intervals.push({ assignedAt: currentStart as string, revokedAt: null });
  }

  return intervals;
}

/** ISO-normalize a timestamp (via `Date.parse`/`toISOString`) so equivalent instants always compare/compare equal regardless of the source's original formatting. */
function toIsoInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

// ── Grouping helpers ──────────────────────────────────────────────────

function groupKey(orgLogin: string, holderKey: string): string {
  return `${orgLogin}\u0000${holderKey}`;
}

function normalizeOrgLogin(orgLogin: string | null | undefined): string {
  const trimmed = (orgLogin ?? "").trim();
  return trimmed.length > 0 ? trimmed : UNATTRIBUTED_ORG;
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Materialize requested "YYYY-MM" billing months into per-(org, holder)
 * seat assignment rows, applying the documented source precedence (stored
 * snapshot > audit-reconstructed interval > current live snapshot > no
 * fabricated row) and returning a typed coverage/warning summary alongside
 * the rows themselves, so a period/org that cannot be reconstructed from
 * any source is reported as `"unrecoverable"` rather than silently omitted
 * or guessed at.
 */
export function buildSeatLedger(options: BuildSeatLedgerOptions): SeatLedgerResult {
  const { auditEvents = [], snapshots = [], liveSeats = [], periods, currentPeriod } = options;

  if (!Number.isInteger(periods.length) || periods.length === 0) {
    return { rows: [], coverage: [], warnings: [] };
  }
  if (periods.length > MAX_REPORT_MONTHS) {
    throw new Error(`buildSeatLedger: requested ${periods.length} periods, exceeding the maximum of ${MAX_REPORT_MONTHS}`);
  }
  for (const period of periods) assertValidPeriod(period);
  assertValidPeriod(currentPeriod);

  // ── Index snapshots by canonical (period, org, holder) key. ──────────
  const snapshotIndex = new Map<string, SeatLedgerSnapshotInput>();
  for (const snapshot of snapshots) {
    const org = normalizeOrgLogin(snapshot.orgLogin);
    const key = `${snapshot.billingPeriod}\u0000${groupKey(org, snapshot.holderKey)}`;
    // Deterministic tie-break for duplicate snapshot rows: most recent `snapshotAt` wins.
    const existing = snapshotIndex.get(key);
    if (!existing || Date.parse(snapshot.snapshotAt) >= Date.parse(existing.snapshotAt)) {
      snapshotIndex.set(key, snapshot);
    }
  }

  // ── Index live seats by canonical (org, holder) key (current period only). ──
  const liveIndex = new Map<string, SeatLedgerLiveSeatInput>();
  for (const live of liveSeats) {
    const org = normalizeOrgLogin(live.orgLogin);
    const key = groupKey(org, live.holderKey);
    const existing = liveIndex.get(key);
    if (!existing || Date.parse(live.observedAt) >= Date.parse(existing.observedAt)) {
      liveIndex.set(key, live);
    }
  }

  // ── Reconstruct audit-derived intervals, grouped by (org, holder). ───
  const dedupedEvents = dedupeEvents(auditEvents);
  const eventsByGroup = new Map<string, SeatLedgerAuditEventInput[]>();
  for (const event of dedupedEvents) {
    const org = normalizeOrgLogin(event.orgLogin);
    const key = groupKey(org, event.holderKey);
    const list = eventsByGroup.get(key) ?? [];
    list.push({ ...event, orgLogin: org });
    eventsByGroup.set(key, list);
  }

  const intervalsByGroup = new Map<string, { githubUserId: number | null; intervals: ReconstructedInterval[] }>();
  for (const [key, groupEvents] of eventsByGroup) {
    const sorted = sortEventsDeterministically(groupEvents);
    const intervals = reconstructIntervals(sorted);
    const githubUserId = sorted.find((e) => e.githubUserId != null)?.githubUserId ?? null;
    intervalsByGroup.set(key, { githubUserId, intervals });
  }

  // ── Universe of (org, holder) groups considered across all sources. ──
  const allGroupKeys = new Set<string>([...snapshotIndex.keys(), ...liveIndex.keys(), ...intervalsByGroup.keys()].map((k) => {
    // snapshotIndex keys are prefixed with billingPeriod; strip it back to the bare group key for the union.
    const parts = k.split("\u0000");
    return parts.length === 3 ? `${parts[1]}\u0000${parts[2]}` : k;
  }));
  // Also include groups that only ever appear via snapshots for periods not in this union (defensive; snapshotIndex already covers this via the map above).
  for (const snapshot of snapshots) {
    allGroupKeys.add(groupKey(normalizeOrgLogin(snapshot.orgLogin), snapshot.holderKey));
  }

  // Distinct orgs across all sources, used to enumerate coverage even for periods/orgs with zero holders (e.g. wholly unrecoverable periods for a known org).
  const allOrgs = new Set<string>();
  for (const key of allGroupKeys) allOrgs.add(key.split("\u0000")[0]);

  const rows: SeatLedgerRow[] = [];
  // coverageMap tracks the best confidence + warnings seen per (period, org).
  const coverageMap = new Map<string, { confidence: SeatLedgerConfidence; warnings: Set<string> }>();

  const recordCoverage = (period: string, org: string, confidence: SeatLedgerConfidence, warning?: string) => {
    const key = `${period}\u0000${org}`;
    const existing = coverageMap.get(key);
    const rank: Record<SeatLedgerConfidence, number> = { exact_snapshot: 3, audit_reconstructed: 2, live_snapshot_only: 1, unrecoverable: 0 };
    if (!existing || rank[confidence] > rank[existing.confidence]) {
      coverageMap.set(key, { confidence, warnings: existing?.warnings ?? new Set() });
    }
    if (warning) coverageMap.get(key)!.warnings.add(warning);
  };

  for (const period of periods) {
    for (const groupKeyStr of allGroupKeys) {
      const [org, holderKey] = groupKeyStr.split("\u0000");

      // Tier 1: stored authoritative monthly snapshot.
      const snapshot = snapshotIndex.get(`${period}\u0000${groupKeyStr}`);
      if (snapshot) {
        rows.push({
          billingPeriod: period,
          orgLogin: org,
          holderKey,
          githubUserId: snapshot.githubUserId,
          observedLogin: snapshot.observedLogin,
          assignedAt: null,
          revokedAt: null,
          confidence: "exact_snapshot",
          source: "exact_snapshot",
        });
        recordCoverage(period, org, "exact_snapshot");
        continue;
      }

      // Tier 2: audit-reconstructed interval overlapping this period.
      const reconstructed = intervalsByGroup.get(groupKeyStr);
      const overlapping = reconstructed?.intervals.find((interval) => {
        if (interval.revokedAt === null) {
          // A missing cancellation is only honored through the current period.
          if (period > currentPeriod) return false;
        }
        return intervalOverlapsPeriod(interval.assignedAt, interval.revokedAt, period);
      });
      if (overlapping) {
        rows.push({
          billingPeriod: period,
          orgLogin: org,
          holderKey,
          githubUserId: reconstructed?.githubUserId ?? null,
          observedLogin: null,
          assignedAt: toIsoInstant(overlapping.assignedAt),
          revokedAt: overlapping.revokedAt ? toIsoInstant(overlapping.revokedAt) : null,
          confidence: "audit_reconstructed",
          source: "audit_reconstructed",
        });
        recordCoverage(period, org, "audit_reconstructed");
        continue;
      }

      // Tier 3: current live snapshot, current period only.
      if (period === currentPeriod) {
        const live = liveIndex.get(groupKeyStr);
        if (live) {
          rows.push({
            billingPeriod: period,
            orgLogin: org,
            holderKey,
            githubUserId: live.githubUserId,
            observedLogin: live.observedLogin,
            assignedAt: null,
            revokedAt: null,
            confidence: "live_snapshot_only",
            source: "live_snapshot_only",
          });
          recordCoverage(period, org, "live_snapshot_only");
          continue;
        }
      }

      // Tier 4: unrecoverable — no fabricated row, only a coverage/warning entry.
      recordCoverage(
        period,
        org,
        "unrecoverable",
        `No snapshot, audit trail, or live data covers holder "${holderKey}" in org "${org}" for period ${period}.`,
      );
    }

    // Ensure every known org still gets a coverage entry for this period even
    // when it has zero holder groups at all (e.g. a period wholly outside
    // every source's coverage for that org).
    for (const org of allOrgs) {
      const key = `${period}\u0000${org}`;
      if (!coverageMap.has(key)) {
        recordCoverage(period, org, "unrecoverable", `No data available to reconstruct seats for org "${org}" in period ${period}.`);
      }
    }
  }

  const coverage: SeatLedgerCoverage[] = [...coverageMap.entries()]
    .map(([key, value]) => {
      const [billingPeriod, orgLogin] = key.split("\u0000");
      return { billingPeriod, orgLogin, confidence: value.confidence, warnings: [...value.warnings].sort() };
    })
    .sort((a, b) => (a.billingPeriod === b.billingPeriod ? a.orgLogin.localeCompare(b.orgLogin) : a.billingPeriod.localeCompare(b.billingPeriod)));

  rows.sort((a, b) => {
    if (a.billingPeriod !== b.billingPeriod) return a.billingPeriod.localeCompare(b.billingPeriod);
    if (a.orgLogin !== b.orgLogin) return a.orgLogin.localeCompare(b.orgLogin);
    return a.holderKey.localeCompare(b.holderKey);
  });

  return { rows, coverage, warnings: [] };
}
