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
import type { LicensePeriodFilterQuery, LicenseHistoryKPIs, LicenseHistoryGroupBreakdown } from "@/lib/types/licensing";
import type { SeatLedgerConfidence } from "@/lib/licensing/seat-ledger";

// ── Deterministic JSON serialization ─────────────────────────────────

/**
 * Serialize a value to JSON with object keys sorted recursively so the same
 * logical payload always produces the same byte-for-byte string (array
 * order is preserved as-is). Used for `raw_json`/detail columns so repeated
 * upserts of equivalent data are stable and diff-friendly.
 *
 * Always returns a string: `JSON.stringify` itself returns the JS value
 * `undefined` (not the string `"undefined"`) for inputs like `undefined`,
 * functions, or symbols, which would violate SQLite's TEXT column
 * contract and this function's own return type at runtime. Falling back to
 * the literal string `"null"` keeps the contract honest.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? "null";
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

function parseRawJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
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

export interface PersistedLicenseAuditEvent extends LicenseAuditEventInput {
  holderKey: string;
}

export interface PersistedLicenseSeatSnapshot extends LicenseSeatSnapshotInput {
  billingPeriod: string;
}

export type PersistedLicenseIdentityRecord = LicenseIdentityRecordInput;

export type PersistedLicenseOrgBillingSnapshot = LicenseOrgBillingSnapshotInput;

export type PersistedLicenseAicConsumption = LicenseAicConsumptionInput;

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

/**
 * Canonical sentinel used when a period row has no attributed organization
 * (e.g. an enterprise-only seat/consumption record). Deliberately never the
 * empty string: GROUP_CONCAT(DISTINCT ...)/COUNT(DISTINCT ...) in the
 * rollup query, and `splitDistinct`'s length>0 filter, must agree on
 * whether an "unattributed" org is present in a group — an empty string
 * would be silently dropped by that filter while still being counted by
 * COUNT(DISTINCT), producing a rollup row where `orgCount` and
 * `orgLogins.length` disagree.
 */
export const UNATTRIBUTED_ORG = "(unattributed)";

/** Normalize a possibly-missing org login to the canonical {@link UNATTRIBUTED_ORG} sentinel. */
function normalizeOrgLogin(orgLogin: string | null | undefined): string {
  const trimmed = (orgLogin ?? "").trim();
  return trimmed.length > 0 ? trimmed : UNATTRIBUTED_ORG;
}

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
  historyConfidence: SeatLedgerConfidence;
  dataQualityNotes: unknown[];
  asOfUtc: string;
  generatedAtUtc: string;
}

export interface LicenseRollupRowRecord {
  enterpriseSlug: string;
  resolvedUserLogin: string;
  /** Distinct "YYYY-MM" billing periods contributing to this rollup row. */
  periods: string[];
  /** Distinct org logins (or {@link UNATTRIBUTED_ORG}) contributing to this rollup row. */
  orgLogins: string[];
  planTypes: string[];
  /**
   * Distinct (org_login, holder_key) seat pairs held across the selected
   * periods — a seat held in the same org across multiple periods counts
   * once, not once per period-row. Use {@link periodCount} for the number
   * of distinct periods, and the underlying detail rows (view: "detail")
   * for a full period-by-period breakdown.
   */
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
  /**
   * Worst (most conservative) {@link SeatLedgerConfidence} across every row
   * folded into this rollup group — a single low-confidence row must never
   * be masked by other, better-attested rows for the same resolved login
   * (see `CONFIDENCE_RANK_SQL`/`worstConfidence` in `seat-ledger.ts` for the
   * same worst-wins convention applied there). `"unknown"` is a defensive
   * sentinel that should be unreachable in practice — every group has at
   * least one row, and every persisted row's `history_confidence` is one of
   * the four real {@link SeatLedgerConfidence} values — but is returned
   * rather than throwing if a row's value is ever missing/corrupt.
   */
  historyConfidence: SeatLedgerConfidence | "unknown";
}

/**
 * Extends the shared {@link LicensePeriodFilterQuery} (also used by
 * `getMaterializedPeriodKPIs`/`getMaterializedPlanBreakdown`/
 * `getMaterializedOrgBreakdown`/`hasMaterializedRows`, so every materialized
 * query in this module filters identically) with the pagination/sort/view
 * fields specific to the paginated detail/rollup query.
 */
export interface LicensePeriodQuery extends LicensePeriodFilterQuery {
  /** "detail" (default) returns one row per period/org/holder; "rollup" groups by resolved login. */
  view?: "detail" | "rollup";
  page?: number;
  pageSize?: number;
  sortField?: string;
  sortDir?: "asc" | "desc";
}

export interface LicenseRowsPagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PaginatedLicenseDetailRows {
  view: "detail";
  rows: LicensePeriodRowRecord[];
  pagination: LicenseRowsPagination;
}

export interface PaginatedLicenseRollupRows {
  view: "rollup";
  rows: LicenseRollupRowRecord[];
  pagination: LicenseRowsPagination;
}

/** Discriminated on `view`, so callers who pass a literal `view` narrow to the right `rows` element type without casts. */
export type PaginatedLicenseRows = PaginatedLicenseDetailRows | PaginatedLicenseRollupRows;

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
  "total_cost",
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
  "total_cost",
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

/**
 * Build a shared WHERE clause from a query's filters. Takes the minimal
 * {@link LicensePeriodFilterQuery} shape (rather than the full
 * `LicensePeriodQuery`) so it can be reused by every materialized query in
 * this module — the paginated detail/rollup query, KPI totals, plan/org
 * breakdowns, and the existence check — guaranteeing they all filter
 * identically.
 *
 * This remains repository-specific rather than using similarly named helpers
 * in other repositories: those helpers are module-private and match only
 * `user_login`, while historical identity recovery must match `user_login`,
 * `resolved_user_login`, or `holder_key`. It also intentionally treats an
 * explicit empty `allowedLogins` array as deny-all rather than unrestricted.
 */
