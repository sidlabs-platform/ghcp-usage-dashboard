// Types for the License & AI Credits reconciliation view.
//
// This view reproduces every insight of the standalone copilot-aic-report tool
// (per-user Copilot license + AI-Credit reconciliation) directly in the
// dashboard, joining synced `copilot_seats` (license lifecycle) with
// `billing_premium_requests` (per-user AI-credit consumption) and applying
// configured pricing / allowances.

import type { LicensePlanKey } from "@/lib/config/dashboard-config";
import type { SeatLedgerConfidence } from "@/lib/licensing/seat-ledger";

export type { LicensePlanKey } from "@/lib/config/dashboard-config";
export type { SeatLedgerConfidence } from "@/lib/licensing/seat-ledger";

// Re-exported so consumers of historical licensing reconciliation can import
// everything they need from a single `@/lib/types/licensing` module, without
// duplicating the underlying config type definitions (source of truth stays
// in `@/lib/config/dashboard-config`).
export type {
  DatedAllowance,
  AicConsumptionMode,
  LicensingHistoryConfig,
  LicensingIdentityConfig,
  LicensingAicConsumptionConfig,
  LicensingValidationConfig,
  ResolvedLicensingHistoryConfig,
  ResolvedLicensingIdentityConfig,
  ResolvedLicensingAicConsumptionConfig,
  ResolvedLicensingValidationConfig,
  ResolvedLicensingConfig,
} from "@/lib/config/dashboard-config";
export { LicensingConfigError } from "@/lib/config/dashboard-config";

/** Derived seat status for a user's license. */
export type SeatStatus = "active" | "pending_cancellation";

/** Activity engagement bucket derived from last_activity_at. */
export type ActivityStatus = "active_30d" | "inactive_30d" | "never";

/** Rule used to derive the assigned AI-credit budget. */
export type AicAssignedRule = "per_user_budget" | "plan_default";

/**
 * One reconciliation row per user (aggregated across the user's seats/orgs).
 * Mirrors the copilot-aic-report per-user rollup, enriched with utilization
 * and total-cost-of-ownership insights.
 */
export interface LicenseReconciliationRow {
  user_login: string;
  /** Distinct orgs where the user holds a seat. */
  orgs: string[];
  org_count: number;
  /** Number of seats held (usually 1 per org). */
  seat_count: number;
  /** Normalized plan (enterprise takes precedence when multi-plan). */
  plan_type: LicensePlanKey;
  /** Earliest seat created_at (YYYY-MM-DD). */
  license_assigned_date: string | null;
  /** Latest seat activity across the user's seats. */
  last_activity_at: string | null;
  activity_status: ActivityStatus;
  /** Assignment source; values are "direct" or "team". */
  assigned_via: string;
  /** active when the user has at least one active (non-pending-cancellation) seat, else inactive. */
  user_status: "active" | "inactive";
  /** pending_cancellation when at least one of the user's seats has a pending cancellation date. */
  seat_status: SeatStatus;
  /** Latest pending_cancellation_date across the user's seats, or null when none. */
  user_revoked_date: string | null;

  // ── Cost / allocation (config-derived) ──────────────────────────────
  /** Negotiated monthly license cost summed across the user's seats (USD). */
  license_cost: number;
  /** Per-org license cost (USD), used for accurate org breakdown. */
  org_license_costs?: Record<string, number>;
  /** Per-org seat counts, used for accurate org breakdown when users hold multiple seats. */
  org_seat_counts?: Record<string, number>;
  /** Monthly AI-credit allowance for the user's plan (credits). */
  default_aic_credits: number;
  /** Allowance value in USD (credits × creditToUsd). */
  default_aic_usd: number;
  /** Assigned AI-credit budget in USD (per-user override or plan default). */
  aic_assigned_usd: number;
  aic_assigned_rule: AicAssignedRule;

  // ── Consumption (from billing_premium_requests) ─────────────────────
  /** AI credits consumed in the reporting window. */
  aic_consumed_credits: number;
  /** AI-credit spend (USD) in the reporting window. */
  aic_consumed_usd: number;
  /** consumed / allowance × 100 (0 when no allowance). */
  utilization_pct: number;
  /** true when consumption exceeds the assigned budget. */
  over_budget: boolean;

  /** license_cost + aic_consumed_usd. */
  total_cost: number;
}

