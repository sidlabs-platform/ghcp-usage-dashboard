// Licensing history repository — CRUD + query API for historical Copilot
// license / AI-Credit reconciliation data (audit events, seat snapshots,
// identity records, org billing snapshots, AI-Credit consumption, and the
// materialized `license_period_rows` reconciliation grain).
//
// All bulk writes are transactional and all values are parameterized.
// Query aggregation (rollup view) is pushed into SQL via GROUP BY/SUM rather
// than loading full history into JS, per project performance guidelines.

import { getDb } from "./database";
import { buildOrderBy, buildLimitOffset, type PaginationParams } from "@/lib/api/pagination";

// ── Deterministic JSON serialization ─────────────────────────────────

/**
 * Serialize a value to JSON with object keys sorted recursively so the same
 * logical payload always produces the same byte-for-byte string (array
 * order is preserved as-is). Used for `raw_json`/detail columns so repeated
 * upserts of equivalent data are stable and diff-friendly.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortKeysDeep(input[key]);
    }
    return sorted;
  }
  return value;
}

/** Parse a JSON array column, defaulting to `[]` on missing/invalid data. */
export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object column, defaulting to `{}` on missing/invalid data. */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ── Input types (write side, camelCase) ──────────────────────────────

export interface LicenseAuditEventInput {
  eventId: string;
  orgLogin?: string;
  action: string;
  occurredAt: string;
  githubUserId?: number | null;
  observedLogin?: string | null;
  externalIdentity?: string | null;
  assignedVia?: string | null;
  source: string;
  raw?: unknown;
}

export interface LicenseSeatSnapshotInput {
  orgLogin?: string;
  holderKey: string;
  githubUserId?: number | null;
  observedLogin?: string | null;
  planType?: string;
  assignedVia?: string;
  lastActivityAt?: string | null;
  pendingCancellationDate?: string | null;
  snapshotAt: string;
  source: string;
  raw?: unknown;
}

export interface LicenseIdentityRecordInput {
  identityKey: string;
  githubUserId?: number | null;
  resolvedLogin?: string | null;
  externalIdentity?: string | null;
  accountState?: string;
  resolutionSource: string;
  observedAt: string;
  raw?: unknown;
}

export interface LicenseOrgBillingSnapshotInput {
  billingPeriod: string;
  orgLogin: string;
  planType?: string | null;
  totalSeats?: number;
  pendingCancellation?: number;
  observedAt: string;
  raw?: unknown;
}

export interface LicenseAicConsumptionInput {
  billingPeriod: string;
  orgLogin?: string;
  holderKey: string;
  username?: string | null;
  credits?: number;
  grossUsd?: number;
  netUsd?: number | null;
  source: string;
  observedAt: string;
  raw?: unknown;
}

export interface LicensePeriodRowInput {
  orgLogin?: string;
  holderKey: string;
  githubUserId?: number | null;
  userLogin?: string | null;
  resolvedUserLogin?: string | null;
  externalIdentity?: string | null;
  identityResolutionSource: string;
  accountState?: string;
  licenseAssignedDate?: string | null;
  userRevokedDate?: string | null;
  planType?: string;
  seatStatus: string;
  assignedVia: string;
  lastActivityAt?: string | null;
  licenseCost?: number;
  defaultAicCredits?: number;
  defaultAicUsd?: number;
  aicAssignedUsd?: number;
  aicAssignedRule: string;
  aicConsumedCredits?: number;
  aicConsumedUsd?: number;
  currency?: string;
  rowSource: string;
  consumptionSource?: string | null;
  historyConfidence: string;
  dataQualityNotes?: string[];
  asOfUtc: string;
  generatedAtUtc: string;
}

// ── Read types (query side, camelCase) ───────────────────────────────