function appendPeriodFilters(clauses: string[], params: unknown[], query: LicensePeriodFilterQuery): void {
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
    const parts = query.logins.map(() => `(LOWER(user_login) = ? OR LOWER(resolved_user_login) = ? OR LOWER(holder_key) = ?)`);
    clauses.push(`(${parts.join(" OR ")})`);
    for (const login of query.logins) {
      const normalizedLogin = login.toLowerCase();
      params.push(normalizedLogin, normalizedLogin, normalizedLogin);
    }
  }
  // Team/org-resolved login allowlist (see LicensePeriodFilterQuery.allowedLogins
  // doc). Distinguished from `logins` above: `undefined` means unrestricted,
  // but an explicitly *empty* array must fail closed to zero rows — the
  // caller resolved a team/org scope with no members, never "unrestricted".
  // A hard `1 = 0` clause (rather than skipping the filter) is what makes
  // that failure mode safe: it can never accidentally be OR'd away by a
  // later clause, and it composes identically whether this is the only
  // filter or combined with others via the shared AND-joined `clauses` list.
  if (query.allowedLogins !== undefined) {
    if (query.allowedLogins.length === 0) {
      clauses.push("1 = 0");
    } else {
      const parts = query.allowedLogins.map(() => `(LOWER(user_login) = ? OR LOWER(resolved_user_login) = ? OR LOWER(holder_key) = ?)`);
      clauses.push(`(${parts.join(" OR ")})`);
      for (const login of query.allowedLogins) {
        const normalizedLogin = login.toLowerCase();
        params.push(normalizedLogin, normalizedLogin, normalizedLogin);
      }
    }
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
    orgLogin: normalizeOrgLogin(row.org_login as string | null),
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
    historyConfidence: row.history_confidence as SeatLedgerConfidence,
    dataQualityNotes: parseJsonArray(row.data_quality_notes as string | null),
    asOfUtc: row.as_of_utc as string,
    generatedAtUtc: row.generated_at_utc as string,
  };
}

// Rank the four real `SeatLedgerConfidence` values (see seat-ledger.ts's own
// module doc and `worstConfidence`/`CONFIDENCE_WORST_TO_BEST`) from best (3)
// to worst (0), so `MIN(CONFIDENCE_RANK_SQL)` over a GROUP BY picks out the
// single worst confidence present in the group. A rollup row summarizes
// potentially many detail rows (different periods/orgs) for one resolved
// login; reporting anything better than the worst constituent row's
// confidence would silently hide a low-confidence period/org behind a
// better-attested one — the same "worst wins" rationale documented for
// seat-ledger.ts's own per-(period,org) coverage aggregation. `ELSE -1`
// covers a defensive fallback for any unexpected/corrupt value (never
// produced by this module's own writers, which only ever persist one of the
// four real values).
const CONFIDENCE_RANK_SQL = `CASE history_confidence
  WHEN 'exact_snapshot' THEN 3
  WHEN 'audit_reconstructed' THEN 2
  WHEN 'live_snapshot_only' THEN 1
  WHEN 'unrecoverable' THEN 0
  ELSE -1
END`;
const RANK_TO_CONFIDENCE: Record<number, SeatLedgerConfidence | "unknown"> = {
  3: "exact_snapshot",
  2: "audit_reconstructed",
  1: "live_snapshot_only",
  0: "unrecoverable",
  [-1]: "unknown",
};

/**
 * Per-row effective budget: the assigned AI-credit budget when set, else the
 * plan's default allowance, else 0. Mirrors `materialize-license-period.ts`'s
 * `finalizeRow` so overage/utilization computed here from persisted columns
 * always agrees with the materializer's own (pre-persistence) calculation.
 */
const EFFECTIVE_BUDGET_SQL = `
  CASE
    WHEN aic_assigned_rule = 'per_user_budget' THEN aic_assigned_usd
    WHEN aic_assigned_usd > 0 THEN aic_assigned_usd
    WHEN default_aic_usd > 0 THEN default_aic_usd
    ELSE 0
  END
`;

// Sum each row's assigned-or-default effective budget. Choosing one budget
// column for the whole group would drop default budgets from mixed groups and
// make utilization disagree with the per-row overage and bucket calculations.
const UTILIZATION_PCT_SQL = `
  CASE
    WHEN COALESCE(SUM(${EFFECTIVE_BUDGET_SQL}), 0) > 0
      THEN (COALESCE(SUM(aic_consumed_usd), 0) / SUM(${EFFECTIVE_BUDGET_SQL})) * 100
    ELSE 0
  END
`;

// Hardcoded (never built from user input) expression backing `sort=total_cost`
// for the detail grain, matching the live path's `total_cost = license_cost +
// aic_consumed_usd` (see `license-repo.ts`'s `getLicenseReconciliationRows`).
// Selected as a `total_cost` output alias so the existing, unmodified
// `buildOrderBy` helper can reference it by name exactly like any other
// allowlisted physical column — no bespoke ORDER BY construction needed.
const DETAIL_TOTAL_COST_SQL = `(license_cost + aic_consumed_usd) AS total_cost`;

// Rollup equivalent of `DETAIL_TOTAL_COST_SQL`. SQLite doesn't allow a SELECT
// expression to reference another alias from the same SELECT list, so the
// two underlying SUM(...) aggregates are repeated inline here (same
// constraint documented above `UTILIZATION_PCT_SQL`) rather than adding
// `license_cost + aic_consumed_usd` as a plain alias reference.
const ROLLUP_TOTAL_COST_SQL = `(COALESCE(SUM(license_cost), 0) + COALESCE(SUM(aic_consumed_usd), 0)) AS total_cost`;

