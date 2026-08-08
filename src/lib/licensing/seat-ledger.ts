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
// Canonical key grain: (enterpriseSlug, billingPeriod, orgLogin, holderKey) —
// `enterpriseSlug` is an explicit, required, validated option threaded into
// every `SeatLedgerRow`/`SeatLedgerCoverage` this call produces, so the
// public canonical grain is truly enterprise-scoped rather than merely
// "whichever enterprise called this". Multi-org users are never collapsed
// or copied across orgs: every group is keyed by (orgLogin, holderKey),
// never by holderKey alone.

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
  /**
   * The enterprise this entire call is scoped to. Required and explicit —
   * the wider plan's canonical key is (enterpriseSlug, billingPeriod,
   * orgLogin, holderKey), and a single `buildSeatLedger` call always
   * produces rows/coverage for exactly one enterprise, so every output row
   * and coverage entry carries this same value. Normalized (trimmed) and
   * validated as a non-empty string; throws for a missing, empty, or
   * whitespace-only value rather than silently defaulting.
   */
  enterpriseSlug: string;
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
  /** The enterprise this call was scoped to (see `BuildSeatLedgerOptions.enterpriseSlug`). Completes the canonical grain (enterpriseSlug, billingPeriod, orgLogin, holderKey). */
  enterpriseSlug: string;
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

/** Per (period, org) reconstruction coverage summary — sufficient for Task 7 materialization to report data-quality gaps rather than silently guessing.
 *
 * `confidence` is computed *conservatively*: it reflects the single worst
 * per-holder observation counted in `counts` for this (period, org), not the
 * best. A period/org is only ever reported as `"exact_snapshot"` when every
 * known holder observed for it that month resolved to an exact snapshot —
 * one holder's `exact_snapshot` row can never mask another expected
 * holder's `unrecoverable` observation in the same period/org. See
 * `worstConfidence` below for the precise precedence
 * (`unrecoverable` > `live_snapshot_only` > `audit_reconstructed` >
 * `exact_snapshot`, worst wins).
 */
export interface SeatLedgerCoverage {
  /** The enterprise this call was scoped to (see `BuildSeatLedgerOptions.enterpriseSlug`). Completes the canonical grain (enterpriseSlug, billingPeriod, orgLogin). */
  enterpriseSlug: string;
  billingPeriod: string;
  orgLogin: string;
  confidence: SeatLedgerConfidence;
  /** Count of holder/org/period observations at each confidence tier that contributed to this coverage entry. Never fabricated: a holder only ever contributes a count when some source (snapshot, audit trail, or live seat) establishes it has an expected seat for this org/period, or when it is a known holder (from any period) with nothing covering this specific period. */
  counts: Record<SeatLedgerConfidence, number>;
  warnings: string[];
}

export interface SeatLedgerResult {
  rows: SeatLedgerRow[];
  coverage: SeatLedgerCoverage[];
  /**
   * Ledger-wide warnings not tied to a single (period, org) coverage entry.
   * Currently populated exclusively by holder-key/numeric-GitHub-ID
   * attribution conflicts: a `holderKey` (e.g. a reused login) observing a
   * non-null `githubUserId` that conflicts with the ID already attributed
   * to a still-active reconstructed interval, with no intervening
   * assignment transition to disambiguate which account the interval
   * belongs to (see `ReconstructedInterval.hasConflict`). One entry per
   * distinct (org, holderKey) conflict, deduplicated and sorted
   * deterministically, regardless of how many periods/rows the conflicted
   * interval spans — the same conflict is also mirrored onto every
   * affected `SeatLedgerCoverage.warnings` entry. Never empty by
   * construction when no such conflict occurred; contains no numeric IDs,
   * logins, or other PII.
   */
  warnings: string[];
}

// ── Conservative coverage confidence ────────────────────────────────────

/**
 * Precedence used to compute a (period, org) coverage entry's overall
 * `confidence` from its per-tier observation `counts`: worst observation
 * wins. Ordered here from worst to best; `worstConfidence` returns the
 * first tier (in this order) with a nonzero count, so a single
 * `unrecoverable` holder always outranks any number of `exact_snapshot`
 * holders in the same period/org.
 */
const CONFIDENCE_WORST_TO_BEST: SeatLedgerConfidence[] = [
  "unrecoverable",
  "live_snapshot_only",
  "audit_reconstructed",
  "exact_snapshot",
];