export interface LicensePeriodRowRecord {
  enterpriseSlug: string;
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  userLogin: string | null;
  resolvedUserLogin: string | null;
  externalIdentity: string | null;
  identityResolutionSource: string;
  accountState: string;
  licenseAssignedDate: string | null;
  userRevokedDate: string | null;
  planType: string;
  seatStatus: string;
  assignedVia: string;
  lastActivityAt: string | null;
  licenseCost: number;
  defaultAicCredits: number;
  defaultAicUsd: number;
  aicAssignedUsd: number;
  aicAssignedRule: string;
  aicConsumedCredits: number;
  aicConsumedUsd: number;
  currency: string;
  rowSource: string;
  consumptionSource: string | null;
  historyConfidence: string;
  dataQualityNotes: unknown[];
  asOfUtc: string;
  generatedAtUtc: string;
}

export interface LicenseRollupRowRecord {
  enterpriseSlug: string;
  resolvedUserLogin: string;
  periods: string[];
  orgLogins: string[];
  planTypes: string[];
  seatCount: number;
  orgCount: number;
  periodCount: number;
  licenseCost: number;
  defaultAicCredits: number;
  defaultAicUsd: number;
  aicAssignedUsd: number;
  aicConsumedCredits: number;
  aicConsumedUsd: number;
  utilizationPct: number;
  currency: string;
  historyConfidence: string;
}

export interface LicensePeriodQuery {
  /** "detail" (default) returns one row per period/org/holder; "rollup" groups by resolved login. */
  view?: "detail" | "rollup";
  enterpriseSlug?: string;
  enterpriseSlugs?: string[];
  /** Explicit list of "YYYY-MM" billing periods. Combinable with periodStart/periodEnd. */
  periods?: string[];
  /** Inclusive "YYYY-MM" range start. */
  periodStart?: string;
  /** Inclusive "YYYY-MM" range end. */
  periodEnd?: string;
  orgLogins?: string[];
  /** Matches user_login, resolved_user_login, or holder_key. */
  logins?: string[];
  planTypes?: string[];
  accountStates?: string[];
  seatStatuses?: string[];
  historyConfidence?: string[];
  /** Free-text search across login/org/external-identity columns. */
  search?: string;
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortDir?: "asc" | "desc";
}

export interface PaginatedLicenseRows {
  view: "detail" | "rollup";
  rows: LicensePeriodRowRecord[] | LicenseRollupRowRecord[];
  pagination: { page: number; pageSize: number; totalItems: number; totalPages: number };
}

// ── Sort allowlists ───────────────────────────────────────────────────
// Exported (read-only) so tests can iterate the exact allowlist rather than
// duplicating it, guaranteeing every allowed sort column is exercised.

export const DETAIL_SORT_COLUMNS: string[] = [
  "billing_period",
  "org_login",
  "user_login",
  "resolved_user_login",
  "plan_type",
  "seat_status",
  "account_state",
  "history_confidence",
  "license_cost",
  "aic_consumed_credits",
  "aic_consumed_usd",
  "default_aic_credits",
  "default_aic_usd",
  "aic_assigned_usd",
  "last_activity_at",
  "as_of_utc",
];

export const ROLLUP_SORT_COLUMNS: string[] = [
  "resolved_user_login",
  "seat_count",
  "org_count",
  "period_count",
  "license_cost",
  "aic_consumed_credits",
  "aic_consumed_usd",
  "default_aic_credits",
  "default_aic_usd",
  "aic_assigned_usd",
  "utilization_pct",
];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function clampPagination(query: LicensePeriodQuery): PaginationParams {
  const page = Math.max(1, Number.isFinite(query.page) ? Math.trunc(query.page as number) : 1);
  const rawPageSize = Number.isFinite(query.pageSize) ? Math.trunc(query.pageSize as number) : DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(1, rawPageSize), MAX_PAGE_SIZE);
  const sortDir: "asc" | "desc" = query.sortDir === "asc" ? "asc" : "desc";
  return { page, pageSize, sortField: query.sortField || "", sortDir, search: query.search };
}