function splitDistinct(value: string | null | undefined): string[] {
  if (!value) return [];
  // GROUP_CONCAT(DISTINCT ...) joins with a comma by default. Values stored
  // in these columns (billing_period, org_login, plan_type) are structural
  // identifiers that never contain commas, so a plain split is safe.
  return value
    .split(",")
    .filter((v) => v.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve which column `buildOrderBy` will actually sort by: the requested
 * `sortField` when it's in the allowlist, otherwise `defaultColumn`. Mirrors
 * `buildOrderBy`'s own resolution logic (see `@/lib/api/pagination`) so tie
 * breakers can be deduped against whichever column ends up primary.
 */
function resolvePrimarySortColumn(pagination: PaginationParams, allowedColumns: string[], defaultColumn: string): string {
  return allowedColumns.includes(pagination.sortField) ? pagination.sortField : defaultColumn;
}

const DETAIL_TIE_BREAKER_COLUMNS = ["enterprise_slug", "billing_period", "org_login", "holder_key"];
const ROLLUP_TIE_BREAKER_COLUMNS = ["enterprise_slug", "resolved_user_login"];

/**
 * Build a detail-view ORDER BY clause with deterministic tie-breakers on the
 * full primary key (enterprise_slug, billing_period, org_login, holder_key),
 * so OFFSET-based pagination never reorders/duplicates/skips rows across
 * pages when the requested sort column has ties. The primary sort column is
 * excluded from its own tie-breaker list (it's already fully ordering by
 * itself) so the clause never mentions the same column twice with
 * potentially conflicting directions.
 *
 * Exported for direct unit testing of the generated clause; not intended as
 * a general-purpose API for callers outside this module.
 */
export function buildDetailOrderBy(pagination: PaginationParams): string {
  const base = buildOrderBy(pagination, DETAIL_SORT_COLUMNS, "billing_period");
  const primary = resolvePrimarySortColumn(pagination, DETAIL_SORT_COLUMNS, "billing_period");
  const tieBreakers = DETAIL_TIE_BREAKER_COLUMNS.filter((column) => column !== primary);
  return tieBreakers.length ? `${base}, ${tieBreakers.map((column) => `${column} ASC`).join(", ")}` : base;
}

/**
 * Build a rollup-view ORDER BY clause with deterministic tie-breakers on the
 * group key (enterprise_slug, resolved login), so OFFSET-based pagination
 * stays stable across pages when the requested sort column has ties. Same
 * primary-column dedup as {@link buildDetailOrderBy}.
 *
 * Exported for direct unit testing of the generated clause; not intended as
 * a general-purpose API for callers outside this module.
 */
export function buildRollupOrderBy(pagination: PaginationParams): string {
  const base = buildOrderBy(pagination, ROLLUP_SORT_COLUMNS, "resolved_user_login");
  const primary = resolvePrimarySortColumn(pagination, ROLLUP_SORT_COLUMNS, "resolved_user_login");
  const tieBreakers = ROLLUP_TIE_BREAKER_COLUMNS.filter((column) => column !== primary);
  return tieBreakers.length ? `${base}, ${tieBreakers.map((column) => `${column} ASC`).join(", ")}` : base;
}

// ── Shared detail/rollup SQL builders ────────────────────────────────
// Used by both `queryLicensePeriodRows` (paginated) and
// `queryLicensePeriodExport` (bounded, single-snapshot) so the two never
// drift out of sync on filtering, column selection, or row mapping.

function detailCountSql(where: string): string {
  return `SELECT COUNT(*) as total FROM license_period_rows${where}`;
}

function detailSelectSql(where: string): string {
  return `SELECT *, ${DETAIL_TOTAL_COST_SQL} FROM license_period_rows${where}`;
}

const ROLLUP_GROUP_KEY_SQL = `COALESCE(NULLIF(resolved_user_login, ''), holder_key)`;

function rollupCountSql(where: string): string {
  return `SELECT COUNT(*) as total FROM (SELECT 1 FROM license_period_rows${where} GROUP BY enterprise_slug, ${ROLLUP_GROUP_KEY_SQL})`;
}

function rollupSelectSql(where: string): string {
  return `
    SELECT
      enterprise_slug AS enterprise_slug,
      ${ROLLUP_GROUP_KEY_SQL} AS resolved_user_login,
      GROUP_CONCAT(DISTINCT billing_period) AS periods,
      GROUP_CONCAT(DISTINCT org_login) AS org_logins,
      GROUP_CONCAT(DISTINCT plan_type) AS plan_types,
      COUNT(DISTINCT org_login || char(1) || holder_key) AS seat_count,
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
      ${UTILIZATION_PCT_SQL} AS utilization_pct,
      ${ROLLUP_TOTAL_COST_SQL}
    FROM license_period_rows${where}
    GROUP BY enterprise_slug, ${ROLLUP_GROUP_KEY_SQL}
  `;
}

function mapRollupRow(row: Record<string, unknown>): LicenseRollupRowRecord {
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
}

/**
 * Query `license_period_rows`, returning either the raw per-period detail
 * grain or a per-login rollup aggregated in SQL. Filtering, sorting, and
 * pagination are all pushed into SQL; only the current page of rows is ever
 * materialized in JS.
 *
 * Overloaded so a literal `view: "rollup"` (or an omitted/`"detail"` view)
 * narrows the return type's `rows` to the matching record type without a
 * manual cast; callers with a dynamic (non-literal) `view` get the full
 * {@link PaginatedLicenseRows} union and narrow at runtime via `result.view`.
 */
export function queryLicensePeriodRows(query: LicensePeriodQuery & { view: "rollup" }): PaginatedLicenseRollupRows;
export function queryLicensePeriodRows(query: LicensePeriodQuery & { view?: "detail" }): PaginatedLicenseDetailRows;
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
    const countRow = db.prepare(detailCountSql(where)).get(...params) as { total: number };
    const rows = db
      .prepare(`${detailSelectSql(where)} ${orderBy} ${limitClause}`)
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
  const countRow = db.prepare(rollupCountSql(where)).get(...params) as { total: number };
  const rows = db
    .prepare(`${rollupSelectSql(where)} ${orderBy} ${limitClause}`)
    .all(...params, ...limitValues) as Record<string, unknown>[];

  return {
    view,
    rows: rows.map(mapRollupRow),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems: countRow.total,
      totalPages: Math.ceil(countRow.total / pagination.pageSize),
    },
  };
}

// ── Bounded, single-snapshot export query ────────────────────────────