/** Compute a (period, org) coverage entry's overall confidence conservatively from its per-tier counts: the worst confidence with a nonzero count wins, using only the four mandated {@link SeatLedgerConfidence} values. */
function worstConfidence(counts: Record<SeatLedgerConfidence, number>): SeatLedgerConfidence {
  for (const tier of CONFIDENCE_WORST_TO_BEST) {
    if (counts[tier] > 0) return tier;
  }
  // Defensive: recordCoverage always increments some tier before a coverage
  // entry is ever created, so this is unreachable in practice.
  return "unrecoverable";
}

// ── Validation ────────────────────────────────────────────────────────

/** Validate a "YYYY-MM" period token, throwing the same descriptive error `periods.ts` uses elsewhere. Reuses `cycleBoundsUtc` purely for its validation side effect. */
function assertValidPeriod(period: string): void {
  cycleBoundsUtc(period);
}

/** Normalize (trim) and validate the required `enterpriseSlug` option as a non-empty slug, throwing a descriptive error for a missing, empty, or whitespace-only value rather than silently defaulting to an empty string or omitting the dimension. */
function normalizeEnterpriseSlug(enterpriseSlug: string): string {
  const trimmed = (enterpriseSlug ?? "").trim();
  if (trimmed.length === 0) {
    throw new Error(`buildSeatLedger: enterpriseSlug must be a non-empty string, got ${JSON.stringify(enterpriseSlug)}`);
  }
  return trimmed;
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
  /** GitHub user ID attributed to *this* interval — set from the assignment event that opened it, never inherited/reused from a different interval in the same (org, holder) group. A login `holderKey` can be reused by a different numeric GitHub account across separate intervals; each interval must carry its own attribution. */
  githubUserId: number | null;
  /**
   * True when a non-transition event (an assign/refresh observed while this
   * interval was already active) carried a non-null `githubUserId`
   * conflicting with the ID already attributed to this interval. The
   * original attribution is always preserved — a conflicting ID is never
   * silently applied — but this flag lets the caller surface a
   * deterministic coverage/ledger warning for the ambiguity.
   */
  hasConflict: boolean;
}

