// Seat lifecycle repository — onboarding / offboarding ledger for Copilot seats.
//
// WHY THIS EXISTS
// ---------------
// `copilot_seats` is a CURRENT snapshot: `replaceEnterpriseSeats()` deletes every
// row for an enterprise and re-inserts the live set on each sync. Onboarding is
// therefore recoverable from `copilot_seats.created_at`, but an offboarded seat
// simply disappears — there is no record that it ever existed. This module owns
// the append-only ledger that makes both directions queryable.
//
// SOURCES (see `SeatLifecycleSource`)
//   * `seat_created_at` — onboarding derived from `copilot_seats.created_at`.
//     Retroactive: works against already-synced data, so the feature has real
//     data the moment it ships, with no re-sync.
//   * `sync_diff` — offboarding detected by diffing the live seat snapshot
//     against the stored one during seat sync. Available to every install, but
//     only from the first sync after this feature ships onward.
//   * `audit_log` — both directions, with the exact instant GitHub recorded.
//     Fetched from the audit log API on every seat sync (`seat-audit-sync.ts`),
//     and additionally projected from `license_audit_events` when the optional
//     licensing-history sync is enabled.
//
// SOURCE PRECEDENCE is per-enterprise and window-scoped, not per-row: where the
// audit log has been read, audit rows are served and `sync_diff` rows are
// excluded. Per-row dedup would be fragile, because the audit log and the
// snapshot diff legitimately disagree on the exact date of the same offboard
// (the diff can only observe it at the next sync).
//
// The exclusion is bounded by the audit log's REAL coverage window
// (`copilot_seat_audit_sync_state.covered_from`/`covered_through`). The audit
// log API only retains a finite history and is fetched with a lookback, so
// outside that window the snapshot diff remains the only evidence an offboard
// happened — suppressing it there would silently delete history. When no state
// row exists (audit rows came from the licensing-history projection, or an
// older database), the whole queried window is treated as covered, preserving
// the original behavior.
//
// EMU DISPLAY RESOLUTION happens at read time, never at write time. Removed
// Enterprise Managed Users are frequently reported under an opaque GUID/hash
// rather than a real login, and the offboarding list is precisely the
// population most affected. `user_login` is part of the primary key, so
// rewriting it on write would split one human across two rows and would leave
// already-stored history wrong until a full re-sync. Resolving on read instead
// repairs existing rows retroactively and needs no migration. This is a display
// concern only: the stats/trend aggregates still count the stored login.

import { getDb } from "./database";
import { looksLikeRealGitHubLogin } from "../licensing/identity-resolver";

// ── Types ────────────────────────────────────────────────────────────────

export type SeatLifecycleEventType = "onboarded" | "offboarded";

export type SeatLifecycleSource = "seat_created_at" | "sync_diff" | "audit_log";

/** Which source is currently answering queries for the selected scope. */
export type SeatLifecycleSourceMode = "audit_log" | "sync_diff" | "none";

export interface SeatLifecycleEventInput {
  orgSlug: string;
  userLogin: string;
  userId?: number | null;
  eventType: SeatLifecycleEventType;
  /** Full ISO 8601 timestamp; `event_date` is derived from it. */
  occurredAt: string;
  planType?: string | null;
  assigningTeamSlug?: string | null;
  assigningTeamName?: string | null;
  lastActivityAt?: string | null;
  source: SeatLifecycleSource;
}

export interface SeatLifecycleRow {
  enterprise_slug: string;
  org_slug: string;
  user_login: string;
  display_login: string;
  login_resolved: boolean;
  user_id: number | null;
  event_type: SeatLifecycleEventType;
  event_date: string;
  occurred_at: string;
  plan_type: string | null;
  assigning_team_slug: string | null;
  assigning_team_name: string | null;
  last_activity_at: string | null;
  source: SeatLifecycleSource;
}

export interface SeatLifecycleStats {
  /** Distinct users with at least one onboarding event in the window. */
  onboardedUsers: number;
  /** Distinct users with at least one offboarding event in the window. */
  offboardedUsers: number;
  /** Raw per-org event counts (a multi-org user contributes more than one). */
  onboardedEvents: number;
  offboardedEvents: number;
  /** onboardedUsers - offboardedUsers. */
  netChange: number;
  /**
   * Offboarded users as a percentage of the current total seat count, or null
   * when there are no seats to divide by.
   */
  churnRate: number | null;
}

export interface SeatLifecycleTrendPoint {
  day: string;
  onboarded: number;
  offboarded: number;
  net: number;
}

export interface SeatLifecycleCoverage {
  /** Which source is answering for this scope. */
  source: SeatLifecycleSourceMode;
  /**
   * When snapshot-diff offboard tracking began (earliest across the scope), or
   * null when it has never run. Offboards before this date are unrecorded.
   */
  trackingStartedAt: string | null;
  /** True when onboarding rows exist but no offboarding source is active yet. */
  onboardingOnly: boolean;
  /** Per-source row counts inside the queried window, before precedence. */
  sourceBreakdown: Record<SeatLifecycleSource, number>;
  /** State of the audit-log sync for this scope. */
  audit: SeatLifecycleAuditCoverage;
}

/** How the audit-log source is doing for the selected scope. */
export interface SeatLifecycleAuditCoverage {
  /**
   * - `ok`          — the audit log was read successfully for at least one
   *                   enterprise in scope.
   * - `unavailable` — every enterprise in scope reported the audit log as
   *                   inaccessible (no audit log API access / missing scope).
   * - `error`       — the last attempt failed transiently.
   * - `never_run`   — the audit sync has not run for this scope yet.
   */
  status: "ok" | "unavailable" | "error" | "never_run";
  /** Why it is not `ok`, verbatim from the last attempt. */
  reason: string | null;
  /** Earliest instant the audit log has been read for (ISO 8601). */
  coveredFrom: string | null;
  /** Newest instant the audit log has been read through (ISO 8601). */
  coveredThrough: string | null;
  /** Most recent successful audit fetch (ISO 8601). */
  lastSyncedAt: string | null;
  /** True when a fetch hit its pagination cap, so coverage may be partial. */
  truncated: boolean;
}