/**
 * Hard cap on rows a single {@link queryLicensePeriodExport} call will ever
 * fetch/emit — independent of (and typically far larger than) any single
 * page of `queryLicensePeriodRows`. Exported so callers (e.g. the CSV export
 * route) reference the same source of truth instead of duplicating the
 * number, and so tests can assert against it directly rather than a magic
 * literal.
 */
export const EXPORT_MAX_ROWS = 5000;

/**
 * Query shape for {@link queryLicensePeriodExport}: the same shared filters
 * as {@link LicensePeriodQuery} (minus its OFFSET-pagination fields, which
 * don't apply to a single bounded full-scope fetch), plus an optional
 * caller-supplied `maxRows` (validated/clamped by {@link resolveExportMaxRows}).
 */
export interface LicensePeriodExportQuery extends LicensePeriodFilterQuery {
  view?: "detail" | "rollup";
  sortField?: string;
  sortDir?: "asc" | "desc";
  /** Caller-supplied cap; must be a positive integer. Clamped down to {@link EXPORT_MAX_ROWS} if larger; never widens past the hard cap. */
  maxRows?: number;
}

/** Returned when the true row count exceeds the resolved cap — no row SELECT is ever issued in this case. */
export interface LicensePeriodExportTooLarge {
  tooLarge: true;
  totalItems: number;
}

export interface LicensePeriodExportDetail {
  tooLarge: false;
  view: "detail";
  rows: LicensePeriodRowRecord[];
  totalItems: number;
}

export interface LicensePeriodExportRollup {
  tooLarge: false;
  view: "rollup";
  rows: LicenseRollupRowRecord[];
  totalItems: number;
}

/** Discriminated first on `tooLarge`, then (when `false`) on `view` — mirrors {@link PaginatedLicenseRows}'s narrowing convention. */
export type LicensePeriodExportResult =
  | LicensePeriodExportTooLarge
  | LicensePeriodExportDetail
  | LicensePeriodExportRollup;

/**
 * Validate and clamp a caller-supplied `maxRows`. This is a programmer
 * contract, not user input validation — callers (the export route) must
 * already validate/derive any user-facing request parameters before calling
 * this function, so a non-positive or non-integer value here is a bug at the
 * call site, not a 400-worthy request error, and therefore throws rather
 * than returning a soft error.
 */
function resolveExportMaxRows(maxRows: number | undefined): number {
  if (maxRows === undefined) return EXPORT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new RangeError(`maxRows must be a positive integer, received ${maxRows}`);
  }
  return Math.min(maxRows, EXPORT_MAX_ROWS);
}

/**
 * Bounded, transaction-consistent export query: runs the total-count guard
 * and (only if the count is within bounds) the full bounded detail/rollup
 * SELECT inside a single `db.transaction(...)` call, so both statements
 * observe the exact same snapshot even if another writer commits between
 * them — no possibility of a count/rows mismatch from an interleaved write.
 *
 * Reuses the same filter (`appendPeriodFilters`/`buildWhereClause`), sort
 * (`buildDetailOrderBy`/`buildRollupOrderBy`), and SQL-building
 * (`detailSelectSql`/`rollupSelectSql`) logic as {@link queryLicensePeriodRows}
 * — no separate filter/sort implementation to drift out of sync.
 *
 * When the true row count exceeds the resolved cap (see
 * {@link resolveExportMaxRows}), returns `{ tooLarge: true, totalItems }`
 * WITHOUT ever issuing the row-fetch SELECT — callers must reject the
 * request rather than attempt a partial/truncated export.
 *
 * No OFFSET/paging: this always fetches up to `maxRows` rows in one shot
 * (`LIMIT ? `, no `OFFSET`), so a caller must never loop pages against this
 * function — call it exactly once per export.
 */