/** Headline KPIs for the reconciliation view. */
export interface LicenseReconciliationKPIs {
  totalUsers: number;
  activeUsers: number;
  pendingCancellation: number;
  inactive30d: number;
  zeroConsumptionSeats: number;
  totalLicenseCost: number;
  totalAllowanceCredits: number;
  totalAssignedUsd: number;
  totalConsumedCredits: number;
  totalConsumedUsd: number;
  overallUtilizationPct: number;
  overBudgetUsers: number;
  totalCostOfOwnership: number;
  currency: string;
  /** Always "live_snapshot_only": this legacy reconciliation is computed live from current `copilot_seats` + billing rows (no historical persistence). See `materialize-license-period.ts`/`license-history-repo.ts` (Task 7) for the materialized-history equivalent, which callers should prefer when available. */
  dataSource: "live_snapshot_only";
}

/** Allocation-vs-consumption breakdown by plan or org. */
export interface LicenseGroupBreakdown {
  key: string;
  seats: number;
  licenseCost: number;
  allowanceCredits: number;
  consumedCredits: number;
  consumedUsd: number;
  utilizationPct: number;
}

/** A single utilization histogram bucket. */
export interface UtilizationBucket {
  label: string;
  min: number;
  max: number;
  count: number;
}

export interface LicenseReconciliationDisabled {
  enabled: false;
}

export interface LicenseReconciliationEnabled {
  enabled: true;
  kpis: LicenseReconciliationKPIs;
  rows: LicenseReconciliationRow[];
  planBreakdown: LicenseGroupBreakdown[];
  orgBreakdown: LicenseGroupBreakdown[];
  utilizationBuckets: UtilizationBucket[];
  config: { currency: string; creditToUsd: number };
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export type LicenseReconciliationResponse =
  | LicenseReconciliationEnabled
  | LicenseReconciliationDisabled;

// ── Materialized license history (Task 7) ──────────────────────────────
//
// Filter shape shared by every `license_period_rows` query in
// `license-history-repo.ts` (detail/rollup query, KPI totals, plan/org
// breakdowns, existence check) so filtering stays consistent across all of
// them. `LicensePeriodQuery` (defined in `license-history-repo.ts`) extends
// this with pagination/sort/view fields specific to the paginated query.

export interface LicensePeriodFilterQuery {
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
  /**
   * Team/org-resolved login allowlist, matched against the same three
   * identity columns as {@link logins} (user_login, resolved_user_login,
   * holder_key). Same fail-closed convention as `LicenseReconciliationFilters.allowedLogins`
   * in `license-repo.ts` (there a `Set<string>`; a readonly array here so it
   * parameterizes directly into a SQL `IN`/`OR` clause) — `undefined` means
   * unrestricted, but an explicitly **empty** array means zero rows match
   * (the caller resolved a team/org scope with no members), never
   * "unrestricted". Combines with {@link logins}/org/enterprise filters via
   * `AND`, so a login must satisfy every provided filter.
   */
  allowedLogins?: readonly string[];
  planTypes?: string[];
  accountStates?: string[];
  seatStatuses?: string[];
  historyConfidence?: SeatLedgerConfidence[];
  /** Free-text search across login/org/external-identity columns. */
  search?: string;
}

/** Headline KPI totals aggregated in SQL over materialized `license_period_rows` matching a filter. */
export interface LicenseHistoryKPIs {
  /** Number of (org, holder, period) rows matched — NOT deduplicated by user (see `totalUsers`). */
  totalRows: number;
  /** Distinct resolved logins (falling back to holder_key when unresolved) across matched rows. */
  totalUsers: number;
  activeSeats: number;
  inactiveSeats: number;
  /** Rows (org/holder/period grain) with zero recorded AI-Credit consumption. */
  zeroConsumptionRows: number;
  totalLicenseCost: number;
  totalAllowanceCredits: number;
  totalAssignedUsd: number;
  totalConsumedCredits: number;
  totalConsumedUsd: number;
  /** consumed / assigned (falling back to default allowance) × 100, safe zero-budget semantics. */
  overallUtilizationPct: number;
  /** Rows whose consumption exceeds their effective (assigned, else default) budget. */
  overBudgetRows: number;
  /** Sum of per-row max(consumed - effective budget, 0) — never negative, never double-counts covered consumption. */
  totalOverageUsd: number;
  /** totalLicenseCost + totalOverageUsd. */
  totalCostOfOwnership: number;
  currency: string;
}

/** Allocation-vs-consumption breakdown by plan or org, aggregated in SQL over materialized `license_period_rows`. */
export interface LicenseHistoryGroupBreakdown {
  key: string;
  rows: number;
  licenseCost: number;
  allowanceCredits: number;
  assignedUsd: number;
  consumedCredits: number;
  consumedUsd: number;
  utilizationPct: number;
  overageUsd: number;
}