/** Build a shared WHERE clause (applies to both detail and rollup views) from a query's filters. */
function appendPeriodFilters(clauses: string[], params: unknown[], query: LicensePeriodQuery): void {
  const enterpriseSlugs = query.enterpriseSlugs?.length
    ? query.enterpriseSlugs
    : query.enterpriseSlug
      ? [query.enterpriseSlug]
      : [];
  if (enterpriseSlugs.length) {
    clauses.push(`enterprise_slug IN (${enterpriseSlugs.map(() => "?").join(",")})`);
    params.push(...enterpriseSlugs);
  }

  if (query.periods?.length) {
    clauses.push(`billing_period IN (${query.periods.map(() => "?").join(",")})`);
    params.push(...query.periods);
  }
  if (query.periodStart) {
    clauses.push(`billing_period >= ?`);
    params.push(query.periodStart);
  }
  if (query.periodEnd) {
    clauses.push(`billing_period <= ?`);
    params.push(query.periodEnd);
  }
  if (query.orgLogins?.length) {
    clauses.push(`org_login IN (${query.orgLogins.map(() => "?").join(",")})`);
    params.push(...query.orgLogins);
  }
  if (query.logins?.length) {
    const parts = query.logins.map(() => `(user_login = ? OR resolved_user_login = ? OR holder_key = ?)`);
    clauses.push(`(${parts.join(" OR ")})`);
    for (const login of query.logins) params.push(login, login, login);
  }
  if (query.planTypes?.length) {
    clauses.push(`plan_type IN (${query.planTypes.map(() => "?").join(",")})`);
    params.push(...query.planTypes);
  }
  if (query.accountStates?.length) {
    clauses.push(`account_state IN (${query.accountStates.map(() => "?").join(",")})`);
    params.push(...query.accountStates);
  }
  if (query.seatStatuses?.length) {
    clauses.push(`seat_status IN (${query.seatStatuses.map(() => "?").join(",")})`);
    params.push(...query.seatStatuses);
  }
  if (query.historyConfidence?.length) {
    clauses.push(`history_confidence IN (${query.historyConfidence.map(() => "?").join(",")})`);
    params.push(...query.historyConfidence);
  }
  if (query.search) {
    const like = `%${escapeLikePattern(query.search)}%`;
    clauses.push(
      `(user_login LIKE ? ESCAPE '\\' OR resolved_user_login LIKE ? ESCAPE '\\' OR org_login LIKE ? ESCAPE '\\' OR external_identity LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like, like);
  }
}

/**
 * Escape SQLite LIKE metacharacters (`%`, `_`) and the escape character
 * itself (`\`) in free-text search input, so a literal `%`/`_` typed by a
 * user (e.g. searching for a login containing an underscore) matches only
 * that literal character rather than being interpreted as a wildcard. Must
 * be paired with `LIKE ? ESCAPE '\'` at each call site.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildWhereClause(clauses: string[]): string {
  return clauses.length ? " WHERE " + clauses.join(" AND ") : "";
}

function mapDetailRow(row: Record<string, unknown>): LicensePeriodRowRecord {
  return {
    enterpriseSlug: row.enterprise_slug as string,
    billingPeriod: row.billing_period as string,
    orgLogin: row.org_login as string,
    holderKey: row.holder_key as string,
    githubUserId: (row.github_user_id as number | null) ?? null,
    userLogin: (row.user_login as string | null) ?? null,
    resolvedUserLogin: (row.resolved_user_login as string | null) ?? null,
    externalIdentity: (row.external_identity as string | null) ?? null,
    identityResolutionSource: row.identity_resolution_source as string,
    accountState: row.account_state as string,
    licenseAssignedDate: (row.license_assigned_date as string | null) ?? null,
    userRevokedDate: (row.user_revoked_date as string | null) ?? null,
    planType: row.plan_type as string,
    seatStatus: row.seat_status as string,
    assignedVia: row.assigned_via as string,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
    licenseCost: (row.license_cost as number) ?? 0,
    defaultAicCredits: (row.default_aic_credits as number) ?? 0,
    defaultAicUsd: (row.default_aic_usd as number) ?? 0,
    aicAssignedUsd: (row.aic_assigned_usd as number) ?? 0,
    aicAssignedRule: row.aic_assigned_rule as string,
    aicConsumedCredits: (row.aic_consumed_credits as number) ?? 0,
    aicConsumedUsd: (row.aic_consumed_usd as number) ?? 0,
    currency: row.currency as string,
    rowSource: row.row_source as string,
    consumptionSource: (row.consumption_source as string | null) ?? null,
    historyConfidence: row.history_confidence as string,
    dataQualityNotes: parseJsonArray(row.data_quality_notes as string | null),
    asOfUtc: row.as_of_utc as string,
    generatedAtUtc: row.generated_at_utc as string,
  };
}

const CONFIDENCE_RANK_SQL = `CASE history_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;
const RANK_TO_CONFIDENCE: Record<number, string> = { 3: "high", 2: "medium", 1: "low", 0: "unknown" };

// Same "assigned budget, falling back to the plan default" semantics as the
// rollup's JS mapping (`aicAssignedUsd || defaultAicUsd`): SQLite doesn't
// allow referencing a SELECT-list alias from another expression in the same
// SELECT, so the SUM(...) aggregates are repeated inline here rather than
// reused via alias. Kept as a single source of truth so the value used for
// ORDER BY and the value returned to callers can never drift apart.
const UTILIZATION_PCT_SQL = `
  CASE
    WHEN COALESCE(SUM(aic_assigned_usd), 0) > 0
      THEN (COALESCE(SUM(aic_consumed_usd), 0) / COALESCE(SUM(aic_assigned_usd), 0)) * 100
    WHEN COALESCE(SUM(default_aic_usd), 0) > 0
      THEN (COALESCE(SUM(aic_consumed_usd), 0) / COALESCE(SUM(default_aic_usd), 0)) * 100
    ELSE 0
  END
`;

function splitDistinct(value: string | null | undefined): string[] {
  if (!value) return [];
  // GROUP_CONCAT(DISTINCT ...) joins with a comma by default. Values stored
  // in these columns (billing_period, org_login, plan_type) are structural
  // identifiers that never contain commas, so a plain split is safe.
  return value.split(",").filter((v) => v.length > 0);
}

/**
 * Build a detail-view ORDER BY clause with deterministic tie-breakers on the
 * full primary key (enterprise_slug, billing_period, org_login, holder_key),
 * so OFFSET-based pagination never reorders/duplicates/skips rows across
 * pages when the requested sort column has ties.
 */
function buildDetailOrderBy(pagination: PaginationParams): string {
  const base = buildOrderBy(pagination, DETAIL_SORT_COLUMNS, "billing_period");
  return `${base}, enterprise_slug ASC, billing_period ASC, org_login ASC, holder_key ASC`;
}

/**
 * Build a rollup-view ORDER BY clause with deterministic tie-breakers on the
 * group key (enterprise_slug, resolved login), so OFFSET-based pagination
 * stays stable across pages when the requested sort column has ties.
 */
function buildRollupOrderBy(pagination: PaginationParams): string {
  const base = buildOrderBy(pagination, ROLLUP_SORT_COLUMNS, "resolved_user_login");
  return `${base}, enterprise_slug ASC, resolved_user_login ASC`;
}

/**
 * Query `license_period_rows`, returning either the raw per-period detail
 * grain or a per-login rollup aggregated in SQL. Filtering, sorting, and
 * pagination are all pushed into SQL; only the current page of rows is ever
 * materialized in JS.
 */
export function queryLicensePeriodRows(query: LicensePeriodQuery): PaginatedLicenseRows {
  const db = getDb();
  const view = query.view === "rollup" ? "rollup" : "detail";
  const pagination = clampPagination(query);
  const clauses: string[] = [];
  const params: unknown[] = [];
  appendPeriodFilters(clauses, params, query);
  const where = buildWhereClause(clauses);
  const { clause: limitClause, values: limitValues } = buildLimitOffset(pagination);

  if (view === "detail") {
    const orderBy = buildDetailOrderBy(pagination);
    const countRow = db
      .prepare(`SELECT COUNT(*) as total FROM license_period_rows${where}`)
      .get(...params) as { total: number };
    const rows = db
      .prepare(`SELECT * FROM license_period_rows${where} ${orderBy} ${limitClause}`)
      .all(...params, ...limitValues) as Record<string, unknown>[];
    return {
      view,
      rows: rows.map(mapDetailRow),
      pagination: {
        page: pagination.page,
        pageSize: pagination.pageSize,
        totalItems: countRow.total,
        totalPages: Math.ceil(countRow.total / pagination.pageSize),
      },
    };
  }

  // Rollup: group by resolved login (falling back to holder_key when unresolved)
  // across the periods/orgs matched by the shared filters. All aggregation
  // happens in SQL — only the current page's grouped rows are materialized.
  const orderBy = buildRollupOrderBy(pagination);
  const groupKey = `COALESCE(NULLIF(resolved_user_login, ''), holder_key)`;
  const rollupSelect = `
    SELECT
      enterprise_slug AS enterprise_slug,
      ${groupKey} AS resolved_user_login,
      GROUP_CONCAT(DISTINCT billing_period) AS periods,
      GROUP_CONCAT(DISTINCT org_login) AS org_logins,
      GROUP_CONCAT(DISTINCT plan_type) AS plan_types,
      COUNT(*) AS seat_count,
      COUNT(DISTINCT org_login) AS org_count,
      COUNT(DISTINCT billing_period) AS period_count,
      COALESCE(SUM(license_cost), 0) AS license_cost,
      COALESCE(SUM(default_aic_credits), 0) AS default_aic_credits,
      COALESCE(SUM(default_aic_usd), 0) AS default_aic_usd,
      COALESCE(SUM(aic_assigned_usd), 0) AS aic_assigned_usd,
      COALESCE(SUM(aic_consumed_credits), 0) AS aic_consumed_credits,
      COALESCE(SUM(aic_consumed_usd), 0) AS aic_consumed_usd,
      MAX(currency) AS currency,
      MIN(${CONFIDENCE_RANK_SQL}) AS confidence_rank,
      ${UTILIZATION_PCT_SQL} AS utilization_pct
    FROM license_period_rows${where}
    GROUP BY enterprise_slug, ${groupKey}
  `;

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM (SELECT 1 FROM license_period_rows${where} GROUP BY enterprise_slug, ${groupKey})`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(`${rollupSelect} ${orderBy} ${limitClause}`)
    .all(...params, ...limitValues) as Record<string, unknown>[];

  const mapped: LicenseRollupRowRecord[] = rows.map((row) => {
    return {
      enterpriseSlug: row.enterprise_slug as string,
      resolvedUserLogin: row.resolved_user_login as string,
      periods: splitDistinct(row.periods as string | null),
      orgLogins: splitDistinct(row.org_logins as string | null),
      planTypes: splitDistinct(row.plan_types as string | null),
      seatCount: (row.seat_count as number) ?? 0,
      orgCount: (row.org_count as number) ?? 0,
      periodCount: (row.period_count as number) ?? 0,
      licenseCost: (row.license_cost as number) ?? 0,
      defaultAicCredits: (row.default_aic_credits as number) ?? 0,
      defaultAicUsd: (row.default_aic_usd as number) ?? 0,
      aicAssignedUsd: (row.aic_assigned_usd as number) ?? 0,
      aicConsumedCredits: (row.aic_consumed_credits as number) ?? 0,
      aicConsumedUsd: (row.aic_consumed_usd as number) ?? 0,
      // Read directly from SQL (UTILIZATION_PCT_SQL) rather than recomputed
      // in JS, so the value used for ORDER BY and the value returned here
      // can never disagree.
      utilizationPct: (row.utilization_pct as number) ?? 0,
      currency: (row.currency as string) || "USD",
      historyConfidence: RANK_TO_CONFIDENCE[(row.confidence_rank as number) ?? 0] ?? "unknown",
    };
  });

  return {
    view,
    rows: mapped,
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems: countRow.total,
      totalPages: Math.ceil(countRow.total / pagination.pageSize),
    },
  };
}