export function queryLicensePeriodExport(
  query: LicensePeriodExportQuery & { view: "rollup" },
): LicensePeriodExportTooLarge | LicensePeriodExportRollup;
export function queryLicensePeriodExport(
  query: LicensePeriodExportQuery & { view?: "detail" },
): LicensePeriodExportTooLarge | LicensePeriodExportDetail;
export function queryLicensePeriodExport(query: LicensePeriodExportQuery): LicensePeriodExportResult {
  const db = getDb();
  const view = query.view === "rollup" ? "rollup" : "detail";
  const maxRows = resolveExportMaxRows(query.maxRows);
  const clauses: string[] = [];
  const params: unknown[] = [];
  appendPeriodFilters(clauses, params, query);
  const where = buildWhereClause(clauses);
  const pagination: PaginationParams = {
    page: 1,
    pageSize: maxRows,
    sortField: query.sortField || "",
    sortDir: query.sortDir === "asc" ? "asc" : "desc",
    search: query.search,
  };

  const run = db.transaction((): LicensePeriodExportResult => {
    if (view === "detail") {
      const countRow = db.prepare(detailCountSql(where)).get(...params) as { total: number };
      if (countRow.total > maxRows) {
        return { tooLarge: true, totalItems: countRow.total };
      }
      const orderBy = buildDetailOrderBy(pagination);
      const rows = db
        .prepare(`${detailSelectSql(where)} ${orderBy} LIMIT ?`)
        .all(...params, maxRows) as Record<string, unknown>[];
      return { tooLarge: false, view: "detail", rows: rows.map(mapDetailRow), totalItems: countRow.total };
    }

    const countRow = db.prepare(rollupCountSql(where)).get(...params) as { total: number };
    if (countRow.total > maxRows) {
      return { tooLarge: true, totalItems: countRow.total };
    }
    const orderBy = buildRollupOrderBy(pagination);
    const rows = db
      .prepare(`${rollupSelectSql(where)} ${orderBy} LIMIT ?`)
      .all(...params, maxRows) as Record<string, unknown>[];
    return { tooLarge: false, view: "rollup", rows: rows.map(mapRollupRow), totalItems: countRow.total };
  });

  return run();
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
  // Plain INSERT (not INSERT OR REPLACE): the preceding DELETE already
  // clears this enterprise/period scope, so a duplicate (org_login,
  // holder_key) key within the *same* input batch indicates a bug in the
  // caller producing the snapshot batch. Silently last-write-wins would
  // hide that bug; failing (and rolling back the whole batch, including
  // the DELETE) surfaces it instead.
  const stmt = db.prepare(`
    INSERT INTO license_seat_snapshots (
      enterprise_slug, billing_period, org_login, holder_key, github_user_id, observed_login,
      plan_type, assigned_via, last_activity_at, pending_cancellation_date, snapshot_at, source, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare(`DELETE FROM license_seat_snapshots WHERE enterprise_slug = ? AND billing_period = ?`);
  const tx = db.transaction((items: LicenseSeatSnapshotInput[]) => {
    deleteStmt.run(enterpriseSlug, period);
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

function buildPeriodInClause(periods: string[], column: string): { sql: string; params: string[] } {
  if (periods.length === 0) return { sql: " AND 1 = 0", params: [] };
  return {
    sql: ` AND ${column} IN (${periods.map(() => "?").join(", ")})`,
    params: periods,
  };
}

/**
 * Read durable normalized audit events through the latest requested period,
 * including all earlier retained events. Earlier assignments are required to
 * reconstruct intervals that opened before the requested period, so no lower
 * bound or row cap can be applied without losing durable recoverability.
 */
export function listPersistedAuditEvents(
  enterpriseSlug: string,
  periods: string[],
): PersistedLicenseAuditEvent[] {
  if (periods.length === 0) return [];
  const db = getDb();
  const latestPeriod = [...periods].sort().at(-1)!;
  const rows = db.prepare(`
    SELECT event_id, org_login, action, occurred_at, github_user_id,
           observed_login, external_identity, assigned_via, source, raw_json
    FROM license_audit_events
    WHERE enterprise_slug = ? AND substr(occurred_at, 1, 7) <= ?
    ORDER BY occurred_at ASC, event_id ASC
  `).all(enterpriseSlug, latestPeriod) as Record<string, unknown>[];

  return rows.map((row) => {
    const githubUserId = (row.github_user_id as number | null) ?? null;
    const observedLogin = (row.observed_login as string | null) ?? null;
    return {
      eventId: row.event_id as string,
      orgLogin: row.org_login as string,
      holderKey: githubUserId != null
        ? `id:${githubUserId}`
        : `login:${(observedLogin ?? "unknown").toLowerCase()}`,
      action: row.action as string,
      occurredAt: row.occurred_at as string,
      githubUserId,
      observedLogin,
      externalIdentity: (row.external_identity as string | null) ?? null,
      assignedVia: (row.assigned_via as string | null) ?? null,
      source: row.source as string,
      raw: parseRawJson(row.raw_json as string | null),
    };
  });
}

/** Read durable seat snapshots for the requested periods. */
export function listPersistedSeatSnapshots(
  enterpriseSlug: string,
  periods: string[],
): PersistedLicenseSeatSnapshot[] {
  const db = getDb();
  const periodFilter = buildPeriodInClause(periods, "billing_period");
  const rows = db.prepare(`
    SELECT billing_period, org_login, holder_key, github_user_id, observed_login,
           plan_type, assigned_via, last_activity_at, pending_cancellation_date,
           snapshot_at, source, raw_json
    FROM license_seat_snapshots
    WHERE enterprise_slug = ?${periodFilter.sql}
    ORDER BY billing_period ASC, org_login ASC, holder_key ASC
  `).all(enterpriseSlug, ...periodFilter.params) as Record<string, unknown>[];

  return rows.map((row) => ({
    billingPeriod: row.billing_period as string,
    orgLogin: row.org_login as string,
    holderKey: row.holder_key as string,
    githubUserId: (row.github_user_id as number | null) ?? null,
    observedLogin: (row.observed_login as string | null) ?? null,
    planType: row.plan_type as string,
    assignedVia: row.assigned_via as string,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
    pendingCancellationDate: (row.pending_cancellation_date as string | null) ?? null,
    snapshotAt: row.snapshot_at as string,
    source: row.source as string,
    raw: parseRawJson(row.raw_json as string | null),
  }));
}

/** Read every durable identity record for one enterprise. */
export function listPersistedIdentityRecords(
  enterpriseSlug: string,
): PersistedLicenseIdentityRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT identity_key, github_user_id, resolved_login, external_identity,
           account_state, resolution_source, observed_at, raw_json
    FROM license_identity_records
    WHERE enterprise_slug = ?
    ORDER BY observed_at DESC, identity_key ASC, resolution_source ASC
  `).all(enterpriseSlug) as Record<string, unknown>[];

  return rows.map((row) => ({
    identityKey: row.identity_key as string,
    githubUserId: (row.github_user_id as number | null) ?? null,
    resolvedLogin: (row.resolved_login as string | null) ?? null,
    externalIdentity: (row.external_identity as string | null) ?? null,
    accountState: row.account_state as string,
    resolutionSource: row.resolution_source as string,
    observedAt: row.observed_at as string,
    raw: parseRawJson(row.raw_json as string | null),
  }));
}

/** Read durable organization billing comparators for the requested periods. */
export function listPersistedOrgBillingSnapshots(
  enterpriseSlug: string,
  periods: string[],
): PersistedLicenseOrgBillingSnapshot[] {
  const db = getDb();
  const periodFilter = buildPeriodInClause(periods, "billing_period");
  const rows = db.prepare(`
    SELECT billing_period, org_login, plan_type, total_seats,
           pending_cancellation, observed_at, raw_json
    FROM license_org_billing_snapshots
    WHERE enterprise_slug = ?${periodFilter.sql}
    ORDER BY billing_period ASC, org_login ASC
  `).all(enterpriseSlug, ...periodFilter.params) as Record<string, unknown>[];

  return rows.map((row) => ({
    billingPeriod: row.billing_period as string,
    orgLogin: row.org_login as string,
    planType: (row.plan_type as string | null) ?? null,
    totalSeats: row.total_seats as number,
    pendingCancellation: row.pending_cancellation as number,
    observedAt: row.observed_at as string,
    raw: parseRawJson(row.raw_json as string | null),
  }));
}

