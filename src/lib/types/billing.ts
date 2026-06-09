// TypeScript types for GitHub Enterprise Billing Reports
// Based on: https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage-reports
// and https://docs.github.com/en/enterprise-cloud@latest/billing/reference/billing-reports

// ── Charge Scope ──────────────────────────────────────────────────────

export type ChargeScope = "user" | "org";

/**
 * Derive whether a billing line item is a user-level or org-level charge.
 *
 * User-level: Copilot seats, premium requests — tied to individual users.
 * Org-level:  Actions, Packages, Codespaces, Shared Storage, LFS, GHAS —
 *             infrastructure charges billed to the organization.
 */
export function deriveChargeScope(product: string, _sku: string): ChargeScope {
  const p = product.toLowerCase();
  if (p.includes("copilot")) return "user";
  if (p.includes("premium")) return "user";
  // Actions, Packages, Codespaces, Shared Storage, LFS, GHAS → org
  return "org";
}

// ── Billing Reports API Response ──────────────────────────────────────

export type BillingReportType = "detailed" | "summarized" | "premium_request" | "ai_credit";
export type BillingReportStatus = "pending" | "processing" | "completed" | "failed";

export interface BillingReportExport {
  id: string;
  report_type: BillingReportType;
  start_date: string;
  end_date: string;
  status: BillingReportStatus;
  download_urls?: string[];
  created_at: string;
  actor: string;
}

export interface BillingReportListResponse {
  usage_report_exports: BillingReportExport[];
}

// ── Metered Usage Record (from detailed / summarized reports) ─────────

export interface BillingUsageRecord {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unit_type: string;
  applied_cost_per_quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  organization: string;
  repository: string;
  username: string;        // Only populated in detailed report
  workflow_path: string;   // Only populated in detailed report
  cost_center_name: string;
  charge_scope: ChargeScope;
}

// ── Premium Request Record ────────────────────────────────────────────

export interface BillingPremiumRequestRecord {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unit_type: string;
  applied_cost_per_quantity: number;
  gross_amount: number;
  discount_amount: number;
  net_amount: number;
  username: string;
  organization: string;
  model: string;
  exceeds_quota: string;         // "TRUE" or "FALSE" — may be empty for ai_credit report rows
  total_monthly_quota: number;
  charge_scope: ChargeScope;     // Always "user" for premium requests
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_center_name: string;
  aic_quantity: number;          // AI Credit equivalent quantity
  aic_gross_amount: number;      // AI Credit equivalent gross amount
}

// ── Daily Aggregate (for charts) ──────────────────────────────────────

export interface BillingDailyAggregate {
  day: string;
  product: string;
  charge_scope: ChargeScope;
  total_quantity: number;
  total_gross: number;
  total_discount: number;
  total_net: number;
  record_count: number;
}

// ── Billing Sync State ────────────────────────────────────────────────

export interface BillingSyncState {
  report_type: BillingReportType;
  last_synced_at: string | null;
  last_report_start: string | null;
  last_report_end: string | null;
  status: string;
  error_message: string | null;
}

// ── Overview KPIs ─────────────────────────────────────────────────────

export interface BillingOverviewKPIs {
  totalNet: number;
  totalGross: number;
  totalDiscount: number;
  uniqueProducts: number;
  uniqueOrgs: number;
  userChargesNet: number;
  orgChargesNet: number;
}

// ── Product / Org / User Breakdown ────────────────────────────────────

export interface BillingProductBreakdown {
  product: string;
  charge_scope: ChargeScope;
  total_quantity: number;
  total_gross: number;
  total_discount: number;
  total_net: number;
}

export interface BillingOrgBreakdown {
  organization: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
}

export interface BillingUserBreakdown {
  username: string;
  organization: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
}

// ── Premium Request / AI Credit Summaries ─────────────────────────────

export interface PremiumRequestUserSummary {
  username: string;
  organization: string;
  total_requests: number;
  within_quota: number;
  over_quota: number;
  quota_limit: number;
  utilization_pct: number;
  total_net: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_aic_quantity: number;
  total_aic_gross: number;
}

export interface PremiumRequestModelSummary {
  model: string;
  total_requests: number;
  total_net: number;
  unique_users: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_aic_quantity: number;
  total_aic_gross: number;
}

export interface PremiumUserModelBreakdown {
  model: string;
  ai_credits: number;
  usd: number;
}

// ── Cost Center / Repository / Premium Daily Breakdown ────────────────

export interface BillingCostCenterBreakdown {
  cost_center_name: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
  record_count: number;
}

export interface BillingRepositoryBreakdown {
  repository: string;
  organization: string;
  total_gross: number;
  total_discount: number;
  total_net: number;
}

export interface PremiumDailyTrend {
  day: string;
  total_requests: number;
  total_net: number;
  unique_users: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_aic_quantity: number;
  total_aic_gross: number;
}

// ── CSV Row shapes (raw from downloaded report) ───────────────────────

export interface UsageCSVRow {
  date: string;
  product: string;
  sku: string;
  quantity: string;
  unit_type: string;
  applied_cost_per_quantity: string;
  gross_amount: string;
  discount_amount: string;
  net_amount: string;
  organization?: string;
  repository?: string;
  username?: string;
  workflow_path?: string;
  cost_center_name?: string;
}

export interface PremiumRequestCSVRow {
  date: string;
  product: string;
  sku: string;
  quantity: string;
  unit_type: string;
  applied_cost_per_quantity: string;
  gross_amount: string;
  discount_amount: string;
  net_amount: string;
  username?: string;
  organization?: string;
  model?: string;
  exceeds_quota?: string;
  total_monthly_quota?: string;
  input_tokens?: string;
  output_tokens?: string;
  cached_tokens?: string;
  cost_center_name?: string;
  aic_quantity?: string;
  aic_gross_amount?: string;
}

/** CSV row shape for the ai_credit report type */
export interface AiCreditCSVRow {
  date: string;
  username?: string;
  product: string;
  sku: string;
  model?: string;
  quantity: string;
  unit_type: string;
  applied_cost_per_quantity: string;
  gross_amount: string;
  discount_amount: string;
  net_amount: string;
  total_monthly_quota?: string;
  organization?: string;
  cost_center_name?: string;
  aic_quantity?: string;
  aic_gross_amount?: string;
}