// ── Bulk writers ──────────────────────────────────────────────────────

/**
 * Upsert append-only audit events for an enterprise. Idempotent: re-running
 * with the same `eventId` values replaces the prior row rather than
 * duplicating it. Returns the number of events written.
 */
export function upsertAuditEvents(enterpriseSlug: string, events: LicenseAuditEventInput[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_audit_events (
      enterprise_slug, event_id, org_login, action, occurred_at,
      github_user_id, observed_login, external_identity, assigned_via, source, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicenseAuditEventInput[]) => {
    for (const event of items) {
      stmt.run(
        enterpriseSlug,
        event.eventId,
        event.orgLogin ?? "",
        event.action,
        event.occurredAt,
        event.githubUserId ?? null,
        event.observedLogin ?? null,
        event.externalIdentity ?? null,
        event.assignedVia ?? null,
        event.source,
        event.raw !== undefined ? stableStringify(event.raw) : null
      );
    }
  });
  tx(events);
  return events.length;
}

/**
 * Replace the seat snapshot set for a single enterprise/period (delete then
 * insert), so a re-run of the same period never leaves stale holders behind.
 * Returns the number of snapshots written.
 */
export function replacePeriodSnapshots(
  enterpriseSlug: string,
  period: string,
  snapshots: LicenseSeatSnapshotInput[]
): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_seat_snapshots (
      enterprise_slug, billing_period, org_login, holder_key, github_user_id, observed_login,
      plan_type, assigned_via, last_activity_at, pending_cancellation_date, snapshot_at, source, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicenseSeatSnapshotInput[]) => {
    db.prepare(`DELETE FROM license_seat_snapshots WHERE enterprise_slug = ? AND billing_period = ?`).run(
      enterpriseSlug,
      period
    );
    for (const snap of items) {
      stmt.run(
        enterpriseSlug,
        period,
        snap.orgLogin ?? "",
        snap.holderKey,
        snap.githubUserId ?? null,
        snap.observedLogin ?? null,
        snap.planType ?? "unknown",
        snap.assignedVia ?? "direct",
        snap.lastActivityAt ?? null,
        snap.pendingCancellationDate ?? null,
        snap.snapshotAt,
        snap.source,
        snap.raw !== undefined ? stableStringify(snap.raw) : null
      );
    }
  });
  tx(snapshots);
  return snapshots.length;
}