/** Read durable AI-credit source rows for the requested periods. */
export function listPersistedAicConsumption(
  enterpriseSlug: string,
  periods: string[],
): PersistedLicenseAicConsumption[] {
  const db = getDb();
  const periodFilter = buildPeriodInClause(periods, "billing_period");
  const rows = db.prepare(`
    SELECT billing_period, org_login, holder_key, username, credits,
           gross_usd, net_usd, source, observed_at, raw_json
    FROM license_aic_consumption
    WHERE enterprise_slug = ?${periodFilter.sql}
    ORDER BY billing_period ASC, org_login ASC, holder_key ASC, source ASC
  `).all(enterpriseSlug, ...periodFilter.params) as Record<string, unknown>[];

  return rows.map((row) => ({
    billingPeriod: row.billing_period as string,
    orgLogin: row.org_login as string,
    holderKey: row.holder_key as string,
    username: (row.username as string | null) ?? null,
    credits: row.credits as number,
    grossUsd: row.gross_usd as number,
    netUsd: (row.net_usd as number | null) ?? null,
    source: row.source as string,
    observedAt: row.observed_at as string,
    raw: parseRawJson(row.raw_json as string | null),
  }));
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
  // Plain INSERT (not INSERT OR REPLACE): the preceding DELETE already
  // clears this enterprise/period scope, so a duplicate (org_login,
  // holder_key) key within the *same* materialization batch indicates a bug
  // upstream (e.g. two source rows resolved to the same holder without being
  // merged). Silently last-write-wins would hide that bug in the
  // reconciliation output; failing (and rolling back the whole batch,
  // including the DELETE) surfaces it instead.
  const stmt = db.prepare(`
    INSERT INTO license_period_rows (
      enterprise_slug, billing_period, org_login, holder_key, github_user_id, user_login,
      resolved_user_login, external_identity, identity_resolution_source, account_state,
      license_assigned_date, user_revoked_date, plan_type, seat_status, assigned_via,
      last_activity_at, license_cost, default_aic_credits, default_aic_usd, aic_assigned_usd,
      aic_assigned_rule, aic_consumed_credits, aic_consumed_usd, currency, row_source,
      consumption_source, history_confidence, data_quality_notes, as_of_utc, generated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare(`DELETE FROM license_period_rows WHERE enterprise_slug = ? AND billing_period = ?`);
  const tx = db.transaction((items: LicensePeriodRowInput[]) => {
    deleteStmt.run(enterpriseSlug, period);
    for (const row of items) {
      stmt.run(
        enterpriseSlug,
        period,
        normalizeOrgLogin(row.orgLogin),
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

// ── Materialized history: KPI totals / breakdowns / existence check ─────
//
// All aggregation happens in SQL (COUNT/SUM/GROUP BY) — full row sets are
// never loaded into JS just to total them, per project performance
// guidelines. Every function here shares `appendPeriodFilters` with
// `queryLicensePeriodRows`, so a KPI/breakdown call and a paginated detail
// call for the same filter object always agree on which rows are in scope.

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Per-row overage in USD: `MAX(consumed - effective budget, 0)` — the 2+
 * argument form of SQLite's `MAX()` is the per-row *scalar* function (not
 * the single-argument aggregate), so this expression is evaluated once per
 * row before an enclosing `SUM()` aggregates it. Doing `MAX(SUM(consumed) -
 * SUM(budget), 0)` instead would be wrong whenever some rows are under
 * budget and others are over: this clamps every row individually first.
 */
const OVERAGE_USD_SQL = `MAX(aic_consumed_usd - (${EFFECTIVE_BUDGET_SQL}), 0)`;

function buildFilterWhere(query: LicensePeriodFilterQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  appendPeriodFilters(clauses, params, query);
  return { where: buildWhereClause(clauses), params };
}

/**
 * Headline KPI totals for materialized `license_period_rows` matching a
 * filter, aggregated entirely in SQL. Returns all-zero counts (and
 * `currency: "USD"`) for a scope with no matching rows — never throws, never
 * NaN/Infinity — so callers can safely combine this with
 * {@link hasMaterializedRows} to detect "no historical data yet" and fall
 * back to the legacy live-query path (`license-repo.ts`) without a false
 * historical success.
 */
export function getMaterializedPeriodKPIs(query: LicensePeriodFilterQuery = {}): LicenseHistoryKPIs {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);
  const groupKey = `COALESCE(NULLIF(resolved_user_login, ''), holder_key)`;

  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total_rows,
        COUNT(DISTINCT ${groupKey}) AS total_users,
        COALESCE(SUM(CASE WHEN seat_status = 'active' THEN 1 ELSE 0 END), 0) AS active_seats,
        COALESCE(SUM(CASE WHEN seat_status != 'active' THEN 1 ELSE 0 END), 0) AS inactive_seats,
        -- A no_seat row is consumption with no seat behind it. Those are rows,
        -- not seats, so they must be excluded from any seat count; counting
        -- them as inactive seats reported unmatched consumption as licences.
        COALESCE(SUM(CASE WHEN seat_status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive_seat_rows,
        COALESCE(SUM(CASE WHEN seat_status = 'no_seat' THEN 1 ELSE 0 END), 0) AS no_seat_rows,
        -- Distinct users, not a seat-row count: one user can hold several seats.
        COUNT(DISTINCT CASE WHEN seat_status = 'active' THEN ${groupKey} END) AS active_users,
        COALESCE(SUM(CASE WHEN aic_consumed_credits <= 0 THEN 1 ELSE 0 END), 0) AS zero_consumption_rows,
        COALESCE(SUM(license_cost), 0) AS total_license_cost,
        COALESCE(SUM(default_aic_credits), 0) AS total_allowance_credits,
        COALESCE(SUM(aic_assigned_usd), 0) AS total_assigned_usd,
        COALESCE(SUM(aic_consumed_credits), 0) AS total_consumed_credits,
        COALESCE(SUM(aic_consumed_usd), 0) AS total_consumed_usd,
        COALESCE(SUM(CASE WHEN aic_consumed_usd > (${EFFECTIVE_BUDGET_SQL}) THEN 1 ELSE 0 END), 0) AS over_budget_rows,
        COALESCE(SUM(${OVERAGE_USD_SQL}), 0) AS total_overage_usd,
        ${UTILIZATION_PCT_SQL} AS overall_utilization_pct,
        MAX(currency) AS currency
      FROM license_period_rows${where}
    `
    )
    .get(...params) as Record<string, number | string | null>;

  const totalLicenseCost = round2((row.total_license_cost as number) ?? 0);
  const totalOverageUsd = round2((row.total_overage_usd as number) ?? 0);

  return {
    totalRows: (row.total_rows as number) ?? 0,
    totalUsers: (row.total_users as number) ?? 0,
    activeSeats: (row.active_seats as number) ?? 0,
    inactiveSeats: (row.inactive_seats as number) ?? 0,
    inactiveSeatRows: (row.inactive_seat_rows as number) ?? 0,
    noSeatRows: (row.no_seat_rows as number) ?? 0,
    activeUsers: (row.active_users as number) ?? 0,
    zeroConsumptionRows: (row.zero_consumption_rows as number) ?? 0,
    totalLicenseCost,
    totalAllowanceCredits: round2((row.total_allowance_credits as number) ?? 0),
    totalAssignedUsd: round2((row.total_assigned_usd as number) ?? 0),
    totalConsumedCredits: round2((row.total_consumed_credits as number) ?? 0),
    totalConsumedUsd: round2((row.total_consumed_usd as number) ?? 0),
    overallUtilizationPct: round2((row.overall_utilization_pct as number) ?? 0),
    overBudgetRows: (row.over_budget_rows as number) ?? 0,
    totalOverageUsd,
    totalCostOfOwnership: round2(totalLicenseCost + totalOverageUsd),
    currency: (row.currency as string) || "USD",
  };
}

