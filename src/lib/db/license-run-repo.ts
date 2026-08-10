// Licensing run/diagnostics repository — durable reconciliation run and
// check storage for the historical licensing sync (see license-history-repo.ts
// for the underlying event/snapshot/period-row persistence).
//
// All bulk writes are transactional and all values are parameterized.
// Structured JSON columns are serialized deterministically (sorted object
// keys) via `stableStringify` so repeated writes of equivalent data produce
// identical bytes, and are always returned to callers already parsed.

import { randomUUID } from "node:crypto";
import { getDb } from "./database";
import { stableStringify, parseJsonArray, parseJsonObject } from "./license-history-repo";
import { summarizeSourceStates } from "../licensing/reconciliation-checks";
import type {
  IdentityResolutionSummary,
  HistoryCoverageSummaryEntry,
  SourceStateSummary,
} from "../licensing/reconciliation-checks";

const MAX_PERSISTED_RUN_WARNINGS = 200;
const MAX_PERSISTED_UNRESOLVED_IDENTITIES = 500;
const MAX_COMPLETED_RUNS_PER_ENTERPRISE = 100;

function boundRunWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_PERSISTED_RUN_WARNINGS) {
    return warnings;
  }
  const retainedCount = MAX_PERSISTED_RUN_WARNINGS - 1;
  return [
    ...warnings.slice(0, retainedCount),
    `${warnings.length - retainedCount} additional warnings omitted`,
  ];
}

function boundUnresolvedIdentities(identities: unknown[]): unknown[] {
  if (identities.length <= MAX_PERSISTED_UNRESOLVED_IDENTITIES) {
    return identities;
  }
  const retainedCount = MAX_PERSISTED_UNRESOLVED_IDENTITIES - 1;
  return [
    ...identities.slice(0, retainedCount),
    {
      holderKey: "[omitted]",
      reason: `${identities.length - retainedCount} additional unresolved identities omitted`,
    },
  ];
}

// ── Types ─────────────────────────────────────────────────────────────

export type LicenseRunStatus = "running" | "success" | "warning" | "failed";

export interface StartLicenseRunInput {
  enterpriseSlug: string;
  requestedPeriods: string[];
  /** ISO timestamp; defaults to now. */
  startedAt?: string;
}

export interface FinishLicenseRunInput {
  status: LicenseRunStatus;
  /** ISO timestamp; defaults to now. */
  completedAt?: string;
  sourceStats?: Record<string, unknown>;
  unresolvedIdentities?: unknown[];
  warnings?: string[];
  errorMessage?: string | null;
}

export interface LicenseRunRecord {
  id: string;
  enterpriseSlug: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  requestedPeriods: string[];
  sourceStats: Record<string, unknown>;
  unresolvedIdentities: unknown[];
  warnings: string[];
  errorMessage: string | null;
}

export type LicenseCheckStatus = "pass" | "warning" | "fail";

export interface LicenseCheckInput {
  checkName: string;
  billingPeriod?: string;
  orgLogin?: string;
  status: LicenseCheckStatus;
  expectedValue?: number | null;
  actualValue?: number | null;
  message: string;
  details?: Record<string, unknown>;
}

export interface LicenseCheckRecord {
  runId: string;
  checkName: string;
  billingPeriod: string;
  orgLogin: string;
  status: string;
  expectedValue: number | null;
  actualValue: number | null;
  message: string;
  details: Record<string, unknown>;
}

export interface LicenseSourceStateInput {
  enterpriseSlug: string;
  source: string;
  billingPeriod?: string;
  lastSyncedAt?: string | null;
  status?: string;
  coverageStart?: string | null;
  coverageEnd?: string | null;
  errorMessage?: string | null;
}

export interface LicenseSourceStateRecord {
  enterpriseSlug: string;
  source: string;
  billingPeriod: string;
  lastSyncedAt: string | null;
  status: string;
  coverageStart: string | null;
  coverageEnd: string | null;
  errorMessage: string | null;
}

// ── Row mappers ───────────────────────────────────────────────────────