/** Result of replaying one (org, holder) group's events: its reconstructed intervals, plus whether any interval in the group observed a conflicting non-null `githubUserId` (see `ReconstructedInterval.hasConflict`). */
interface ReconstructedGroup {
  intervals: ReconstructedInterval[];
  hasConflict: boolean;
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
 *
 * GitHub identity attribution follows deterministic refresh semantics:
 * closing/opening an interval (an actual assignment transition) is the
 * only time its `githubUserId` is (re)established, taken from the event
 * that opens it. Any other event observed while the interval is already
 * active (a repeated assign, or a refresh) may only *fill in* a still-null
 * ID; a conflicting non-null ID is never applied over an already-known one
 * — the original attribution is preserved and `hasConflict` is set instead,
 * so the ambiguity is surfaced rather than silently resolved either way. A
 * refresh that repeats the same non-null ID is a pure no-op (retains it).
 */
function reconstructIntervals(sortedEvents: SeatLedgerAuditEventInput[]): ReconstructedGroup {
  const intervals: ReconstructedInterval[] = [];
  let active = false;
  let currentStart: string | null = null;
  let currentGithubUserId: number | null = null;
  let currentHasConflict = false;
  let groupHasConflict = false;

  for (const event of sortedEvents) {
    if (event.action === "assign" || event.action === "refresh") {
      if (!active) {
        // Assignment transition: opens a new interval, cleanly attributed
        // to this event's GitHub user ID.
        active = true;
        currentStart = event.occurredAt;
        currentGithubUserId = event.githubUserId ?? null;
        currentHasConflict = false;
      } else if (event.githubUserId != null) {
        // Non-transition event while already active: never overwrite an
        // established ID, only fill in a still-unknown one.
        if (currentGithubUserId == null) {
          currentGithubUserId = event.githubUserId;
        } else if (currentGithubUserId !== event.githubUserId) {
          currentHasConflict = true;
          groupHasConflict = true;
        }
      }
    } else {
      // action === "cancel"
      if (active) {
        intervals.push({
          assignedAt: currentStart as string,
          revokedAt: event.occurredAt,
          githubUserId: currentGithubUserId,
          hasConflict: currentHasConflict,
        });
        active = false;
        currentStart = null;
        currentGithubUserId = null;
        currentHasConflict = false;
      }
      // else: nothing active — stray cancel, no-op.
    }
  }

  if (active) {
    intervals.push({
      assignedAt: currentStart as string,
      revokedAt: null,
      githubUserId: currentGithubUserId,
      hasConflict: currentHasConflict,
    });
  }

  return { intervals, hasConflict: groupHasConflict };
}

/** ISO-normalize a timestamp (via `Date.parse`/`toISOString`) so equivalent instants always compare/compare equal regardless of the source's original formatting. */
function toIsoInstant(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

/**
 * Among a (org, holder) group's reconstructed intervals, select the single
 * interval overlapping `period` that represents the holder's *final* state
 * for that calendar month, rather than naively taking the first overlapping
 * interval in array order.
 *
 * Because `reconstructIntervals` replays events chronologically, a
 * within-month assign→cancel→assign(→cancel) sequence can produce two or
 * more distinct, non-overlapping-in-time intervals that nonetheless *all*
 * overlap the same calendar month (e.g. Jan 1–10 revoked, then Jan 20–open).
 * The canonical grain permits exactly one row per (holder, org, period), so
 * the interval with the latest `assignedAt` wins deterministically — never
 * a stale, already-revoked interval that merely happened to be reconstructed
 * first. `multipleOverlap` is reported back so the caller can surface a
 * deterministic, non-fatal coverage warning when this disambiguation
 * actually mattered.
 */
function selectOverlappingInterval(
  intervals: ReconstructedInterval[],
  period: string,
  currentPeriod: string,
): { interval: ReconstructedInterval; multipleOverlap: boolean } | null {
  const candidates = intervals.filter((interval) => {
    if (interval.revokedAt === null && period > currentPeriod) return false;
    return intervalOverlapsPeriod(interval.assignedAt, interval.revokedAt, period);
  });
  if (candidates.length === 0) return null;

  const sorted = [...candidates].sort((a, b) => {
    const aStart = Date.parse(a.assignedAt);
    const bStart = Date.parse(b.assignedAt);
    if (aStart !== bStart) return bStart - aStart; // latest assignedAt (most recent state) first.
    // Deterministic tie-break for the (practically unreachable) case of two
    // intervals with an identical assignedAt: a still-open interval outranks
    // a closed one, then the later revokedAt wins.
    const aOpen = a.revokedAt === null;
    const bOpen = b.revokedAt === null;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const aEnd = a.revokedAt === null ? Infinity : Date.parse(a.revokedAt);
    const bEnd = b.revokedAt === null ? Infinity : Date.parse(b.revokedAt);
    return bEnd - aEnd;
  });

  return { interval: sorted[0], multipleOverlap: candidates.length > 1 };
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
  const enterpriseSlug = normalizeEnterpriseSlug(options.enterpriseSlug);
  const { auditEvents = [], snapshots = [], liveSeats = [], periods, currentPeriod } = options;

  if (periods.length === 0) {
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

  const intervalsByGroup = new Map<string, ReconstructedGroup>();
  for (const [key, groupEvents] of eventsByGroup) {
    const sorted = sortEventsDeterministically(groupEvents);
    intervalsByGroup.set(key, reconstructIntervals(sorted));
  }

  // ── Universe of (org, holder) groups considered across all sources. ──
  // `snapshotIndex` keys are prefixed with billingPeriod (`period\0org\0holder`);
  // stripping that prefix already yields every (org, holder) group any
  // snapshot ever contributes — re-scanning the raw `snapshots` array here
  // would be provably redundant, since every snapshot is indexed above.
  const allGroupKeys = new Set<string>([...snapshotIndex.keys(), ...liveIndex.keys(), ...intervalsByGroup.keys()].map((k) => {
    const parts = k.split("\u0000");
    return parts.length === 3 ? `${parts[1]}\u0000${parts[2]}` : k;
  }));

  // Distinct orgs across all sources, used to enumerate coverage even for periods/orgs with zero holders (e.g. wholly unrecoverable periods for a known org).
  const allOrgs = new Set<string>();
  for (const key of allGroupKeys) allOrgs.add(key.split("\u0000")[0]);

  const rows: SeatLedgerRow[] = [];
  // coverageMap tracks a per-confidence observation count + warnings for
  // each (period, org). The overall reported confidence is computed
  // conservatively from these counts (see `worstConfidence` below) rather
  // than tracked as a single running "best" value, so that one
  // exactly-covered holder can never mask another, genuinely unrecoverable
  // holder in the same period/org.
  const coverageMap = new Map<string, { counts: Record<SeatLedgerConfidence, number>; warnings: Set<string> }>();

  const emptyConfidenceCounts = (): Record<SeatLedgerConfidence, number> => ({
    exact_snapshot: 0,
    audit_reconstructed: 0,
    live_snapshot_only: 0,
    unrecoverable: 0,
  });

  const recordCoverage = (period: string, org: string, confidence: SeatLedgerConfidence, warning?: string | string[]) => {
    const key = `${period}\u0000${org}`;
    let entry = coverageMap.get(key);
    if (!entry) {
      entry = { counts: emptyConfidenceCounts(), warnings: new Set() };
      coverageMap.set(key, entry);
    }
    entry.counts[confidence]++;
    if (warning) {
      for (const w of Array.isArray(warning) ? warning : [warning]) entry.warnings.add(w);
    }
  };

  // Ledger-wide warnings not tied to a single (period, org) pair — currently
  // populated exclusively by holder-key/numeric-GitHub-ID attribution
  // conflicts (see `ReconstructedInterval.hasConflict`): a login `holderKey`
  // observing more than one non-null `githubUserId` while a single
  // reconstructed interval remained active, without an intervening
  // assignment transition to disambiguate which account the interval
  // belongs to. Deduplicated per (org, holderKey) group and deterministic
  // (sorted) regardless of how many periods/rows the conflicted interval
  // overlaps. Never contains numeric IDs, logins, or other PII — only the
  // opaque `holderKey`/`orgLogin` already used elsewhere in this module's
  // warning text.
  const ledgerWarnings = new Set<string>();

  for (const period of periods) {
    for (const groupKeyStr of allGroupKeys) {
      const [org, holderKey] = groupKeyStr.split("\u0000");

      // Tier 1: stored authoritative monthly snapshot.
      const snapshot = snapshotIndex.get(`${period}\u0000${groupKeyStr}`);
      if (snapshot) {
        rows.push({
          enterpriseSlug,
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

      // Tier 2: audit-reconstructed interval overlapping this period. When
      // more than one reconstructed interval overlaps the same month (a
      // within-month assign→cancel→assign, or assign→cancel→assign→cancel),
      // the one reflecting the holder's final state for the month wins —
      // never the first, possibly-stale interval found.
      const reconstructed = intervalsByGroup.get(groupKeyStr);
      const selection = reconstructed ? selectOverlappingInterval(reconstructed.intervals, period, currentPeriod) : null;
      if (selection) {
        const { interval: overlapping, multipleOverlap } = selection;
        rows.push({
          enterpriseSlug,
          billingPeriod: period,
          orgLogin: org,
          holderKey,
          githubUserId: overlapping.githubUserId,
          observedLogin: null,
          assignedAt: toIsoInstant(overlapping.assignedAt),
          revokedAt: overlapping.revokedAt ? toIsoInstant(overlapping.revokedAt) : null,
          confidence: "audit_reconstructed",
          source: "audit_reconstructed",
        });
        const tierWarnings: string[] = [];
        if (multipleOverlap) {
          tierWarnings.push(
            `Multiple audit-reconstructed assignment intervals overlap period ${period} for holder "${holderKey}" in org "${org}"; deterministically selected the interval reflecting the holder's final state for the month (assignedAt ${toIsoInstant(overlapping.assignedAt)}).`,
          );
        }
        if (overlapping.hasConflict) {
          const conflictWarning = `Conflicting non-null GitHub user IDs observed for holder "${holderKey}" in org "${org}" while a single audit-reconstructed assignment interval remained active (period ${period}); retained the interval's originally attributed GitHub user ID rather than silently overwriting it.`;
          tierWarnings.push(conflictWarning);
          ledgerWarnings.add(
            `Holder-key/numeric-GitHub-ID conflict: holder "${holderKey}" in org "${org}" observed a conflicting non-null GitHub user ID within a single reconstructed assignment interval; the interval's original attribution was preserved.`,
          );
        }
        recordCoverage(period, org, "audit_reconstructed", tierWarnings.length > 0 ? tierWarnings : undefined);
        continue;
      }

      // Tier 3: current live snapshot, current period only.
      if (period === currentPeriod) {
        const live = liveIndex.get(groupKeyStr);
        if (live) {
          rows.push({
            enterpriseSlug,
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
      return {
        enterpriseSlug,
        billingPeriod,
        orgLogin,
        confidence: worstConfidence(value.counts),
        counts: value.counts,
        warnings: [...value.warnings].sort(),
      };
    })
    .sort((a, b) => (a.billingPeriod === b.billingPeriod ? a.orgLogin.localeCompare(b.orgLogin) : a.billingPeriod.localeCompare(b.billingPeriod)));

  rows.sort((a, b) => {
    if (a.billingPeriod !== b.billingPeriod) return a.billingPeriod.localeCompare(b.billingPeriod);
    if (a.orgLogin !== b.orgLogin) return a.orgLogin.localeCompare(b.orgLogin);
    return a.holderKey.localeCompare(b.holderKey);
  });

  return { rows, coverage, warnings: [...ledgerWarnings].sort() };
}