/** Upsert resolved identity records. Returns the number of records written. */
export function upsertIdentityRecords(enterpriseSlug: string, records: LicenseIdentityRecordInput[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_identity_records (
      enterprise_slug, identity_key, github_user_id, resolved_login, external_identity,
      account_state, resolution_source, observed_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicenseIdentityRecordInput[]) => {
    for (const rec of items) {
      stmt.run(
        enterpriseSlug,
        rec.identityKey,
        rec.githubUserId ?? null,
        rec.resolvedLogin ?? null,
        rec.externalIdentity ?? null,
        rec.accountState ?? "unknown",
        rec.resolutionSource,
        rec.observedAt,
        rec.raw !== undefined ? stableStringify(rec.raw) : null
      );
    }
  });
  tx(records);
  return records.length;
}

/** Upsert per-org billing snapshots. Returns the number of records written. */
export function upsertOrgBillingSnapshots(enterpriseSlug: string, records: LicenseOrgBillingSnapshotInput[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_org_billing_snapshots (
      enterprise_slug, billing_period, org_login, plan_type, total_seats, pending_cancellation, observed_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicenseOrgBillingSnapshotInput[]) => {
    for (const rec of items) {
      stmt.run(
        enterpriseSlug,
        rec.billingPeriod,
        rec.orgLogin,
        rec.planType ?? null,
        rec.totalSeats ?? 0,
        rec.pendingCancellation ?? 0,
        rec.observedAt,
        rec.raw !== undefined ? stableStringify(rec.raw) : null
      );
    }
  });
  tx(records);
  return records.length;
}