function queryGroupBreakdown(groupByColumn: "plan_type" | "org_login", query: LicensePeriodFilterQuery): LicenseHistoryGroupBreakdown[] {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);

  const rows = db
    .prepare(
      `
      SELECT
        ${groupByColumn} AS group_key,
        COUNT(*) AS row_count,
        COALESCE(SUM(license_cost), 0) AS license_cost,
        COALESCE(SUM(default_aic_credits), 0) AS allowance_credits,
        COALESCE(SUM(aic_assigned_usd), 0) AS assigned_usd,
        COALESCE(SUM(aic_consumed_credits), 0) AS consumed_credits,
        COALESCE(SUM(aic_consumed_usd), 0) AS consumed_usd,
        COALESCE(SUM(${OVERAGE_USD_SQL}), 0) AS overage_usd,
        ${UTILIZATION_PCT_SQL} AS utilization_pct
      FROM license_period_rows${where}
      GROUP BY ${groupByColumn}
      ORDER BY consumed_credits DESC, row_count DESC
    `
    )
    .all(...params) as Record<string, number | string>[];

  return rows.map((r) => ({
    key: r.group_key as string,
    rows: (r.row_count as number) ?? 0,
    licenseCost: round2((r.license_cost as number) ?? 0),
    allowanceCredits: round2((r.allowance_credits as number) ?? 0),
    assignedUsd: round2((r.assigned_usd as number) ?? 0),
    consumedCredits: round2((r.consumed_credits as number) ?? 0),
    consumedUsd: round2((r.consumed_usd as number) ?? 0),
    utilizationPct: round2((r.utilization_pct as number) ?? 0),
    overageUsd: round2((r.overage_usd as number) ?? 0),
  }));
}

/** Allocation-vs-consumption breakdown by plan, aggregated in SQL over materialized rows matching a filter. Empty array for a scope with no matching rows. */
export function getMaterializedPlanBreakdown(query: LicensePeriodFilterQuery = {}): LicenseHistoryGroupBreakdown[] {
  return queryGroupBreakdown("plan_type", query);
}

/** Allocation-vs-consumption breakdown by org, aggregated in SQL over materialized rows matching a filter. Empty array for a scope with no matching rows. */
export function getMaterializedOrgBreakdown(query: LicensePeriodFilterQuery = {}): LicenseHistoryGroupBreakdown[] {
  return queryGroupBreakdown("org_login", query);
}

/**
 * True when at least one materialized `license_period_rows` row matches the
 * filter. Lets callers (e.g. the reconciliation API route) distinguish "no
 * history has been materialized for this scope yet — fall back to the
 * legacy live-query path" from a genuine (but empty) historical result,
 * without ever reporting a false historical success.
 */
export function hasMaterializedRows(query: LicensePeriodFilterQuery = {}): boolean {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);
  const row = db.prepare(`SELECT EXISTS(SELECT 1 FROM license_period_rows${where} LIMIT 1) AS found`).get(...params) as {
    found: number;
  };
  return row.found === 1;
}

const MAX_COVERAGE_PERIODS = 120;

/** Return the bounded set of materialized periods present in the requested row scope. */
export function getMaterializedPeriods(query: LicensePeriodFilterQuery = {}): string[] {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);
  const rows = db
    .prepare(`
      SELECT DISTINCT billing_period
      FROM license_period_rows${where}
      ORDER BY billing_period ASC
      LIMIT ?
    `)
    .all(...params, MAX_COVERAGE_PERIODS) as { billing_period: string }[];
  return rows.map((row) => row.billing_period);
}

/** Return the earliest materialized period present in the requested row scope. */
export function getEarliestMaterializedPeriod(
  query: LicensePeriodFilterQuery = {},
): string | null {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);
  const row = db
    .prepare(`
      SELECT MIN(billing_period) AS billing_period
      FROM license_period_rows${where}
    `)
    .get(...params) as { billing_period: string | null };
  return row.billing_period;
}

export interface MaterializedUtilizationBucket {
  label: string;
  min: number;
  /** `null` represents an open upper bound in the JSON response. */
  max: number | null;
  count: number;
}

/**
 * Aggregate historical utilization at the same enterprise/user rollup grain
 * as the historical rollup view, then bucket it entirely in SQL.
 */