function mapRunRow(row: Record<string, unknown>): LicenseRunRecord {
  return {
    id: row.id as string,
    enterpriseSlug: row.enterprise_slug as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string | null) ?? null,
    status: row.status as string,
    requestedPeriods: parseJsonArray(row.requested_periods as string | null) as string[],
    sourceStats: parseJsonObject(row.source_stats as string | null),
    unresolvedIdentities: parseJsonArray(row.unresolved_identities as string | null),
    warnings: parseJsonArray(row.warnings as string | null) as string[],
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

function mapCheckRow(row: Record<string, unknown>): LicenseCheckRecord {
  return {
    runId: row.run_id as string,
    checkName: row.check_name as string,
    billingPeriod: row.billing_period as string,
    orgLogin: row.org_login as string,
    status: row.status as string,
    expectedValue: (row.expected_value as number | null) ?? null,
    actualValue: (row.actual_value as number | null) ?? null,
    message: row.message as string,
    details: parseJsonObject(row.details as string | null),
  };
}

function mapSourceStateRow(row: Record<string, unknown>): LicenseSourceStateRecord {
  return {
    enterpriseSlug: row.enterprise_slug as string,
    source: row.source as string,
    billingPeriod: row.billing_period as string,
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
    status: row.status as string,
    coverageStart: (row.coverage_start as string | null) ?? null,
    coverageEnd: (row.coverage_end as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

// ── Run lifecycle ─────────────────────────────────────────────────────

/**
 * Start a new licensing reconciliation run, persisting it immediately with
 * status "running" so a crash mid-run leaves a durable, inspectable record.
 * Returns the generated run id.
 */
export function startLicenseRun(input: StartLicenseRunInput): string {
  const db = getDb();
  const id = randomUUID();
  const startedAt = input.startedAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO license_reconciliation_runs (
      id, enterprise_slug, started_at, completed_at, status,
      requested_periods, source_stats, unresolved_identities, warnings, error_message
    ) VALUES (?, ?, ?, NULL, 'running', ?, '{}', '[]', '[]', NULL)
  `).run(id, input.enterpriseSlug, startedAt, stableStringify(input.requestedPeriods ?? []));
  return id;
}

/**
 * Mark a run as completed (success/warning/failed), persisting its final
 * source stats, unresolved identities, and warnings.
 *
 * @throws {Error} when no run with the given `id` exists — a mismatched id
 * here almost always indicates a caller bug (e.g. a typo'd id or finishing a
 * run twice against a stale reference) that should surface immediately
 * rather than silently no-op.
 */
export function finishLicenseRun(id: string, result: FinishLicenseRunInput): void {
  const db = getDb();
  const completedAt = result.completedAt ?? new Date().toISOString();
  const selectRunStmt = db.prepare(`SELECT enterprise_slug FROM license_reconciliation_runs WHERE id = ?`);
  const finishStmt = db.prepare(`
    UPDATE license_reconciliation_runs
    SET status = ?, completed_at = ?, source_stats = ?, unresolved_identities = ?, warnings = ?, error_message = ?
    WHERE id = ?
  `);
  const pruneRunsStmt = db.prepare(`
    DELETE FROM license_reconciliation_runs
    WHERE enterprise_slug = ?
      AND status <> 'running'
      AND id NOT IN (
        SELECT id
        FROM license_reconciliation_runs
        WHERE enterprise_slug = ? AND status <> 'running'
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      )
  `);
  const tx = db.transaction(() => {
    const existing = selectRunStmt.get(id) as { enterprise_slug?: string } | undefined;
    if (!existing?.enterprise_slug) {
      throw new Error(`finishLicenseRun: no license_reconciliation_runs row found for id "${id}"`);
    }
    const info = finishStmt.run(
      result.status,
      completedAt,
      stableStringify(result.sourceStats ?? {}),
      stableStringify(boundUnresolvedIdentities(result.unresolvedIdentities ?? [])),
      stableStringify(boundRunWarnings(result.warnings ?? [])),
      result.errorMessage ?? null,
      id
    );
    if (info.changes === 0) {
      throw new Error(`finishLicenseRun: no license_reconciliation_runs row found for id "${id}"`);
    }
    pruneRunsStmt.run(existing.enterprise_slug, existing.enterprise_slug, MAX_COMPLETED_RUNS_PER_ENTERPRISE);
  });
  tx();
}

/** Fetch a single run by id, or null when it does not exist. */
export function getLicenseRun(id: string): LicenseRunRecord | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM license_reconciliation_runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRunRow(row) : null;
}

/** List runs for an enterprise, most recent first. */
export function listLicenseRuns(enterpriseSlug: string, limit = 50): LicenseRunRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM license_reconciliation_runs WHERE enterprise_slug = ? ORDER BY started_at DESC LIMIT ?`)
    .all(enterpriseSlug, limit) as Record<string, unknown>[];
  return rows.map(mapRunRow);
}

/**
 * Delete a run. Its associated checks are removed automatically by the
 * `license_reconciliation_checks.run_id` foreign key's `ON DELETE CASCADE`
 * (see licensing-schema.sql) — callers never need to clean up checks
 * separately.
 */
export function deleteLicenseRun(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM license_reconciliation_runs WHERE id = ?`).run(id);
}

// ── Checks ────────────────────────────────────────────────────────────

/**
 * Replace all reconciliation checks for a run (delete then insert) in one
 * transaction, so re-running checks for the same run never leaves stale
 * entries behind.
 */
export function replaceLicenseChecks(runId: string, checks: LicenseCheckInput[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_reconciliation_checks (
      run_id, check_name, billing_period, org_login, status, expected_value, actual_value, message, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare(`DELETE FROM license_reconciliation_checks WHERE run_id = ?`);
  const tx = db.transaction((items: LicenseCheckInput[]) => {
    deleteStmt.run(runId);
    for (const check of items) {
      stmt.run(
        runId,
        check.checkName,
        check.billingPeriod ?? "",
        check.orgLogin ?? "",
        check.status,
        check.expectedValue ?? null,
        check.actualValue ?? null,
        check.message,
        stableStringify(check.details ?? {})
      );
    }
  });
  tx(checks);
}

/** List checks for a run, ordered by check name, then billing period, then org login (not insertion order). */
export function listLicenseChecks(runId: string): LicenseCheckRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM license_reconciliation_checks WHERE run_id = ? ORDER BY check_name, billing_period, org_login`)
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapCheckRow);
}

// ── Source sync state ────────────────────────────────────────────────

/**
 * Statuses that represent a successful sync. An explicit transition into one
 * of these statuses clears any stale `error_message` from a prior failed
 * attempt, even when the caller doesn't pass `errorMessage` — a caller
 * reporting success shouldn't also have to remember to clear the old error.
 */
const SUCCESS_SOURCE_STATUSES = new Set(["ok", "success"]);

/**
 * Perform a true partial upsert of the sync state for a single (enterprise,
 * source, billingPeriod) tuple. `billingPeriod` defaults to "" for sources
 * that are not period-scoped (e.g. an identity-map import that covers all
 * periods).
 *
 * Fields omitted from `state` (i.e. left `undefined`) preserve their prior
 * stored value rather than being overwritten with a default/NULL — so, for
 * example, calling this again with only an updated `status` never clobbers
 * a previously-recorded `lastSyncedAt`/`coverageStart`/`coverageEnd`. The
 * one exception: when `status` is explicitly set to a {@link
 * SUCCESS_SOURCE_STATUSES success status} and `errorMessage` is omitted, the
 * stored `error_message` is cleared (see {@link SUCCESS_SOURCE_STATUSES}).
 */
export function updateLicenseSourceState(state: LicenseSourceStateInput): void {
  const db = getDb();
  const billingPeriod = state.billingPeriod ?? "";
  const selectStmt = db.prepare(
    `SELECT * FROM license_source_sync_state WHERE enterprise_slug = ? AND source = ? AND billing_period = ?`
  );
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO license_source_sync_state (
      enterprise_slug, source, billing_period, last_synced_at, status, coverage_start, coverage_end, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    const existing = selectStmt.get(state.enterpriseSlug, state.source, billingPeriod) as
      | Record<string, unknown>
      | undefined;

    const nextStatus = state.status ?? (existing ? (existing.status as string) : "pending");
    const explicitSuccess = state.status !== undefined && SUCCESS_SOURCE_STATUSES.has(state.status);

    const nextLastSyncedAt =
      state.lastSyncedAt !== undefined
        ? state.lastSyncedAt
        : ((existing?.last_synced_at as string | null | undefined) ?? null);
    const nextCoverageStart =
      state.coverageStart !== undefined
        ? state.coverageStart
        : ((existing?.coverage_start as string | null | undefined) ?? null);
    const nextCoverageEnd =
      state.coverageEnd !== undefined
        ? state.coverageEnd
        : ((existing?.coverage_end as string | null | undefined) ?? null);
    const nextErrorMessage =
      state.errorMessage !== undefined
        ? state.errorMessage
        : explicitSuccess
          ? null
          : ((existing?.error_message as string | null | undefined) ?? null);

    upsertStmt.run(
      state.enterpriseSlug,
      state.source,
      billingPeriod,
      nextLastSyncedAt,
      nextStatus,
      nextCoverageStart,
      nextCoverageEnd,
      nextErrorMessage
    );
  });
  tx();
}