/** Persisted state of the audit-log seat lifecycle sync for one enterprise. */
export interface SeatAuditSyncState {
  enterpriseSlug: string;
  status: "ok" | "unavailable" | "error";
  reason: string | null;
  target: "enterprise" | "org" | null;
  /** Earliest instant this run asked the audit log for (ISO 8601). */
  coveredFrom: string | null;
  /** Newest instant this run read through (ISO 8601). */
  coveredThrough: string | null;
  lastEventAt: string | null;
  lastSyncedAt: string;
  eventsWritten: number;
  truncated: boolean;
}

export interface SeatLifecycleQuery {
  /** Inclusive window start, 'YYYY-MM-DD'. */
  start: string;
  /** Inclusive window end, 'YYYY-MM-DD'. */
  end: string;
  enterpriseSlugs?: string[];
  orgs?: string[];
  allowedLogins?: Set<string>;
}

export interface SeatLifecycleCoverageQuery {
  /** Inclusive window start, 'YYYY-MM-DD'. */
  start: string;
  /** Inclusive window end, 'YYYY-MM-DD'. */
  end: string;
  enterpriseSlugs?: string[];
  orgs?: string[];
  allowedLogins?: Set<string>;
}

export interface SeatLifecyclePagination {
  page: number;
  pageSize: number;
  sort: string;
  sortDir: "asc" | "desc";
}

export interface PaginatedSeatLifecycleRows {
  rows: SeatLifecycleRow[];
  total: number;
}

/** Sortable columns, allowlisted — never interpolate a caller-supplied column. */
export const SEAT_LIFECYCLE_SORT_COLUMNS: readonly string[] = [
  "event_date",
  "user_login",
  "org_slug",
  "plan_type",
  "last_activity_at",
  "assigning_team_name",
];

/** Hard cap on CSV export rows, mirroring the license-reconciliation export. */
export const SEAT_LIFECYCLE_EXPORT_MAX_ROWS = 5000;

/**
 * Resolve display logins in chunks so the target CTE stays below SQLite's bound
 * variable ceiling. Node v26.2.0's SQLite 3.53.1 build allows 32,766 variables,
 * and this lookup binds two per target (16,383 targets max), so 1,000 targets
 * keeps a wide margin even if the export cap or SQLite build changes.
 */