export function getMaterializedUtilizationBuckets(
  query: LicensePeriodFilterQuery = {},
): MaterializedUtilizationBucket[] {
  const db = getDb();
  const { where, params } = buildFilterWhere(query);
  const row = db
    .prepare(`
      WITH user_utilization AS (
        SELECT
          enterprise_slug,
          COALESCE(NULLIF(resolved_user_login, ''), holder_key) AS resolved_login,
          CASE
            WHEN COALESCE(SUM(${EFFECTIVE_BUDGET_SQL}), 0) > 0
              THEN COALESCE(SUM(aic_consumed_usd), 0) * 100.0 / SUM(${EFFECTIVE_BUDGET_SQL})
            ELSE 0
          END AS utilization_pct
        FROM license_period_rows${where}
        GROUP BY enterprise_slug, COALESCE(NULLIF(resolved_user_login, ''), holder_key)
      )
      SELECT
        COALESCE(SUM(CASE WHEN utilization_pct <= 0 THEN 1 ELSE 0 END), 0) AS zero_count,
        COALESCE(SUM(CASE WHEN utilization_pct > 0 AND utilization_pct <= 25 THEN 1 ELSE 0 END), 0) AS low_count,
        COALESCE(SUM(CASE WHEN utilization_pct > 25 AND utilization_pct <= 50 THEN 1 ELSE 0 END), 0) AS medium_count,
        COALESCE(SUM(CASE WHEN utilization_pct > 50 AND utilization_pct <= 75 THEN 1 ELSE 0 END), 0) AS high_count,
        COALESCE(SUM(CASE WHEN utilization_pct > 75 AND utilization_pct <= 100 THEN 1 ELSE 0 END), 0) AS full_count,
        COALESCE(SUM(CASE WHEN utilization_pct > 100 THEN 1 ELSE 0 END), 0) AS over_count
      FROM user_utilization
    `)
    .get(...params) as Record<string, number>;

  return [
    { label: "0%", min: 0, max: 0, count: row.zero_count ?? 0 },
    { label: "1–25%", min: 0.0001, max: 25, count: row.low_count ?? 0 },
    { label: "26–50%", min: 25, max: 50, count: row.medium_count ?? 0 },
    { label: "51–75%", min: 50, max: 75, count: row.high_count ?? 0 },
    { label: "76–100%", min: 75, max: 100, count: row.full_count ?? 0 },
    { label: ">100%", min: 100, max: null, count: row.over_count ?? 0 },
  ];
}

export interface LicenseQualitySummary {
  pass: number;
  warning: number;
  fail: number;
}

export interface LicenseQualitySummaryQuery {
  enterpriseSlug?: string;
  enterpriseSlugs?: string[];
  periods?: string[];
  periodStart?: string;
  periodEnd?: string;
  orgLogins?: string[];
}

/**
 * Count checks from only the latest completed reconciliation run per
 * enterprise. The aggregate is a single bounded row and never exposes check
 * messages, details, identities, or other diagnostic payloads.
 */
export function getLatestLicenseQualitySummary(
  query: LicenseQualitySummaryQuery = {},
): LicenseQualitySummary {
  const db = getDb();
  const runClauses = ["completed_at IS NOT NULL"];
  const checkClauses: string[] = [];
  const runParams: unknown[] = [];
  const checkParams: unknown[] = [];
  const enterpriseSlugs = query.enterpriseSlugs?.length
    ? query.enterpriseSlugs
    : query.enterpriseSlug
      ? [query.enterpriseSlug]
      : [];

  if (enterpriseSlugs.length > 0) {
    runClauses.push(`enterprise_slug IN (${enterpriseSlugs.map(() => "?").join(",")})`);
    runParams.push(...enterpriseSlugs);
  }
  const requestedPeriodClauses: string[] = [];
  if (query.periods?.length) {
    requestedPeriodClauses.push(`requested_period.value IN (${query.periods.map(() => "?").join(",")})`);
    runParams.push(...query.periods);
    checkClauses.push(`c.billing_period IN (${query.periods.map(() => "?").join(",")})`);
    checkParams.push(...query.periods);
  }
  if (query.periodStart) {
    requestedPeriodClauses.push("requested_period.value >= ?");
    runParams.push(query.periodStart);
    checkClauses.push("c.billing_period >= ?");
    checkParams.push(query.periodStart);
  }
  if (query.periodEnd) {
    requestedPeriodClauses.push("requested_period.value <= ?");
    runParams.push(query.periodEnd);
    checkClauses.push("c.billing_period <= ?");
    checkParams.push(query.periodEnd);
  }
  if (requestedPeriodClauses.length > 0) {
    runClauses.push(`
      EXISTS (
        SELECT 1
        FROM json_each(COALESCE(requested_periods, '[]')) AS requested_period
        WHERE ${requestedPeriodClauses.join(" AND ")}
      )
    `);
  }
  if (query.orgLogins?.length) {
    checkClauses.push(`c.org_login IN (${query.orgLogins.map(() => "?").join(",")})`);
    checkParams.push(...query.orgLogins);
  }

  const checksWhere = checkClauses.length > 0 ? `WHERE ${checkClauses.join(" AND ")}` : "";
  const row = db
    .prepare(`
      WITH ranked_runs AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY enterprise_slug
            ORDER BY completed_at DESC, id DESC
          ) AS run_rank
        FROM license_reconciliation_runs
        WHERE ${runClauses.join(" AND ")}
      ),
      latest_runs AS (
        SELECT id FROM ranked_runs WHERE run_rank = 1
      )
      SELECT
        COALESCE(SUM(CASE WHEN c.status = 'pass' THEN 1 ELSE 0 END), 0) AS pass_count,
        COALESCE(SUM(CASE WHEN c.status = 'warning' THEN 1 ELSE 0 END), 0) AS warning_count,
        COALESCE(SUM(CASE WHEN c.status = 'fail' THEN 1 ELSE 0 END), 0) AS fail_count
      FROM latest_runs lr
      JOIN license_reconciliation_checks c ON c.run_id = lr.id
      ${checksWhere}
    `)
    .get(...runParams, ...checkParams) as Record<string, number>;

  return {
    pass: row.pass_count ?? 0,
    warning: row.warning_count ?? 0,
    fail: row.fail_count ?? 0,
  };
}