/** List source sync state rows for an enterprise (all sources/periods). */
export function listLicenseSourceState(enterpriseSlug: string): LicenseSourceStateRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM license_source_sync_state WHERE enterprise_slug = ? ORDER BY source, billing_period`)
    .all(enterpriseSlug) as Record<string, unknown>[];
  return rows.map(mapSourceStateRow);
}

// ── Atomic diagnostics write ─────────────────────────────────────────

export interface LicenseRunDiagnosticsInput {
  runId: string;
  finish: FinishLicenseRunInput;
  checks: LicenseCheckInput[];
  sourceStates?: LicenseSourceStateInput[];
}

/**
 * Atomically persist a run's complete diagnostics — the finishing status,
 * its full set of reconciliation checks, and any source sync state updates
 * — in a single transaction.
 *
 * This is the single entrypoint intended for a sync orchestrator: it is
 * equivalent to calling {@link finishLicenseRun}, {@link replaceLicenseChecks},
 * and {@link updateLicenseSourceState} in sequence, except that a failure at
 * any point (unknown run id, a duplicate `(checkName, billingPeriod,
 * orgLogin)` triple in the same batch, or any other thrown error) rolls back
 * every part of the write — the run's prior status/checks/source state are
 * left completely untouched, and no other run's rows are ever affected.
 *
 * Implemented with a single flat transaction over inline prepared
 * statements (rather than composing the other exported functions, which
 * each open their own transaction) because nested transactions are not
 * supported by every test/runtime SQLite driver used against this repo.
 *
 * @throws {Error} when `runId` does not exist, or when `checks` contains a
 * duplicate `(checkName, billingPeriod, orgLogin)` triple.
 */
export function recordLicenseRunDiagnostics(input: LicenseRunDiagnosticsInput): void {
  const db = getDb();

  const finishStmt = db.prepare(`
    UPDATE license_reconciliation_runs
    SET status = ?, completed_at = ?, source_stats = ?, unresolved_identities = ?, warnings = ?, error_message = ?
    WHERE id = ?
  `);
  const selectRunStmt = db.prepare(`SELECT enterprise_slug FROM license_reconciliation_runs WHERE id = ?`);
  const deleteChecksStmt = db.prepare(`DELETE FROM license_reconciliation_checks WHERE run_id = ?`);
  const insertCheckStmt = db.prepare(`
    INSERT INTO license_reconciliation_checks (
      run_id, check_name, billing_period, org_login, status, expected_value, actual_value, message, details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSourceStateStmt = db.prepare(
    `SELECT * FROM license_source_sync_state WHERE enterprise_slug = ? AND source = ? AND billing_period = ?`
  );
  const upsertSourceStateStmt = db.prepare(`
    INSERT OR REPLACE INTO license_source_sync_state (
      enterprise_slug, source, billing_period, last_synced_at, status, coverage_start, coverage_end, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const pruneRunsStmt = db.prepare(`
    DELETE FROM license_reconciliation_runs
    WHERE enterprise_slug = ?
      AND status <> 'running'
      AND id NOT IN (
        SELECT id
        FROM license_reconciliation_runs
        WHERE enterprise_slug = ? AND status <> 'running'
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      )
  `);

  const tx = db.transaction((diagnostics: LicenseRunDiagnosticsInput) => {
    const completedAt = diagnostics.finish.completedAt ?? new Date().toISOString();
    const existingRun = selectRunStmt.get(diagnostics.runId) as { enterprise_slug?: string } | undefined;
    if (!existingRun?.enterprise_slug) {
      throw new Error(`recordLicenseRunDiagnostics: no license_reconciliation_runs row found for id "${diagnostics.runId}"`);
    }
    const info = finishStmt.run(
      diagnostics.finish.status,
      completedAt,
      stableStringify(diagnostics.finish.sourceStats ?? {}),
      stableStringify(boundUnresolvedIdentities(diagnostics.finish.unresolvedIdentities ?? [])),
      stableStringify(boundRunWarnings(diagnostics.finish.warnings ?? [])),
      diagnostics.finish.errorMessage ?? null,
      diagnostics.runId
    );
    if (info.changes === 0) {
      throw new Error(`recordLicenseRunDiagnostics: no license_reconciliation_runs row found for id "${diagnostics.runId}"`);
    }

    deleteChecksStmt.run(diagnostics.runId);
    const seenCheckKeys = new Set<string>();
    for (const check of diagnostics.checks) {
      const billingPeriod = check.billingPeriod ?? "";
      const orgLogin = check.orgLogin ?? "";
      const key = `${check.checkName}\u0000${billingPeriod}\u0000${orgLogin}`;
      if (seenCheckKeys.has(key)) {
        throw new Error(
          `recordLicenseRunDiagnostics: duplicate check (checkName="${check.checkName}", billingPeriod="${billingPeriod}", orgLogin="${orgLogin}") in the same batch`
        );
      }
      seenCheckKeys.add(key);
      insertCheckStmt.run(
        diagnostics.runId,
        check.checkName,
        billingPeriod,
        orgLogin,
        check.status,
        check.expectedValue ?? null,
        check.actualValue ?? null,
        check.message,
        stableStringify(check.details ?? {})
      );
    }

    for (const state of diagnostics.sourceStates ?? []) {
      const billingPeriod = state.billingPeriod ?? "";
      const existing = selectSourceStateStmt.get(state.enterpriseSlug, state.source, billingPeriod) as
        | Record<string, unknown>
        | undefined;

      const nextStatus = state.status ?? (existing ? (existing.status as string) : "pending");
      const explicitSuccess = state.status !== undefined && SUCCESS_SOURCE_STATUSES.has(state.status);

      const nextLastSyncedAt =
        state.lastSyncedAt !== undefined
          ? state.lastSyncedAt
          : ((existing?.last_synced_at as string | null | undefined) ?? null);
      const nextCoverageStart =
        state.coverageStart !== undefined
          ? state.coverageStart
          : ((existing?.coverage_start as string | null | undefined) ?? null);
      const nextCoverageEnd =
        state.coverageEnd !== undefined
          ? state.coverageEnd
          : ((existing?.coverage_end as string | null | undefined) ?? null);
      const nextErrorMessage =
        state.errorMessage !== undefined
          ? state.errorMessage
          : explicitSuccess
            ? null
            : ((existing?.error_message as string | null | undefined) ?? null);

      upsertSourceStateStmt.run(
        state.enterpriseSlug,
        state.source,
        billingPeriod,
        nextLastSyncedAt,
        nextStatus,
        nextCoverageStart,
        nextCoverageEnd,
        nextErrorMessage
      );
    }

    pruneRunsStmt.run(
      existingRun.enterprise_slug,
      existingRun.enterprise_slug,
      MAX_COMPLETED_RUNS_PER_ENTERPRISE
    );
  });

  tx(input);
}

// ── Run report (rendering/serialization) ────────────────────────────

/**
 * Fixed, documented set of safe unresolved-identity `reason` codes. Any
 * `reason` value outside this set — including free text that happens to
 * embed an email, external id, or token — is never echoed verbatim; it is
 * replaced with `"unknown"` (see {@link sanitizeUnresolvedReason}). Extend
 * this set deliberately when a genuinely new, safe (non-PII) reason code is
 * introduced upstream.
 */
const SAFE_UNRESOLVED_REASONS = new Set([
  "no_login",
  "ambiguous_match",
  "missing_identity_map",
  "unverified_external_identity",
  "seat_only_no_evidence",
  "audit_conflict",
  "unknown",
]);

/** Bounded, stable-identifier shape a `holderKey` must match to be surfaced as-is — see {@link sanitizeUnresolvedHolderKey}. Mirrors a GitHub-login-like slug: alnum start/end, alnum/dot/underscore/hyphen body, bounded length. */
const SAFE_HOLDER_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const MAX_HOLDER_KEY_LENGTH = 64;

/**
 * Accept a `holderKey` only when it is a bounded, stable-identifier-shaped
 * string (see {@link SAFE_HOLDER_KEY_RE}); anything else (an email, raw
 * external id, script/HTML content, or an oversized value) is replaced with
 * one constant marker so reports cannot be used to correlate candidate values.
 */
function sanitizeUnresolvedHolderKey(value: unknown): string {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HOLDER_KEY_LENGTH &&
    SAFE_HOLDER_KEY_RE.test(value)
  ) {
    return value;
  }
  return "[redacted]";
}

/** Accept `githubUserId` only as a finite, non-negative integer — a string, negative, fractional, or non-finite value is omitted (never coerced/leaked). */
function sanitizeUnresolvedGithubUserId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** Restrict `reason` to the {@link SAFE_UNRESOLVED_REASONS} fixed set; any unrecognized or free-text value (including one embedding an email/external id/token) becomes `"unknown"`. */
function sanitizeUnresolvedReason(value: unknown): string {
  return typeof value === "string" && SAFE_UNRESOLVED_REASONS.has(value) ? value : "unknown";
}

/**
 * Defensively strip an unresolved-identity entry down to only the allowlisted
 * safe fields (`holderKey`, `githubUserId`, `reason`) — dropping any other
 * property outright — and additionally validate each field's *value*, not
 * just its key: an unsafe `holderKey` is redacted (never leaked), an invalid
 * `githubUserId` is omitted, and a `reason` outside the fixed safe set
 * becomes `"unknown"`. Together this guarantees external identity values,
 * emails, SAML nameIds, SCIM externalId/userName, tokens, or raw payloads
 * can never be surfaced in a report even if an upstream caller's
 * `unresolvedIdentities` payload happened to include them — whether as an
 * unexpected key, or smuggled inside an expected key's value.
 */
function sanitizeUnresolvedIdentity(entry: unknown): Record<string, unknown> {
  if (typeof entry !== "object" || entry === null) {
    return {};
  }
  const record = entry as Record<string, unknown>;
  const safe: Record<string, unknown> = {};

  if ("holderKey" in record) {
    safe.holderKey = sanitizeUnresolvedHolderKey(record.holderKey);
  }
  const githubUserId = sanitizeUnresolvedGithubUserId(record.githubUserId);
  if (githubUserId !== undefined) {
    safe.githubUserId = githubUserId;
  }
  if ("reason" in record) {
    safe.reason = sanitizeUnresolvedReason(record.reason);
  }

  return safe;
}

/** Sort key for a sanitized unresolved-identity entry: its `holderKey` when present, else a stable fallback. */
function unresolvedIdentitySortKey(entry: Record<string, unknown>): string {
  return typeof entry.holderKey === "string" ? entry.holderKey : stableStringify(entry);
}

// ── Defensive report-content sanitization (legacy sourceStats/warnings/errorMessage) ──
//
// `sourceStats`/`warnings`/`errorMessage` are legacy, caller-provided
// free-form fields (see `FinishLicenseRunInput`) — unlike the new typed
// diagnostics fields below, their *shape* cannot be tightened without
// breaking existing persistence/callers (see this module's doc comment).
// Instead, report *content* built from them is defensively redacted and
// bounded so a secret/token/email/PII value a caller accidentally stuffed
// into one of these fields can never leak through `serializeLicenseRunReport`
// or `renderLicenseRunReportText`. This never mutates or affects the raw
// persisted run row — only the report object built from it.

const MAX_SANITIZE_DEPTH = 4;
const MAX_COLLECTION_SIZE = 50;
const MAX_STRING_LENGTH = 500;

const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._-]{8,}/gi;
/** GitHub PAT shapes: classic (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`) and fine-grained (`github_pat_`). */
const GITHUB_PAT_RE = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi;

/** Bound a string's length, then redact bearer tokens, GitHub PAT-shaped tokens, and email addresses — never echoing the original secret/PII substring. */
function redactSensitiveSubstrings(text: string): string {
  const bounded = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…[truncated]` : text;
  return bounded.replace(BEARER_TOKEN_RE, "[REDACTED_TOKEN]").replace(GITHUB_PAT_RE, "[REDACTED_TOKEN]").replace(EMAIL_RE, "[REDACTED_EMAIL]");
}

/**
 * Object keys that must never reach an output object as a literal own key —
 * regardless of their content — because bracket-assigning them onto a
 * *plain* object can mutate that object's prototype (`__proto__`) or shadow
 * built-ins (`constructor`, `prototype`) instead of creating a normal data
 * property. See {@link sanitizeReportKey}.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REDACTED_KEY_MARKER = "[REDACTED_KEY]";

/**
 * Redact/bound an object key the same way a string *value* is redacted (see
 * {@link redactSensitiveSubstrings}) so a secret/token/email stuffed into a
 * key — not just a value — can never leak through a report. The three keys
 * that could otherwise mutate a plain object's prototype via bracket
 * assignment (`__proto__`, `constructor`, `prototype`) are always renamed to
 * one constant marker, regardless of content, since some downstream
 * consumers (e.g. `stableStringify`'s key-sorting step) build plain object
 * literals from these keys.
 *
 * When two or more of one object's *own* keys redact to the same marker
 * (e.g. two different email addresses used as keys), a stable `:2`, `:3`,
 * ... suffix is appended in first-seen order — evaluated fresh per call via
 * `seenKeys` (scoped to one object's own entries) — so entries are never
 * silently merged/overwritten, without the suffix ever revealing which
 * original key was which.
 */
function sanitizeReportKey(key: string, seenKeys: Map<string, number>): string {
  const base = DANGEROUS_KEYS.has(key) ? REDACTED_KEY_MARKER : redactSensitiveSubstrings(key);
  const priorCount = seenKeys.get(base) ?? 0;
  seenKeys.set(base, priorCount + 1);
  return priorCount === 0 ? base : `${base}:${priorCount + 1}`;
}

/**
 * Recursively sanitize an arbitrary caller-provided value for inclusion in a
 * report: strings are redacted/bounded (see {@link redactSensitiveSubstrings});
 * non-finite numbers become `null`; arrays/objects are recursed into with a
 * bounded depth and a bounded number of entries (excess entries are dropped
 * and replaced with a single truncation marker) to avoid log amplification;
 * object *keys* are redacted/bounded and de-duplicated the same way values
 * are (see {@link sanitizeReportKey}), and the output is built on a
 * null-prototype object so even an unexpected dangerous key can never
 * mutate a shared prototype; anything else (functions, symbols, `undefined`)
 * is dropped.
 */
function sanitizeReportValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return "[REDACTED_DEPTH_LIMIT]";
  if (typeof value === "string") return redactSensitiveSubstrings(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_COLLECTION_SIZE).map((v) => sanitizeReportValue(v, depth + 1));
    if (value.length > MAX_COLLECTION_SIZE) bounded.push("[REDACTED_TRUNCATED]");
    return bounded;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_COLLECTION_SIZE);
    const safe: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seenKeys = new Map<string, number>();
    for (const [key, entryValue] of entries) {
      const safeKey = sanitizeReportKey(key, seenKeys);
      safe[safeKey] = sanitizeReportValue(entryValue, depth + 1);
    }
    return safe;
  }
  return undefined;
}

function sanitizeReportRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeReportValue(value, 0) as Record<string, unknown>;
}

function sanitizeReportStringArray(values: string[]): string[] {
  return values.slice(0, MAX_COLLECTION_SIZE).map((v) => redactSensitiveSubstrings(v));
}

function sanitizeReportNullableString(value: string | null): string | null {
  return value === null ? null : redactSensitiveSubstrings(value);
}

// ── Typed diagnostics (materialized rows, identity resolution, history coverage, source states, API requests) ──

/** Total and (optional) per-source API request counts for a run. */
export interface LicenseRunReportApiRequestCounts {
  total: number;
  bySource: Record<string, number>;
}

/**
 * Concrete, always-present diagnostics content for a run report — see
 * {@link buildLicenseRunReport}'s `diagnosticsInput` parameter for how a
 * caller supplies this, and {@link LicenseRunReportDiagnosticsInput} for the
 * optional-field input shape. Every field here has a deterministic empty
 * default (0 / [] / {}) so a report can always be built even when a caller
 * supplies no diagnostics input at all.
 */
export interface LicenseRunReportDiagnostics {
  /** Count of Task 7 materialized (org, holder) rows for this run's period(s). */
  materializedRowCount: number;
  /** Count of materialized rows with an active/assigned seat. */
  activeSeatRowCount: number;
  /** Count of raw consumption records considered during materialization. */
  consumptionRowCount: number;
  /** Total AI-Credit consumption across those records. */
  consumedCredits: number;
  /** Total USD consumption across those records. */
  consumedUsd: number;
  /** Identity resolution counts by source, and unresolved holder keys — see `reconciliation-checks.ts`'s `summarizeIdentityResolution`. */
  identityResolution: IdentityResolutionSummary;
  /** Seat-ledger history coverage counts by confidence tier — see `reconciliation-checks.ts`'s `summarizeHistoryCoverage`. */
  historyCoverage: HistoryCoverageSummaryEntry[];
  /** Per-source sync state grouped by source, each with its per-period status — see `reconciliation-checks.ts`'s `summarizeSourceStates`. Computed automatically from this report's `sourceStates` input; never needs to be supplied separately. */
  sourceStateSummary: SourceStateSummary[];
  /** Total and (optional) per-source upstream API request counts for this run. */
  apiRequestCounts: LicenseRunReportApiRequestCounts;
}

/**
 * Optional, typed diagnostics a caller (a sync orchestrator with access to
 * Task 6/7 outputs) may pass to {@link buildLicenseRunReport} to populate
 * {@link LicenseRunReportDiagnostics}. Every field is optional and missing/
 * invalid values fall back to a deterministic empty default — this contract
 * never requires the legacy, opaque `sourceStats` bag to be populated to get
 * core diagnostics content.
 */
export interface LicenseRunReportDiagnosticsInput {
  materializedRowCount?: number;
  activeSeatRowCount?: number;
  consumptionRowCount?: number;
  consumedCredits?: number;
  consumedUsd?: number;
  identityResolution?: IdentityResolutionSummary;
  historyCoverage?: HistoryCoverageSummaryEntry[];
  apiRequestCounts?: { total?: number; bySource?: Record<string, number> };
}

/** Coerce to a safe, finite, non-negative integer; anything else (undefined/NaN/Infinity/negative/fractional) falls back to 0. */
function safeNonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** Coerce to a safe, finite, non-negative number (fractional values allowed, unlike {@link safeNonNegativeInt}); anything else falls back to 0. */
function safeNonNegativeNumber(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

/**
 * Compute a run's elapsed duration in ms, or `null` when the run hasn't
 * completed yet, either timestamp fails to parse (`Date.parse` returns
 * `NaN` for an invalid/unparseable string), or the computed duration is
 * negative (an out-of-order `completedAt` before `startedAt`). This can
 * never produce `NaN` or a negative number in a report — both the report
 * object and everything derived from it (JSON via
 * {@link serializeLicenseRunReport}, text via
 * {@link renderLicenseRunReportText}) always agree on `null` vs. a valid
 * non-negative duration.
 */
function computeElapsedMs(startedAt: string, completedAt: string | null): number | null {
  if (completedAt == null) return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) return null;
  const elapsed = completed - started;
  return elapsed >= 0 ? elapsed : null;
}

/**
 * Build the always-present {@link LicenseRunReportDiagnostics} from a
 * caller's optional {@link LicenseRunReportDiagnosticsInput} plus this
 * report's already-fetched `sourceStates` (used to compute
 * `sourceStateSummary` via `summarizeSourceStates`, reused rather than
 * reimplemented). Every numeric/collection field is bounded/defaulted so an
 * absent or malformed diagnostics input can never throw or leak an invalid
 * value into the report.
 */
function buildDiagnostics(
  sourceStates: LicenseSourceStateRecord[],
  diagnosticsInput: LicenseRunReportDiagnosticsInput | undefined
): LicenseRunReportDiagnostics {
  const input = diagnosticsInput ?? {};

  const identityResolution: IdentityResolutionSummary = input.identityResolution
    ? {
        bySource: [...input.identityResolution.bySource]
          .map((entry) => ({ source: redactSensitiveSubstrings(entry.source), count: safeNonNegativeInt(entry.count) }))
          .sort((a, b) => a.source.localeCompare(b.source)),
        unresolvedHolderKeys: [...input.identityResolution.unresolvedHolderKeys]
          .map(sanitizeUnresolvedHolderKey)
          .sort(),
      }
    : { bySource: [], unresolvedHolderKeys: [] };

  const historyCoverage: HistoryCoverageSummaryEntry[] = input.historyCoverage
    ? [...input.historyCoverage]
        .map((entry) => ({ confidence: entry.confidence, count: safeNonNegativeInt(entry.count) }))
        .sort((a, b) => a.confidence.localeCompare(b.confidence))
    : [];

  const sourceStateSummary = summarizeSourceStates(
    sourceStates.map((s) => ({ source: s.source, billingPeriod: s.billingPeriod, status: s.status, lastSyncedAt: s.lastSyncedAt }))
  );

  const apiRequestCountsInput = input.apiRequestCounts ?? {};
  const seenApiSourceKeys = new Map<string, number>();
  const bySourceEntries = Object.entries(apiRequestCountsInput.bySource ?? {})
    .slice(0, MAX_COLLECTION_SIZE)
    .map(([key, count]) => [sanitizeReportKey(key, seenApiSourceKeys), safeNonNegativeInt(count)] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const apiRequestCounts: LicenseRunReportApiRequestCounts = {
    total: safeNonNegativeInt(apiRequestCountsInput.total),
    bySource: Object.fromEntries(bySourceEntries),
  };

  return {
    materializedRowCount: safeNonNegativeInt(input.materializedRowCount),
    activeSeatRowCount: safeNonNegativeInt(input.activeSeatRowCount),
    consumptionRowCount: safeNonNegativeInt(input.consumptionRowCount),
    consumedCredits: safeNonNegativeNumber(input.consumedCredits),
    consumedUsd: safeNonNegativeNumber(input.consumedUsd),
    identityResolution,
    historyCoverage,
    sourceStateSummary,
    apiRequestCounts,
  };
}

export interface LicenseRunReportSourceEntry {
  source: string;
  billingPeriod: string;
  status: string;
  lastSyncedAt: string | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  errorMessage: string | null;
}

export interface LicenseRunReportCheckEntry {
  name: string;
  billingPeriod: string;
  orgLogin: string;
  status: string;
  message: string;
  expectedValue: number | null;
  actualValue: number | null;
  details: Record<string, unknown>;
}

export interface LicenseRunReportCheckCounts {
  pass: number;
  warning: number;
  fail: number;
}

export interface LicenseRunReportObject {
  id: string;
  enterpriseSlug: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
  requestedPeriods: string[];
  sourceStats: Record<string, unknown>;
  sources: LicenseRunReportSourceEntry[];
  checks: LicenseRunReportCheckEntry[];
  checkCounts: LicenseRunReportCheckCounts;
  unresolvedIdentities: Record<string, unknown>[];
  warnings: string[];
  errorMessage: string | null;
  /** Explicitly typed diagnostics content — see {@link LicenseRunReportDiagnostics}. Always present with deterministic empty defaults, never dependent on the legacy `sourceStats` bag. */
  diagnostics: LicenseRunReportDiagnostics;
}

/**
 * Build a deterministic, DB-free report object from an already-fetched run,
 * its checks, and its source sync state rows, plus optional typed
 * {@link LicenseRunReportDiagnosticsInput} diagnostics from a sync
 * orchestrator with access to Task 6/7 outputs.
 *
 * All arrays are sorted into a stable, deterministic order (requested
 * periods and warnings lexicographically; sources by `source` then
 * `billingPeriod`; checks by `name` then `billingPeriod` then `orgLogin`,
 * matching {@link listLicenseChecks}'s SQL ordering; unresolved identities —
 * after sanitization — by `holderKey`), and unresolved-identity entries are
 * passed through {@link sanitizeUnresolvedIdentity} so no unsafe field —
 * nor an unsafe *value* in an otherwise-allowed field — can leak into a
 * rendered or serialized report regardless of what the stored
 * `unresolved_identities` JSON happens to contain. The legacy `sourceStats`/
 * `warnings`/`errorMessage` fields are likewise defensively redacted/bounded
 * (see {@link sanitizeReportRecord}) so an accidental secret/token/email
 * stuffed into one of those free-form fields can never leak through either.
 * `diagnostics` (see {@link LicenseRunReportDiagnostics}) is always present
 * with deterministic empty defaults, computed via {@link buildDiagnostics}.
 */
export function buildLicenseRunReport(
  run: LicenseRunRecord,
  checks: LicenseCheckRecord[],
  sourceStates: LicenseSourceStateRecord[],
  diagnosticsInput?: LicenseRunReportDiagnosticsInput
): LicenseRunReportObject {
  const elapsedMs = computeElapsedMs(run.startedAt, run.completedAt);

  const sources: LicenseRunReportSourceEntry[] = sourceStates
    .map((s) => ({
      source: s.source,
      billingPeriod: s.billingPeriod,
      status: s.status,
      lastSyncedAt: s.lastSyncedAt,
      coverageStart: s.coverageStart,
      coverageEnd: s.coverageEnd,
      errorMessage: sanitizeReportNullableString(s.errorMessage),
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.billingPeriod.localeCompare(b.billingPeriod));

  const reportChecks: LicenseRunReportCheckEntry[] = checks
    .map((c) => ({
      name: c.checkName,
      billingPeriod: c.billingPeriod,
      orgLogin: c.orgLogin,
      status: c.status,
      message: redactSensitiveSubstrings(c.message),
      expectedValue: c.expectedValue,
      actualValue: c.actualValue,
      details: sanitizeReportRecord(c.details),
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.billingPeriod.localeCompare(b.billingPeriod) ||
        a.orgLogin.localeCompare(b.orgLogin)
    );

  const checkCounts: LicenseRunReportCheckCounts = { pass: 0, warning: 0, fail: 0 };
  for (const check of reportChecks) {
    if (check.status === "pass" || check.status === "warning" || check.status === "fail") {
      checkCounts[check.status] += 1;
    }
  }

  const unresolvedIdentities = run.unresolvedIdentities
    .map(sanitizeUnresolvedIdentity)
    .sort((a, b) => unresolvedIdentitySortKey(a).localeCompare(unresolvedIdentitySortKey(b)));

  const diagnostics = buildDiagnostics(sourceStates, diagnosticsInput);

  return {
    id: run.id,
    enterpriseSlug: run.enterpriseSlug,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs,
    requestedPeriods: [...run.requestedPeriods].sort(),
    sourceStats: sanitizeReportRecord(run.sourceStats),
    sources,
    checks: reportChecks,
    checkCounts,
    unresolvedIdentities,
    warnings: sanitizeReportStringArray([...run.warnings].sort()),
    errorMessage: sanitizeReportNullableString(run.errorMessage),
    diagnostics,
  };
}

/**
 * Serialize a run report to deterministic JSON: equivalent report data
 * always produces byte-identical output regardless of the original object's
 * key or array insertion order (object keys are sorted recursively by
 * {@link stableStringify}; array ordering is already made deterministic by
 * {@link buildLicenseRunReport}).
 */
export function serializeLicenseRunReport(report: LicenseRunReportObject): string {
  return stableStringify(report);
}

/**
 * Render a run report as concise, human-readable text — run identity,
 * status, timestamps/elapsed time, requested periods, per-source sync
 * state, reconciliation checks (with pass/warning/fail counts), typed
 * diagnostics (materialized/active-seat/consumption row counts and consumed
 * credits/USD, identity resolution counts by source, history coverage
 * counts by confidence, source state summary, API request counts), raw
 * source stats, unresolved-identity count, warnings, and any top-level
 * error.
 *
 * This performs no filesystem writes; it only returns a string. Any file
 * emission is the caller's (orchestration/config layer's) responsibility.
 */
export function renderLicenseRunReportText(report: LicenseRunReportObject): string {
  const lines: string[] = [];
  lines.push(`License reconciliation run ${report.id} [${report.status.toUpperCase()}]`);
  lines.push(`Enterprise: ${report.enterpriseSlug}`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Completed: ${report.completedAt ?? "(in progress)"}`);
  lines.push(`Elapsed: ${report.elapsedMs !== null ? `${report.elapsedMs}ms` : "(in progress)"}`);
  lines.push(`Requested periods: ${report.requestedPeriods.length > 0 ? report.requestedPeriods.join(", ") : "(none)"}`);

  lines.push("Sources:");
  if (report.sources.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of report.sources) {
      const errSuffix = s.errorMessage ? ` — error: ${s.errorMessage}` : "";
      lines.push(`  - ${s.source} [${s.billingPeriod || "(all)"}]: ${s.status}${errSuffix}`);
    }
  }

  lines.push(
    `Checks (pass=${report.checkCounts.pass}, warning=${report.checkCounts.warning}, fail=${report.checkCounts.fail}):`
  );
  if (report.checks.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of report.checks) {
      const scope = [c.billingPeriod, c.orgLogin].filter((part) => part !== "").join("/");
      lines.push(`  - [${c.status.toUpperCase()}] ${c.name}${scope ? ` (${scope})` : ""}: ${c.message}`);
    }
  }

  const d = report.diagnostics;
  lines.push("Diagnostics:");
  lines.push(`  Materialized rows: ${d.materializedRowCount}`);
  lines.push(`  Active/seat rows: ${d.activeSeatRowCount}`);
  lines.push(`  Consumption rows: ${d.consumptionRowCount} (credits: ${d.consumedCredits}, USD: $${d.consumedUsd})`);
  lines.push(
    `  Identity resolution by source: ${
      d.identityResolution.bySource.length > 0
        ? d.identityResolution.bySource.map((e) => `${e.source}=${e.count}`).join(", ")
        : "(none)"
    }`
  );
  lines.push(`  Unresolved identities (by holder): ${d.identityResolution.unresolvedHolderKeys.length}`);
  lines.push(
    `  History coverage by confidence: ${
      d.historyCoverage.length > 0 ? d.historyCoverage.map((e) => `${e.confidence}=${e.count}`).join(", ") : "(none)"
    }`
  );
  lines.push(
    `  Source state summary: ${
      d.sourceStateSummary.length > 0
        ? d.sourceStateSummary.map((s) => `${s.source}(${s.periods.length})`).join(", ")
        : "(none)"
    }`
  );
  {
    const bySourceEntries = Object.entries(d.apiRequestCounts.bySource);
    const bySourceSuffix = bySourceEntries.length > 0 ? ` (${bySourceEntries.map(([k, v]) => `${k}=${v}`).join(", ")})` : "";
    lines.push(`  API requests: total=${d.apiRequestCounts.total}${bySourceSuffix}`);
  }

  const sourceStatsKeys = Object.keys(report.sourceStats).sort();
  lines.push("Source stats:");
  if (sourceStatsKeys.length === 0) {
    lines.push("  (none)");
  } else {
    for (const key of sourceStatsKeys) {
      lines.push(`  - ${key}: ${JSON.stringify(report.sourceStats[key])}`);
    }
  }

  lines.push(`Unresolved identities: ${report.unresolvedIdentities.length}`);
  lines.push(`Warnings: ${report.warnings.length > 0 ? report.warnings.join(", ") : "(none)"}`);
  lines.push(`Error: ${report.errorMessage ?? "(none)"}`);

  return lines.join("\n");
}