/** Upsert per-holder AI-Credit consumption records. Returns the number of records written. */
export function upsertAicConsumption(enterpriseSlug: string, records: LicenseAicConsumptionInput[]): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_aic_consumption (
      enterprise_slug, billing_period, org_login, holder_key, username, credits, gross_usd, net_usd,
      source, observed_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicenseAicConsumptionInput[]) => {
    for (const rec of items) {
      stmt.run(
        enterpriseSlug,
        rec.billingPeriod,
        rec.orgLogin ?? "",
        rec.holderKey,
        rec.username ?? null,
        rec.credits ?? 0,
        rec.grossUsd ?? 0,
        rec.netUsd ?? null,
        rec.source,
        rec.observedAt,
        rec.raw !== undefined ? stableStringify(rec.raw) : null
      );
    }
  });
  tx(records);
  return records.length;
}

/**
 * Replace the materialized `license_period_rows` for a single enterprise/period
 * (delete then insert) so re-materializing a period never leaves stale rows.
 * Returns the number of rows written.
 */
export function replaceMaterializedPeriod(
  enterpriseSlug: string,
  period: string,
  rows: LicensePeriodRowInput[]
): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO license_period_rows (
      enterprise_slug, billing_period, org_login, holder_key, github_user_id, user_login,
      resolved_user_login, external_identity, identity_resolution_source, account_state,
      license_assigned_date, user_revoked_date, plan_type, seat_status, assigned_via,
      last_activity_at, license_cost, default_aic_credits, default_aic_usd, aic_assigned_usd,
      aic_assigned_rule, aic_consumed_credits, aic_consumed_usd, currency, row_source,
      consumption_source, history_confidence, data_quality_notes, as_of_utc, generated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items: LicensePeriodRowInput[]) => {
    db.prepare(`DELETE FROM license_period_rows WHERE enterprise_slug = ? AND billing_period = ?`).run(
      enterpriseSlug,
      period
    );
    for (const row of items) {
      stmt.run(
        enterpriseSlug,
        period,
        row.orgLogin ?? "",
        row.holderKey,
        row.githubUserId ?? null,
        row.userLogin ?? null,
        row.resolvedUserLogin ?? null,
        row.externalIdentity ?? null,
        row.identityResolutionSource,
        row.accountState ?? "unknown",
        row.licenseAssignedDate ?? null,
        row.userRevokedDate ?? null,
        row.planType ?? "unknown",
        row.seatStatus,
        row.assignedVia,
        row.lastActivityAt ?? null,
        row.licenseCost ?? 0,
        row.defaultAicCredits ?? 0,
        row.defaultAicUsd ?? 0,
        row.aicAssignedUsd ?? 0,
        row.aicAssignedRule,
        row.aicConsumedCredits ?? 0,
        row.aicConsumedUsd ?? 0,
        row.currency ?? "USD",
        row.rowSource,
        row.consumptionSource ?? null,
        row.historyConfidence,
        stableStringify(row.dataQualityNotes ?? []),
        row.asOfUtc,
        row.generatedAtUtc
      );
    }
  });
  tx(rows);
  return rows.length;
}
