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
 */
export function finishLicenseRun(id: string, result: FinishLicenseRunInput): void {
  const db = getDb();
  const completedAt = result.completedAt ?? new Date().toISOString();
  db.prepare(`
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
  const tx = db.transaction((items: LicenseCheckInput[]) => {
    db.prepare(`DELETE FROM license_reconciliation_checks WHERE run_id = ?`).run(runId);
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

/** List checks for a run, in insertion order (check_name, then scope). */
export function listLicenseChecks(runId: string): LicenseCheckRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM license_reconciliation_checks WHERE run_id = ? ORDER BY check_name, billing_period, org_login`)
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapCheckRow);
}

// ── Source sync state ────────────────────────────────────────────────

/**
 * Upsert the sync state for a single (enterprise, source, billingPeriod)
 * tuple. `billingPeriod` defaults to "" for sources that are not
 * period-scoped (e.g. an identity-map import that covers all periods).
 */
export function updateLicenseSourceState(state: LicenseSourceStateInput): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO license_source_sync_state (
      enterprise_slug, source, billing_period, last_synced_at, status, coverage_start, coverage_end, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    state.enterpriseSlug,
    state.source,
    state.billingPeriod ?? "",
    state.lastSyncedAt ?? null,
    state.status ?? "pending",
    state.coverageStart ?? null,
    state.coverageEnd ?? null,
    state.errorMessage ?? null
  );
}

/** List source sync state rows for an enterprise (all sources/periods). */
export function listLicenseSourceState(enterpriseSlug: string): LicenseSourceStateRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM license_source_sync_state WHERE enterprise_slug = ? ORDER BY source, billing_period`)
    .all(enterpriseSlug) as Record<string, unknown>[];
  return rows.map(mapSourceStateRow);
}