export const LOGIN_RESOLUTION_TARGET_CHUNK_SIZE = 1000;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract the 'YYYY-MM-DD' grain from an ISO timestamp or date string. */
export function toEventDate(value: string): string {
  return value.slice(0, 10);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

interface SqlFragment {
  sql: string;
  params: unknown[];
}

interface LoginResolutionCandidate {
  enterprise_slug: string;
  user_id: number;
  source_rank: number;
  login: string | null;
  occurred_at: string | null;
}

function inClause(column: string, values: readonly string[]): SqlFragment {
  return {
    sql: ` AND ${column} IN (${values.map(() => "?").join(",")})`,
    params: [...values],
  };
}

function allowedLoginsClause(column: string, allowedLogins?: Set<string>): SqlFragment {
  if (!allowedLogins) return { sql: "", params: [] };
  const logins = Array.from(allowedLogins, normalizeLogin);
  if (logins.length === 0) return { sql: " AND 1 = 0", params: [] };
  return {
    sql: ` AND LOWER(${column}) IN (${logins.map(() => "?").join(",")})`,
    params: logins,
  };
}

function isUserIdPlaceholder(login: string, userId: number | null): boolean {
  return userId != null && login === `user-${userId}`;
}

function withDefaultDisplayLogins(rows: SeatLifecycleRow[]): SeatLifecycleRow[] {
  return rows.map((row) => ({
    ...row,
    display_login: row.display_login ?? row.user_login,
    login_resolved: row.login_resolved ?? false,
  }));
}

function tableExists(db: ReturnType<typeof getDb>, tableName: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * Extra predicate that decides whether an audit-log row is authoritative enough
 * to hide a snapshot-diff row for the same enterprise/query window.
 *
 * Databases that predate `copilot_seat_audit_sync_state` keep the original
 * legacy behavior: any audit-log row in the selected window wins. Once the state
 * table exists, suppression needs positive proof that this row was covered.
 * NULL coverage bounds mean "this run proved nothing enterprise-wide", except
 * for legacy licensing-history rows whose source table can prove day-level
 * audit coverage independently.
 */
function buildAuditPrecedenceCoverageClause(outerTable: string): string {
  const db = getDb();
  if (!tableExists(db, "copilot_seat_audit_sync_state")) return "";

  const licensingHistoryCoverage = tableExists(db, "license_audit_events")
    ? `
        OR EXISTS (
          SELECT 1 FROM license_audit_events license_audit
          WHERE license_audit.enterprise_slug = ${outerTable}.enterprise_slug
            AND license_audit.action IN ('assign', 'cancel')
            AND license_audit.occurred_at IS NOT NULL
            AND length(license_audit.occurred_at) >= 10
            AND substr(license_audit.occurred_at, 1, 10) = ${outerTable}.event_date
        )`
    : "";

  return `
      AND (
        EXISTS (
          SELECT 1 FROM copilot_seat_audit_sync_state state
          WHERE state.enterprise_slug = ${outerTable}.enterprise_slug
            AND state.covered_from IS NOT NULL
            AND state.covered_through IS NOT NULL
            AND julianday(${outerTable}.occurred_at) IS NOT NULL
            AND julianday(state.covered_from) IS NOT NULL
            AND julianday(state.covered_through) IS NOT NULL
            AND julianday(${outerTable}.occurred_at) >= julianday(state.covered_from)
            AND julianday(${outerTable}.occurred_at) <= julianday(state.covered_through)
        )${licensingHistoryCoverage}
        OR NOT EXISTS (
          SELECT 1 FROM copilot_seat_audit_sync_state state
          WHERE state.enterprise_slug = ${outerTable}.enterprise_slug
        )
      )`;
}

function targetKey(enterpriseSlug: string, userId: number): string {
  return `${enterpriseSlug}\u0000${userId}`;
}

function shouldResolveDisplayLogin(row: SeatLifecycleRow): boolean {
  if (row.user_id == null) return false;
  return !looksLikeRealGitHubLogin(row.user_login) || isUserIdPlaceholder(row.user_login, row.user_id);
}

function selectBestLoginCandidate(candidates: LoginResolutionCandidate[]): string | null {
  const realCandidates = candidates
    .map((candidate) => {
      const login = candidate.login?.trim() ?? "";
      if (!looksLikeRealGitHubLogin(login)) return null;
      const occurredAtMs = Date.parse(candidate.occurred_at ?? "");
      return {
        sourceRank: candidate.source_rank,
        login: normalizeLogin(login),
        occurredAtMs: Number.isNaN(occurredAtMs) ? 0 : occurredAtMs,
      };
    })
    .filter((candidate): candidate is { sourceRank: number; login: string; occurredAtMs: number } => candidate !== null);

  if (realCandidates.length === 0) return null;
  return [...realCandidates].sort((a, b) => {
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
    if (a.occurredAtMs !== b.occurredAtMs) return b.occurredAtMs - a.occurredAtMs;
    return a.login.localeCompare(b.login);
  })[0].login;
}

function resolveDisplayLogins(rows: SeatLifecycleRow[]): SeatLifecycleRow[] {
  const withDefaults = withDefaultDisplayLogins(rows);
  const targetRows = withDefaults.filter(shouldResolveDisplayLogin);
  if (targetRows.length === 0) return withDefaults;

  const uniqueTargets = new Map<string, { enterpriseSlug: string; userId: number }>();
  for (const row of targetRows) {
    if (row.user_id == null) continue;
    uniqueTargets.set(targetKey(row.enterprise_slug, row.user_id), {
      enterpriseSlug: row.enterprise_slug,
      userId: row.user_id,
    });
  }
  const targets = [...uniqueTargets.values()];
  if (targets.length === 0) return withDefaults;

  const db = getDb();
  const hasIdentityRecords = tableExists(db, "license_identity_records");
  const hasPeriodRows = tableExists(db, "license_period_rows");
  const hasAuditEvents = tableExists(db, "license_audit_events");
  if (!hasIdentityRecords && !hasPeriodRows && !hasAuditEvents) return withDefaults;

  const selects: string[] = [];

  if (hasIdentityRecords) {
    selects.push(`
      SELECT target.enterprise_slug, target.user_id, 1 AS source_rank,
             identity.resolved_login AS login, identity.observed_at AS occurred_at
      FROM target
      JOIN license_identity_records identity
        ON identity.enterprise_slug = target.enterprise_slug
       AND identity.github_user_id = target.user_id
      WHERE NULLIF(identity.resolved_login, '') IS NOT NULL
    `);
  }
  if (hasPeriodRows) {
    selects.push(`
      SELECT target.enterprise_slug, target.user_id, 2 AS source_rank,
             period.resolved_user_login AS login, period.billing_period AS occurred_at
      FROM target
      JOIN license_period_rows period
        ON period.enterprise_slug = target.enterprise_slug
       AND period.github_user_id = target.user_id
      WHERE NULLIF(period.resolved_user_login, '') IS NOT NULL
    `);
  }
  if (hasAuditEvents) {
    selects.push(`
      SELECT target.enterprise_slug, target.user_id, 3 AS source_rank,
             audit.observed_login AS login, audit.occurred_at AS occurred_at
      FROM target
      JOIN license_audit_events audit
        ON audit.enterprise_slug = target.enterprise_slug
       AND audit.github_user_id = target.user_id
      WHERE NULLIF(audit.observed_login, '') IS NOT NULL
    `);
  }

  const candidates: LoginResolutionCandidate[] = [];
  for (let index = 0; index < targets.length; index += LOGIN_RESOLUTION_TARGET_CHUNK_SIZE) {
    const chunk = targets.slice(index, index + LOGIN_RESOLUTION_TARGET_CHUNK_SIZE);
    const valuesSql = chunk.map(() => "(?, ?)").join(",");
    const targetParams = chunk.flatMap((target) => [target.enterpriseSlug, target.userId]);
    const chunkCandidates = db.prepare(`
      WITH target(enterprise_slug, user_id) AS (VALUES ${valuesSql})
      ${selects.join("\nUNION ALL\n")}
    `).all(...targetParams) as LoginResolutionCandidate[];
    // Appended in a loop rather than push(...spread): a chunk can return many
    // candidates per target, and spreading them as arguments risks a RangeError.
    for (const candidate of chunkCandidates) candidates.push(candidate);
  }

  const candidatesByTarget = new Map<string, LoginResolutionCandidate[]>();
  for (const candidate of candidates) {
    const key = targetKey(candidate.enterprise_slug, candidate.user_id);
    const list = candidatesByTarget.get(key) ?? [];
    list.push(candidate);
    candidatesByTarget.set(key, list);
  }

  const resolvedByTarget = new Map<string, string>();
  for (const [key, list] of candidatesByTarget) {
    const best = selectBestLoginCandidate(list);
    if (best) resolvedByTarget.set(key, best);
  }

  return withDefaults.map((row) => {
    if (row.user_id == null) return row;
    const resolved = resolvedByTarget.get(targetKey(row.enterprise_slug, row.user_id));
    if (!resolved || resolved === row.user_login) return row;
    return { ...row, display_login: resolved, login_resolved: true };
  });
}

/**
 * Build the shared WHERE clause for every lifecycle query.
 *
 * The `sync_diff` exclusion implements per-enterprise source precedence: rows
 * from the snapshot diff are hidden for any enterprise that also has audit-log
 * rows in the queried window, so the two sources never double-count the same
 * offboard.
 */
function buildLifecycleFilter(query: SeatLifecycleQuery): SqlFragment {
  const params: unknown[] = [query.start, query.end];
  let sql = "WHERE event_date >= ? AND event_date <= ?";

  if (query.enterpriseSlugs?.length) {
    const frag = inClause("enterprise_slug", query.enterpriseSlugs);
    sql += frag.sql;
    params.push(...frag.params);
  }

  if (query.orgs?.length) {
    const frag = inClause("org_slug", query.orgs);
    sql += frag.sql;
    params.push(...frag.params);
  }

  const loginScope = allowedLoginsClause("user_login", query.allowedLogins);
  sql += loginScope.sql;
  params.push(...loginScope.params);

  const auditPrecedenceCoverage = buildAuditPrecedenceCoverageClause("copilot_seat_lifecycle_events");
  sql += `
    AND NOT (
      copilot_seat_lifecycle_events.source = 'sync_diff'
      AND EXISTS (
        SELECT 1 FROM copilot_seat_lifecycle_events audit
        WHERE audit.enterprise_slug = copilot_seat_lifecycle_events.enterprise_slug
          AND audit.source = 'audit_log'
          AND audit.event_date >= ?
          AND audit.event_date <= ?
      )${auditPrecedenceCoverage}
    )`;
  params.push(query.start, query.end);

  return { sql, params };
}

// ── Writes ───────────────────────────────────────────────────────────────

/** Persist lifecycle events idempotently. Returns the number of rows written. */
export function recordSeatLifecycleEvents(
  enterpriseSlug: string,
  events: SeatLifecycleEventInput[],
): number {
  if (events.length === 0) return 0;
  const db = getDb();
  const detectedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO copilot_seat_lifecycle_events (
      enterprise_slug, org_slug, user_login, user_id, event_type, event_date,
      occurred_at, plan_type, assigning_team_slug, assigning_team_name,
      last_activity_at, source, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(enterprise_slug, org_slug, user_login, event_type, event_date, source) DO UPDATE SET
      -- Audit-log overlap replays often carry no seat metadata. Treat NULL as
      -- "unknown" for user_id and seat-detail columns so a replay cannot erase
      -- historical details; non-NULL replays can still fill or refresh them.
      -- occurred_at and detected_at describe this observation, so refresh them.
      user_id = COALESCE(excluded.user_id, copilot_seat_lifecycle_events.user_id),
      occurred_at = excluded.occurred_at,
      plan_type = COALESCE(excluded.plan_type, copilot_seat_lifecycle_events.plan_type),
      assigning_team_slug = COALESCE(
        excluded.assigning_team_slug,
        copilot_seat_lifecycle_events.assigning_team_slug
      ),
      assigning_team_name = COALESCE(
        excluded.assigning_team_name,
        copilot_seat_lifecycle_events.assigning_team_name
      ),
      last_activity_at = COALESCE(excluded.last_activity_at, copilot_seat_lifecycle_events.last_activity_at),
      detected_at = excluded.detected_at
  `);

  let written = 0;
  const tx = db.transaction(() => {
    for (const event of events) {
      if (!event.userLogin || !event.occurredAt) continue;
      stmt.run(
        enterpriseSlug,
        event.orgSlug ?? "",
        event.userLogin,
        event.userId ?? null,
        event.eventType,
        toEventDate(event.occurredAt),
        event.occurredAt,
        event.planType ?? null,
        event.assigningTeamSlug ?? null,
        event.assigningTeamName ?? null,
        event.lastActivityAt ?? null,
        event.source,
        detectedAt,
      );
      written++;
    }
  });
  tx();
  return written;
}

/**
 * Derive `onboarded` events from the current `copilot_seats` snapshot.
 *
 * Runs entirely in SQL and is safe to re-run on every sync. Rows with a missing
 * or malformed `created_at` are skipped rather than written with a bogus date —
 * `created_at` is nullable in the schema even though `SeatRow` types it as a
 * string.
 */
export function backfillOnboardingFromSeats(enterpriseSlug?: string): number {
  const db = getDb();
  const detectedAt = new Date().toISOString();
  const scope = enterpriseSlug ? " AND enterprise_slug = ?" : "";
  const params: unknown[] = enterpriseSlug ? [detectedAt, enterpriseSlug] : [detectedAt];

  const result = db.prepare(`
    INSERT OR REPLACE INTO copilot_seat_lifecycle_events (
      enterprise_slug, org_slug, user_login, user_id, event_type, event_date,
      occurred_at, plan_type, assigning_team_slug, assigning_team_name,
      last_activity_at, source, detected_at
    )
    SELECT
      enterprise_slug, org_slug, user_login, user_id, 'onboarded',
      substr(created_at, 1, 10), created_at, plan_type,
      assigning_team_slug, assigning_team_name, last_activity_at,
      'seat_created_at', ?
    FROM copilot_seats
    WHERE created_at IS NOT NULL
      AND length(created_at) >= 10
      AND substr(created_at, 5, 1) = '-'${scope}
  `).run(...params);

  return result.changes;
}

/**
 * Project `license_audit_events` assign/cancel rows into the ledger.
 *
 * No-ops when the licensing-history tables are empty or absent, so it is safe
 * to call unconditionally. Login casing differs between the audit log and the
 * seat snapshot, so the seat join is `LOWER()`-normalized.
 *
 * Writes the same `(…, source='audit_log')` primary keys as the always-on audit
 * sync, so it uses the same non-destructive upsert: the seat `LEFT JOIN` yields
 * NULL metadata once an offboarded user is gone from `copilot_seats`, and a
 * plain replace would erase details an earlier run had already captured.
 */
export function projectAuditEventsToLifecycle(enterpriseSlug: string): number {
  const db = getDb();
  const detectedAt = new Date().toISOString();

  try {
    const result = db.prepare(`
      INSERT INTO copilot_seat_lifecycle_events (
        enterprise_slug, org_slug, user_login, user_id, event_type, event_date,
        occurred_at, plan_type, assigning_team_slug, assigning_team_name,
        last_activity_at, source, detected_at
      )
      SELECT
        audit.enterprise_slug,
        audit.org_login,
        COALESCE(NULLIF(audit.observed_login, ''), seat.user_login, 'user-' || audit.github_user_id),
        COALESCE(audit.github_user_id, seat.user_id),
        CASE WHEN audit.action = 'cancel' THEN 'offboarded' ELSE 'onboarded' END,
        substr(audit.occurred_at, 1, 10),
        audit.occurred_at,
        seat.plan_type,
        seat.assigning_team_slug,
        seat.assigning_team_name,
        seat.last_activity_at,
        'audit_log',
        ?
      FROM license_audit_events audit
      LEFT JOIN copilot_seats seat
        ON seat.enterprise_slug = audit.enterprise_slug
       AND LOWER(seat.org_slug) = LOWER(audit.org_login)
       AND LOWER(seat.user_login) = LOWER(audit.observed_login)
      WHERE audit.enterprise_slug = ?
        AND audit.action IN ('assign', 'cancel')
        AND audit.occurred_at IS NOT NULL
        AND length(audit.occurred_at) >= 10
        -- Without a login, seat match, or GitHub user id, there is no stable PK.
        AND (
          NULLIF(audit.observed_login, '') IS NOT NULL
          OR seat.user_login IS NOT NULL
          OR audit.github_user_id IS NOT NULL
        )
      ON CONFLICT(enterprise_slug, org_slug, user_login, event_type, event_date, source) DO UPDATE SET
        user_id = COALESCE(excluded.user_id, copilot_seat_lifecycle_events.user_id),
        occurred_at = excluded.occurred_at,
        plan_type = COALESCE(excluded.plan_type, copilot_seat_lifecycle_events.plan_type),
        assigning_team_slug = COALESCE(
          excluded.assigning_team_slug,
          copilot_seat_lifecycle_events.assigning_team_slug
        ),
        assigning_team_name = COALESCE(
          excluded.assigning_team_name,
          copilot_seat_lifecycle_events.assigning_team_name
        ),
        last_activity_at = COALESCE(
          excluded.last_activity_at,
          copilot_seat_lifecycle_events.last_activity_at
        ),
        detected_at = excluded.detected_at
    `).run(detectedAt, enterpriseSlug);
    return result.changes;
  } catch {
    // licensing-history tables not present — this source is simply unavailable.
    return 0;
  }
}

/**
 * Fill in seat metadata (plan, team, last activity) on audit-sourced rows.
 *
 * The audit log reports who and when, but not the seat's plan or assigning
 * team, so those columns are backfilled from the current `copilot_seats`
 * snapshot. Login casing differs between the two, so the join is
 * `LOWER()`-normalized. Only NULL columns are written, so an enrichment run
 * never overwrites richer data another source already supplied, and a seat that
 * has since been removed simply leaves the columns NULL.
 */
export function enrichAuditLifecycleFromSeats(enterpriseSlug: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE copilot_seat_lifecycle_events AS events
    SET
      plan_type = COALESCE(events.plan_type, (
        SELECT seat.plan_type FROM copilot_seats seat
        WHERE seat.enterprise_slug = events.enterprise_slug
          AND LOWER(seat.org_slug) = LOWER(events.org_slug)
          AND LOWER(seat.user_login) = LOWER(events.user_login)
      )),
      assigning_team_slug = COALESCE(events.assigning_team_slug, (
        SELECT seat.assigning_team_slug FROM copilot_seats seat
        WHERE seat.enterprise_slug = events.enterprise_slug
          AND LOWER(seat.org_slug) = LOWER(events.org_slug)
          AND LOWER(seat.user_login) = LOWER(events.user_login)
      )),
      assigning_team_name = COALESCE(events.assigning_team_name, (
        SELECT seat.assigning_team_name FROM copilot_seats seat
        WHERE seat.enterprise_slug = events.enterprise_slug
          AND LOWER(seat.org_slug) = LOWER(events.org_slug)
          AND LOWER(seat.user_login) = LOWER(events.user_login)
      )),
      last_activity_at = COALESCE(events.last_activity_at, (
        SELECT seat.last_activity_at FROM copilot_seats seat
        WHERE seat.enterprise_slug = events.enterprise_slug
          AND LOWER(seat.org_slug) = LOWER(events.org_slug)
          AND LOWER(seat.user_login) = LOWER(events.user_login)
      ))
    WHERE events.enterprise_slug = ?
      AND events.source = 'audit_log'
      AND (
        events.plan_type IS NULL
        OR events.assigning_team_slug IS NULL
        OR events.assigning_team_name IS NULL
        OR events.last_activity_at IS NULL
      )
  `).run(enterpriseSlug);
  return result.changes;
}

/**
 * Persist the outcome of one audit-log seat lifecycle sync run.
 *
 * `covered_from` only ever moves BACKWARD and `covered_through` only ever moves
 * FORWARD, so the stored pair always describes the union of every window the
 * audit log has actually been read for — which is what the precedence rule in
 * `buildLifecycleFilter()` and the UI's coverage statement both depend on. A
 * failed or unavailable run records its status and reason but must not shrink
 * an earlier successful run's coverage or clear its truncation retry marker.
 */
export function recordSeatAuditSyncState(state: SeatAuditSyncState): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO copilot_seat_audit_sync_state (
      enterprise_slug, status, reason, target, covered_from, covered_through,
      last_event_at, last_synced_at, events_written, truncated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(enterprise_slug) DO UPDATE SET
      status = excluded.status,
      reason = excluded.reason,
      target = COALESCE(excluded.target, copilot_seat_audit_sync_state.target),
      covered_from = CASE
        WHEN excluded.covered_from IS NULL THEN copilot_seat_audit_sync_state.covered_from
        WHEN copilot_seat_audit_sync_state.covered_from IS NULL THEN excluded.covered_from
        WHEN excluded.covered_from < copilot_seat_audit_sync_state.covered_from THEN excluded.covered_from
        ELSE copilot_seat_audit_sync_state.covered_from
      END,
      covered_through = CASE
        WHEN excluded.covered_through IS NULL THEN copilot_seat_audit_sync_state.covered_through
        WHEN copilot_seat_audit_sync_state.covered_through IS NULL THEN excluded.covered_through
        WHEN excluded.covered_through > copilot_seat_audit_sync_state.covered_through THEN excluded.covered_through
        ELSE copilot_seat_audit_sync_state.covered_through
      END,
      last_event_at = COALESCE(excluded.last_event_at, copilot_seat_audit_sync_state.last_event_at),
      last_synced_at = excluded.last_synced_at,
      events_written = excluded.events_written,
      truncated = CASE
        WHEN excluded.status = 'ok' THEN excluded.truncated
        ELSE copilot_seat_audit_sync_state.truncated
      END
  `).run(
    state.enterpriseSlug,
    state.status,
    state.reason,
    state.target,
    state.coveredFrom,
    state.coveredThrough,
    state.lastEventAt,
    state.lastSyncedAt,
    state.eventsWritten,
    state.truncated ? 1 : 0,
  );
}

/**
 * Drop the recorded coverage window for one enterprise, keeping the rest of its
 * state row.
 *
 * `recordSeatAuditSyncState` deliberately never shrinks coverage, because an
 * ordinary failed run must not discard what an earlier successful run proved.
 * Partial org-fallback success is the one case that needs the opposite: the
 * state row is enterprise-scoped, so an enterprise-wide window would hand
 * audit-log precedence to orgs that never answered, hiding their snapshot-
 * derived offboards. Clearing the window costs nothing but a re-read.
 */
export function clearSeatAuditCoverageWindow(enterpriseSlug: string): void {
  getDb().prepare(`
    UPDATE copilot_seat_audit_sync_state
    SET covered_from = NULL,
        covered_through = NULL
    WHERE enterprise_slug = ?
  `).run(enterpriseSlug);
}

/**
 * Read stored audit sync state. Returns an empty array when the audit sync has
 * never run or the table does not exist yet (older database).
 */
export function getSeatAuditSyncStates(enterpriseSlugs?: string[]): SeatAuditSyncState[] {
  const db = getDb();
  if (!tableExists(db, "copilot_seat_audit_sync_state")) return [];

  const scope = enterpriseSlugs?.length ? inClause("enterprise_slug", enterpriseSlugs) : { sql: "", params: [] };
  const rows = db.prepare(`
    SELECT enterprise_slug, status, reason, target, covered_from, covered_through,
           last_event_at, last_synced_at, events_written, truncated
    FROM copilot_seat_audit_sync_state
    WHERE 1 = 1${scope.sql}
  `).all(...scope.params) as Record<string, unknown>[];

  return rows.map((row) => ({
    enterpriseSlug: row.enterprise_slug as string,
    status: row.status as SeatAuditSyncState["status"],
    reason: (row.reason as string | null) ?? null,
    target: (row.target as SeatAuditSyncState["target"]) ?? null,
    coveredFrom: (row.covered_from as string | null) ?? null,
    coveredThrough: (row.covered_through as string | null) ?? null,
    lastEventAt: (row.last_event_at as string | null) ?? null,
    lastSyncedAt: row.last_synced_at as string,
    eventsWritten: Number(row.events_written ?? 0),
    truncated: Number(row.truncated ?? 0) === 1,
  }));
}

/**
 * The instant the audit log has already been read through for an enterprise,
 * or null when it has never been read successfully. Callers use this as the
 * incremental watermark.
 */
export function getSeatAuditWatermark(enterpriseSlug: string): string | null {
  const [state] = getSeatAuditSyncStates([enterpriseSlug]);
  return state?.coveredThrough ?? null;
}

/** Seat identity as observed in a snapshot, keyed per org. */
export interface SeatSnapshotEntry {  orgSlug: string;
  userLogin: string;
  userId?: number | null;
  planType?: string | null;
  assigningTeamSlug?: string | null;
  assigningTeamName?: string | null;
  lastActivityAt?: string | null;
}

function seatKey(orgSlug: string, userLogin: string): string {
  return `${orgSlug.toLowerCase()}\u0000${normalizeLogin(userLogin)}`;
}

/**
 * Pure snapshot diff: seats present before but absent after are offboarded.
 *
 * `orgsInScope` is the safety valve. During the org-fallback sync path each org
 * is fetched independently and a fetch can fail; an org whose fetch failed must
 * be excluded here, otherwise its entire seat list would be misread as a mass
 * offboarding. Pass `undefined` only when the snapshot is authoritative for
 * every org (the enterprise-wide path).
 */
export function diffSeatSnapshot(
  previous: SeatSnapshotEntry[],
  current: SeatSnapshotEntry[],
  occurredAt: string,
  orgsInScope?: readonly string[],
): SeatLifecycleEventInput[] {
  const scope = orgsInScope ? new Set(orgsInScope.map((o) => o.toLowerCase())) : null;
  const currentKeys = new Set(current.map((seat) => seatKey(seat.orgSlug, seat.userLogin)));

  const events: SeatLifecycleEventInput[] = [];
  for (const seat of previous) {
    if (scope && !scope.has(seat.orgSlug.toLowerCase())) continue;
    if (currentKeys.has(seatKey(seat.orgSlug, seat.userLogin))) continue;
    events.push({
      orgSlug: seat.orgSlug,
      userLogin: seat.userLogin,
      userId: seat.userId ?? null,
      eventType: "offboarded",
      occurredAt,
      planType: seat.planType ?? null,
      assigningTeamSlug: seat.assigningTeamSlug ?? null,
      assigningTeamName: seat.assigningTeamName ?? null,
      lastActivityAt: seat.lastActivityAt ?? null,
      source: "sync_diff",
    });
  }
  return events;
}

/** Read the stored seat snapshot for diffing, optionally limited to some orgs. */
export function getSeatSnapshotForDiff(
  enterpriseSlug: string,
  orgs?: readonly string[],
): SeatSnapshotEntry[] {
  const db = getDb();
  let sql = `
    SELECT org_slug, user_login, user_id, plan_type,
           assigning_team_slug, assigning_team_name, last_activity_at
    FROM copilot_seats
    WHERE enterprise_slug = ?
  `;
  const params: unknown[] = [enterpriseSlug];
  if (orgs?.length) {
    sql += ` AND LOWER(org_slug) IN (${orgs.map(() => "?").join(",")})`;
    params.push(...orgs.map((o) => o.toLowerCase()));
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    orgSlug: row.org_slug as string,
    userLogin: row.user_login as string,
    userId: (row.user_id as number | null) ?? null,
    planType: (row.plan_type as string | null) ?? null,
    assigningTeamSlug: (row.assigning_team_slug as string | null) ?? null,
    assigningTeamName: (row.assigning_team_name as string | null) ?? null,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
  }));
}

/**
 * Record the moment snapshot-diff tracking first ran for an enterprise. Only the
 * first value is kept, so the UI can state truthfully how far back offboard
 * coverage extends.
 */
export function markSeatLifecycleTrackingStarted(
  enterpriseSlug: string,
  startedAt = new Date().toISOString(),
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO copilot_seat_lifecycle_coverage (enterprise_slug, tracking_started_at)
    VALUES (?, ?)
    ON CONFLICT(enterprise_slug) DO NOTHING
  `).run(enterpriseSlug, startedAt);
}

// ── Reads ────────────────────────────────────────────────────────────────

export function getSeatLifecycleStats(query: SeatLifecycleQuery): SeatLifecycleStats {
  const db = getDb();
  const filter = buildLifecycleFilter(query);

  const row = db.prepare(`
    SELECT
      COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'onboarded' THEN LOWER(user_login) END), 0) AS onboarded_users,
      COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'offboarded' THEN LOWER(user_login) END), 0) AS offboarded_users,
      COALESCE(SUM(CASE WHEN event_type = 'onboarded' THEN 1 ELSE 0 END), 0) AS onboarded_events,
      COALESCE(SUM(CASE WHEN event_type = 'offboarded' THEN 1 ELSE 0 END), 0) AS offboarded_events
    FROM copilot_seat_lifecycle_events
    ${filter.sql}
  `).get(...filter.params) as Record<string, number> | undefined;

  const onboardedUsers = row?.onboarded_users ?? 0;
  const offboardedUsers = row?.offboarded_users ?? 0;

  // Churn is measured against the current seat population, which lives in
  // `copilot_seats` — the ledger cannot know the denominator on its own.
  const seatParams: unknown[] = [];
  let seatSql = "SELECT COUNT(*) AS total FROM copilot_seats WHERE 1 = 1";
  if (query.enterpriseSlugs?.length) {
    const frag = inClause("enterprise_slug", query.enterpriseSlugs);
    seatSql += frag.sql;
    seatParams.push(...frag.params);
  }
  if (query.orgs?.length) {
    const frag = inClause("org_slug", query.orgs);
    seatSql += frag.sql;
    seatParams.push(...frag.params);
  }
  const loginScope = allowedLoginsClause("user_login", query.allowedLogins);
  seatSql += loginScope.sql;
  seatParams.push(...loginScope.params);
  const totalSeats = (db.prepare(seatSql).get(...seatParams) as { total: number } | undefined)?.total ?? 0;

  return {
    onboardedUsers,
    offboardedUsers,
    onboardedEvents: row?.onboarded_events ?? 0,
    offboardedEvents: row?.offboarded_events ?? 0,
    netChange: onboardedUsers - offboardedUsers,
    churnRate: totalSeats > 0 ? Number(((offboardedUsers / totalSeats) * 100).toFixed(1)) : null,
  };
}

export function getSeatLifecycleTrend(query: SeatLifecycleQuery): SeatLifecycleTrendPoint[] {
  const db = getDb();
  const filter = buildLifecycleFilter(query);

  const rows = db.prepare(`
    SELECT
      event_date AS day,
      COALESCE(SUM(CASE WHEN event_type = 'onboarded' THEN 1 ELSE 0 END), 0) AS onboarded,
      COALESCE(SUM(CASE WHEN event_type = 'offboarded' THEN 1 ELSE 0 END), 0) AS offboarded
    FROM copilot_seat_lifecycle_events
    ${filter.sql}
    GROUP BY event_date
    ORDER BY event_date ASC
  `).all(...filter.params) as Record<string, unknown>[];

  return rows.map((row) => {
    const onboarded = Number(row.onboarded ?? 0);
    const offboarded = Number(row.offboarded ?? 0);
    return { day: row.day as string, onboarded, offboarded, net: onboarded - offboarded };
  });
}

export function getSeatLifecycleRows(
  query: SeatLifecycleQuery,
  eventType: SeatLifecycleEventType,
  pagination: SeatLifecyclePagination,
): PaginatedSeatLifecycleRows {
  const db = getDb();
  const filter = buildLifecycleFilter(query);
  const where = `${filter.sql} AND event_type = ?`;
  const params = [...filter.params, eventType];

  const total = (db.prepare(`
    SELECT COUNT(*) AS total FROM copilot_seat_lifecycle_events ${where}
  `).get(...params) as { total: number } | undefined)?.total ?? 0;

  const sortColumn = SEAT_LIFECYCLE_SORT_COLUMNS.includes(pagination.sort)
    ? pagination.sort
    : "event_date";
  const sortDir = pagination.sortDir === "asc" ? "ASC" : "DESC";
  const offset = (pagination.page - 1) * pagination.pageSize;

  const rows = db.prepare(`
    SELECT enterprise_slug, org_slug, user_login, user_id, event_type, event_date,
           occurred_at, plan_type, assigning_team_slug, assigning_team_name,
           last_activity_at, source
    FROM copilot_seat_lifecycle_events
    ${where}
    ORDER BY ${sortColumn} ${sortDir}, user_login ASC
    LIMIT ? OFFSET ?
  `).all(...params, pagination.pageSize, offset) as SeatLifecycleRow[];

  return { rows: resolveDisplayLogins(rows), total };
}

/**
 * Coverage metadata for the selected lifecycle window.
 *
 * Audit-log source precedence is window-scoped to match buildLifecycleFilter().
 * Snapshot-diff tracking start remains ledger metadata and is scoped only by
 * enterprise, not by the selected date range.
 */
export function getSeatLifecycleCoverage(
  query?: SeatLifecycleCoverageQuery,
): SeatLifecycleCoverage {
  const db = getDb();
  const enterpriseSlugs = query?.enterpriseSlugs;

  const buildScope = (column: string): SqlFragment => {
    if (!enterpriseSlugs?.length) return { sql: "", params: [] };
    return inClause(column, enterpriseSlugs);
  };

  const buildEventScope = (): SqlFragment => {
    let sql = "";
    const params: unknown[] = [];
    const enterpriseScope = buildScope("enterprise_slug");
    sql += enterpriseScope.sql;
    params.push(...enterpriseScope.params);
    if (query?.orgs?.length) {
      const orgScope = inClause("org_slug", query.orgs);
      sql += orgScope.sql;
      params.push(...orgScope.params);
    }
    const loginScope = allowedLoginsClause("user_login", query?.allowedLogins);
    sql += loginScope.sql;
    params.push(...loginScope.params);
    return { sql, params };
  };

  const eventScope = buildEventScope();
  const windowSql = query ? " AND event_date >= ? AND event_date <= ?" : "";
  const windowParams: unknown[] = query ? [query.start, query.end] : [];
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN source = 'audit_log' THEN 1 ELSE 0 END), 0) AS audit_rows,
      COALESCE(SUM(CASE WHEN source = 'sync_diff' THEN 1 ELSE 0 END), 0) AS diff_rows,
      COALESCE(SUM(CASE WHEN source = 'seat_created_at' THEN 1 ELSE 0 END), 0) AS seat_rows,
      COALESCE(SUM(CASE WHEN event_type = 'onboarded' THEN 1 ELSE 0 END), 0) AS onboarded_rows
    FROM copilot_seat_lifecycle_events
    WHERE 1 = 1${eventScope.sql}${windowSql}
  `).get(...eventScope.params, ...windowParams) as Record<string, number> | undefined;

  const coverageScope = buildScope("enterprise_slug");
  const tracking = db.prepare(`
    SELECT MIN(tracking_started_at) AS started
    FROM copilot_seat_lifecycle_coverage
    WHERE 1 = 1${coverageScope.sql}
  `).get(...coverageScope.params) as { started: string | null } | undefined;

  const auditRows = counts?.audit_rows ?? 0;
  const trackingStartedAt = tracking?.started ?? null;

  let source: SeatLifecycleSourceMode;
  if (auditRows > 0) source = "audit_log";
  else if (trackingStartedAt) source = "sync_diff";
  else source = "none";

  return {
    source,
    trackingStartedAt,
    onboardingOnly: source === "none" && (counts?.onboarded_rows ?? 0) > 0,
    sourceBreakdown: {
      audit_log: auditRows,
      sync_diff: counts?.diff_rows ?? 0,
      seat_created_at: counts?.seat_rows ?? 0,
    },
    audit: summarizeAuditCoverage(getSeatAuditSyncStates(enterpriseSlugs)),
  };
}

/**
 * Collapse per-enterprise audit sync state into one statement for the scope.
 *
 * Optimistic on status by design: with several enterprises in scope, a single
 * successful one means the audit log IS answering for part of the view, and the
 * coverage window is the intersection — the range every successful enterprise
 * can vouch for — so the UI never claims coverage it does not have for all of
 * them. `unavailable` outranks `error` when nothing succeeded, because a
 * missing capability is actionable while a transient failure is not.
 */
function summarizeAuditCoverage(states: SeatAuditSyncState[]): SeatLifecycleAuditCoverage {
  if (states.length === 0) {
    return {
      status: "never_run",
      reason: null,
      coveredFrom: null,
      coveredThrough: null,
      lastSyncedAt: null,
      truncated: false,
    };
  }

  const ok = states.filter((state) => state.status === "ok");
  const failing = states.filter((state) => state.status !== "ok");

  const status: SeatLifecycleAuditCoverage["status"] = ok.length > 0
    ? "ok"
    : failing.some((state) => state.status === "unavailable")
      ? "unavailable"
      : "error";

  const relevant = ok.length > 0 ? ok : failing;
  const reason = status === "ok"
    // With mixed results, name the enterprise that is NOT covered rather than
    // reporting a clean "ok" that hides a gap.
    ? failing.find((state) => state.reason)?.reason
      ?? ok.find((state) => state.reason)?.reason
      ?? null
    : relevant.find((state) => state.reason)?.reason ?? null;

  const coveredFroms = ok.map((state) => state.coveredFrom).filter((v): v is string => v !== null);
  const coveredThroughs = ok.map((state) => state.coveredThrough).filter((v): v is string => v !== null);
  const lastSyncedAts = ok.map((state) => state.lastSyncedAt).filter(Boolean);

  return {
    status,
    reason,
    // Intersection, not union: only a window every covered enterprise shares
    // can honestly be described as covered for the whole scope.
    coveredFrom: coveredFroms.length === ok.length && coveredFroms.length > 0
      ? coveredFroms.reduce((a, b) => (a > b ? a : b))
      : null,
    coveredThrough: coveredThroughs.length === ok.length && coveredThroughs.length > 0
      ? coveredThroughs.reduce((a, b) => (a < b ? a : b))
      : null,
    lastSyncedAt: lastSyncedAts.length > 0 ? lastSyncedAts.reduce((a, b) => (a > b ? a : b)) : null,
    truncated: relevant.some((state) => state.truncated),
  };
}

export interface SeatLifecycleExportResult {
  rows: SeatLifecycleRow[];
  truncated: boolean;
  total: number;
}

/** Rows for CSV export, capped so a huge window cannot exhaust memory. */
export function getSeatLifecycleExportRows(
  query: SeatLifecycleQuery,
  eventType: SeatLifecycleEventType | "all",
): SeatLifecycleExportResult {
  const db = getDb();
  const filter = buildLifecycleFilter(query);
  let where = filter.sql;
  const params = [...filter.params];
  if (eventType !== "all") {
    where += " AND event_type = ?";
    params.push(eventType);
  }

  const total = (db.prepare(`
    SELECT COUNT(*) AS total FROM copilot_seat_lifecycle_events ${where}
  `).get(...params) as { total: number } | undefined)?.total ?? 0;

  const rows = db.prepare(`
    SELECT enterprise_slug, org_slug, user_login, user_id, event_type, event_date,
           occurred_at, plan_type, assigning_team_slug, assigning_team_name,
           last_activity_at, source
    FROM copilot_seat_lifecycle_events
    ${where}
    ORDER BY event_date DESC, event_type ASC, user_login ASC
    LIMIT ?
  `).all(...params, SEAT_LIFECYCLE_EXPORT_MAX_ROWS) as SeatLifecycleRow[];

  return { rows: resolveDisplayLogins(rows), truncated: total > SEAT_LIFECYCLE_EXPORT_MAX_ROWS, total };
}
