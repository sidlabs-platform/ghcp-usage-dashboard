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
  const info = db.prepare(`
    UPDATE license_reconciliation_runs
    SET status = ?, completed_at = ?, source_stats = ?, unresolved_identities = ?, warnings = ?, error_message = ?
    WHERE id = ?
  `).run(
    result.status,
    completedAt,
    stableStringify(result.sourceStats ?? {}),
    stableStringify(result.unresolvedIdentities ?? []),
    stableStringify(result.warnings ?? []),
    result.errorMessage ?? null,
    id
  );
  if (info.changes === 0) {
    throw new Error(`finishLicenseRun: no license_reconciliation_runs row found for id "${id}"`);
  }
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

  const tx = db.transaction((diagnostics: LicenseRunDiagnosticsInput) => {
    const completedAt = diagnostics.finish.completedAt ?? new Date().toISOString();
    const info = finishStmt.run(
      diagnostics.finish.status,
      completedAt,
      stableStringify(diagnostics.finish.sourceStats ?? {}),
      stableStringify(diagnostics.finish.unresolvedIdentities ?? []),
      stableStringify(diagnostics.finish.warnings ?? []),
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
  });

  tx(input);
}

// ── Run report (rendering/serialization) ────────────────────────────

/** Allowlist of unresolved-identity fields that are safe to surface — see {@link sanitizeUnresolvedIdentity}. */
const SAFE_UNRESOLVED_IDENTITY_KEYS = new Set(["holderKey", "githubUserId", "reason"]);

/**
 * Defensively strip an unresolved-identity entry down to only the allowlisted
 * safe fields (`holderKey`, `githubUserId`, `reason`), dropping any other
 * property — in particular this guarantees external identity values, emails,
 * SAML nameIds, SCIM externalId/userName, tokens, or raw payloads are never
 * surfaced in a report even if an upstream caller's `unresolvedIdentities`
 * payload happened to include them.
 */
function sanitizeUnresolvedIdentity(entry: unknown): Record<string, unknown> {
  if (typeof entry !== "object" || entry === null) {
    return {};
  }
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if (SAFE_UNRESOLVED_IDENTITY_KEYS.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

/** Sort key for a sanitized unresolved-identity entry: its `holderKey` when present, else a stable fallback. */
function unresolvedIdentitySortKey(entry: Record<string, unknown>): string {
  return typeof entry.holderKey === "string" ? entry.holderKey : stableStringify(entry);
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
}

/**
 * Build a deterministic, DB-free report object from an already-fetched run,
 * its checks, and its source sync state rows.
 *
 * All arrays are sorted into a stable, deterministic order (requested
 * periods and warnings lexicographically; sources by `source` then
 * `billingPeriod`; checks by `name` then `billingPeriod` then `orgLogin`,
 * matching {@link listLicenseChecks}'s SQL ordering; unresolved identities —
 * after sanitization — by `holderKey`), and unresolved-identity entries are
 * passed through {@link sanitizeUnresolvedIdentity} so no unsafe field can
 * leak into a rendered or serialized report regardless of what the stored
 * `unresolved_identities` JSON happens to contain.
 */
export function buildLicenseRunReport(
  run: LicenseRunRecord,
  checks: LicenseCheckRecord[],
  sourceStates: LicenseSourceStateRecord[]
): LicenseRunReportObject {
  const elapsedMs =
    run.completedAt != null ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;

  const sources: LicenseRunReportSourceEntry[] = sourceStates
    .map((s) => ({
      source: s.source,
      billingPeriod: s.billingPeriod,
      status: s.status,
      lastSyncedAt: s.lastSyncedAt,
      coverageStart: s.coverageStart,
      coverageEnd: s.coverageEnd,
      errorMessage: s.errorMessage,
    }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.billingPeriod.localeCompare(b.billingPeriod));

  const reportChecks: LicenseRunReportCheckEntry[] = checks
    .map((c) => ({
      name: c.checkName,
      billingPeriod: c.billingPeriod,
      orgLogin: c.orgLogin,
      status: c.status,
      message: c.message,
      expectedValue: c.expectedValue,
      actualValue: c.actualValue,
      details: c.details,
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

  return {
    id: run.id,
    enterpriseSlug: run.enterpriseSlug,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsedMs,
    requestedPeriods: [...run.requestedPeriods].sort(),
    sourceStats: run.sourceStats,
    sources,
    checks: reportChecks,
    checkCounts,
    unresolvedIdentities,
    warnings: [...run.warnings].sort(),
    errorMessage: run.errorMessage,
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
 * state, reconciliation checks (with pass/warning/fail counts), raw source
 * stats, unresolved-identity count, warnings, and any top-level error.
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
