// Types for the License & AI Credits reconciliation view.
//
// This view reproduces every insight of the standalone copilot-aic-report tool
// (per-user Copilot license + AI-Credit reconciliation) directly in the
// dashboard, joining synced `copilot_seats` (license lifecycle) with
// `billing_premium_requests` (per-user AI-credit consumption) and applying
// configured pricing / allowances.

import type { LicensePlanKey } from "@/lib/config/dashboard-config";

export type { LicensePlanKey } from "@/lib/config/dashboard-config";

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
  /** direct or team:<slug>. */
  assigned_via: string;
  /** active when no seat is pending cancellation. */
  user_status: "active" | "inactive";
  seat_status: SeatStatus;
  /** pending_cancellation_date when set. */
  user_revoked_date: string | null;

  // ── Cost / allocation (config-derived) ──────────────────────────────
  /** Negotiated monthly license cost summed across the user's seats (USD). */
  license_cost: number;
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

export interface LicenseReconciliationResponse {
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
