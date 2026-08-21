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
  repository: string;            // Present in the AI usage report; disambiguates same-day/model rows
  model: string;
  exceeds_quota: string;         // "TRUE" or "FALSE" — may be empty for ai_credit report rows
  total_monthly_quota: number;
  charge_scope: ChargeScope;     // Always "user" for premium requests
  input_tokens: number;          // AI usage report `input` column
  output_tokens: number;         // AI usage report `output` column
  cached_tokens: number;         // Legacy alias, mirrors cache_read_tokens
  cache_read_tokens: number;     // AI usage report `cache_read` column
  cache_write_tokens: number;    // AI usage report `cache_write` column
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
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
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
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
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

/**
 * AI Credit consumption grouped by cost center, sourced from the
 * `billing_premium_requests` table (premium_request + ai_credit superset).
 *
 * `cost_center_name` is an empty string for AI-credit usage not attributed to a
 * cost center — the UI surfaces these as an explicit "Unattributed" bucket
 * rather than dropping them.
 */
export interface PremiumCostCenterBreakdown {
  cost_center_name: string;
  total_aic_quantity: number;
  total_aic_gross: number;
  unique_users: number;
  record_count: number;
}

/**
 * AI Credit consumption grouped by organization, sourced from the
 * `billing_premium_requests` table.
 *
 * `organization` is an empty string for org-less AI-credit usage (e.g. usage
 * not linked to an organization, which the 2026-07-02 metrics accuracy update
 * now attributes). The UI surfaces these as an explicit "No organization /
 * unattributed" bucket rather than dropping them from org-grouped views.
 */
export interface PremiumOrgBreakdown {
  organization: string;
  total_aic_quantity: number;
  total_aic_gross: number;
  unique_users: number;
  record_count: number;
}

export interface PremiumDailyTrend {
  day: string;
  total_requests: number;
  total_net: number;
  unique_users: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_aic_quantity: number;
  total_aic_gross: number;
}

// ── Copilot Cost Basis ─────────────────────────────────────────────────

/**
 * Canonical Copilot cost + AI-credit figures for a window.
 *
 * Both the Billing and License & AI Credits surfaces render from this shape, so
 * the two pages cannot drift when the repository calculation changes.
 */
export interface CopilotCostBasis {
  /** Inclusive bounds these figures were computed over. */
  startDate: string;
  endDate: string;
  /** Calendar period when the bounds are exactly one month, else null. */
  period: string | null;

  /** Copilot seat licences — net, gross, and billed seat-months. */
  seatCostNet: number;
  seatCostGross: number;
  /**
   * Billed seat-**months**, a duration, not a seat count: one seat held for a
   * whole month is 1.0, and for 11 days is ~0.35. Never compare it directly to
   * a headcount — use {@link seatUsers} / {@link seatAssignments} for that.
   */
  seatQuantity: number;
  /** Distinct users billed for a Copilot seat in this window. The period-accurate licensed-user count. */
  seatUsers: number;
  /** Distinct (user, org) seat assignments billed in this window — a multi-org user holds several. */
  seatAssignments: number;
  /** Days in the window whose seat rows carry a username (GitHub omits it on older/aggregate rows). */
  seatNamedDays: number;
  /** Days in the window with any seat row at all. Compare against {@link seatNamedDays} to judge coverage. */
  seatDays: number;
  /**
   * True when, on the days GitHub named users, those named rows account for
   * essentially all of that day's billed seats — i.e. {@link seatUsers} is a
   * complete census rather than a subset of orgs. When false, treat
   * {@link seatUsers} as a lower bound and do not headline it.
   */
  seatPopulationComplete: boolean;

  /**
   * AI credits billed in range, from the detailed usage report. This is the
   * authoritative total; it covers the full synced history.
   *
   * Counts `unit_type = 'ai-credits'` rows only. Premium requests and token
   * units are billed under different units and are reported separately —
   * summing them would produce a figure that reproduces no GitHub report.
   */
  creditsBilled: number;
  /** Premium requests billed in range (`unit_type = 'requests'`), the pre-June-2026 consumption unit. */
  requestsBilled: number;
  /** Premium requests in the per-user report that carry a username. */
  requestsAttributed: number;
  /** Token units billed in range (`unit_type = 'token-units'`). */
  tokenUnitsBilled: number;
  /** Net USD charged for all consumption units (zero while within the pooled allowance). */
  creditCostNet: number;
  creditCostGross: number;

  /**
   * Credits that can be attributed to a named user, from the ai_credit report.
   * Always <= creditsBilled; frequently far lower for historical months.
   *
   * Counts only rows carrying a username. Rows in the per-user report with no
   * username (org- or enterprise-scoped charges) are billed but not
   * attributable, and are reported separately as {@link creditsUnattributed} —
   * folding them in here would claim an attribution that no per-user table can
   * reproduce.
   */
  creditsAttributed: number;
  /** Credits present in the per-user report but carrying no username, so attributable to no one. */
  creditsUnattributed: number;
  /** Distinct users carrying attributed credits (`ai-credits` rows only, matching {@link creditsAttributed}). */
  attributedUsers: number;
  /** creditsAttributed / creditsBilled, 0-100. Null when nothing was billed. */
  attributionCoveragePct: number | null;
  /**
   * True when per-user attribution accounts for essentially all billed
   * credits. When false, per-user credit tables are a sample, not a census,
   * and must be labelled as such.
   */
  attributionComplete: boolean;

  /** Total Copilot cost: seats + credits. */
  totalCopilotNet: number;
}

// ── Period-scoped Copilot billing breakdown ───────────────────────────
//
// Everything below describes the *selected window only*, read from the billed
// rows in `billing_usage_records`. Nothing here reads `copilot_seats` (a
// snapshot table with no date column, so it can only ever describe today) or
// `dashboard-config.json` list prices (operator-entered, and identical in
// every period). That distinction is the entire point: figures on a page
// filtered to a month must be reproducible from that month's GitHub billing
// report and no other source.
//
// Quantities are only ever summed within one `unit_type`. Amounts
// (gross/discount/net) are USD and are safe to sum across unit types.

/** A seat licence SKU billed in the window (`unit_type = 'user-months'`). */
export interface SeatSkuBreakdown {
  /** Raw SKU string from the billing report — never normalized away. */
  sku: string;
  /** Display label from `skuLabel()`. Cosmetic; no figure depends on it. */
  label: string;
  /**
   * Billed seat-**months**, a duration rather than a headcount: a seat held
   * for a whole month is 1.0, and for 11 days ~0.35.
   */
  seatMonths: number;
  /**
   * Distinct users billed for this SKU in the window. Zero when GitHub
   * reported the SKU only as org-level aggregate rows carrying no username.
   */
  users: number;
  grossCost: number;
  netCost: number;
}

/**
 * A consumption SKU billed in the window, in one unit type.
 *
 * `unit` names the unit `quantity` is counted in, so a caller can never add a
 * credit count to a request count. `poolQuantity`/`additionalQuantity` are
 * only meaningful for `ai-credits`.
 */
export interface ConsumptionSkuBreakdown {
  sku: string;
  label: string;
  /** The `unit_type` these quantities are counted in. */
  unit: string;
  quantity: number;
  /** Portion of `quantity` covered by the included entitlement pool (derived). */
  poolQuantity: number;
  /** Portion of `quantity` charged beyond the entitlement pool (derived). */
  additionalQuantity: number;
  grossCost: number;
  discountAmount: number;
  netCost: number;
}

/** Billed Copilot cost and consumption for one organization in the window. */
export interface BilledOrgBreakdown {
  organization: string;
  seatMonths: number;
  seatUsers: number;
  seatCostNet: number;
  credits: number;
  consumptionCostNet: number;
  totalNet: number;
}

/** Net Copilot cost for a single day in the window. */
export interface BilledDailyCost {
  day: string;
  seatCostNet: number;
  consumptionCostNet: number;
  totalNet: number;
}

/**
 * Period-scoped Copilot billing breakdown for the License & AI Credits page.
 *
 * Computed over the same window and scope as {@link CopilotCostBasis}, from
 * the same table, so the two agree by construction: summing `seatSkus[].netCost`
 * yields `CopilotCostBasis.seatCostNet`, and summing
 * `consumptionSkus[].netCost` yields `CopilotCostBasis.creditCostNet`.
 */
export interface CopilotBillingBreakdown {
  /** Inclusive bounds these figures were computed over. */
  startDate: string;
  endDate: string;
  /** Calendar period when the bounds are exactly one month, else null. */
  period: string | null;

  seatSkus: SeatSkuBreakdown[];
  consumptionSkus: ConsumptionSkuBreakdown[];
  orgs: BilledOrgBreakdown[];
  daily: BilledDailyCost[];

  /**
   * AI credits covered by the included entitlement pool, across all SKUs.
   *
   * Derived from `discount_amount / gross_amount`, not reported by GitHub —
   * the AI-credit report carries no `exceeds_quota` column. Label it as
   * derived wherever it is displayed.
   */
  poolCredits: number;
  /** AI credits charged beyond the entitlement pool (derived, same caveat). */
  additionalCredits: number;
  /** Net USD charged for credits beyond the pool. */
  additionalCreditCostNet: number;

  /**
   * True when the window billed no Copilot rows at all, so the page can show
   * an explicit empty state rather than a wall of confident zeroes.
   */
  hasBilledData: boolean;
}

// ── Token Usage Analytics ─────────────────────────────────────────────
// Backed by the per-model token breakdown added to the AI usage report on
// 2026-08-11. All figures come from `billing_premium_requests`.
//
// "Pool" vs "additional" credits are derived from billing amounts, since the
// ai_credit report no longer emits `exceeds_quota`:
//   - `discount_amount` is usage covered by the account's included allowance
//   - `net_amount` is the billable remainder
// Credits are apportioned by the discount/gross ratio. See
// `POOL_FRACTION_SQL` in `src/lib/db/billing-repo.ts` for the canonical
// expression.

/** The four token classes reported per model. */
export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** input + output + cache_read + cache_write */
  total_tokens: number;
}

export interface TokenKpis extends TokenTotals {
  total_credits: number;
  pool_credits: number;
  paid_credits: number;
  total_gross_usd: number;
  pool_usd: number;
  paid_usd: number;
  unique_users: number;
  unique_models: number;
  record_count: number;
}

export interface TokenModelSummary extends TokenTotals {
  model: string;
  total_credits: number;
  pool_credits: number;
  paid_credits: number;
  total_gross_usd: number;
  pool_usd: number;
  paid_usd: number;
  unique_users: number;
  record_count: number;
  /** Credits consumed per 1,000,000 tokens. 0 when no tokens are reported. */
  credits_per_mtok: number;
  /** Gross USD per 1,000,000 tokens. 0 when no tokens are reported. */
  usd_per_mtok: number;
  /** output / input. 0 when no input tokens are reported. */
  output_input_ratio: number;
  /** cache_read / (input + cache_read), as a percentage. */
  cache_hit_rate: number;
}

export interface TokenDailyTrendPoint extends TokenTotals {
  day: string;
  total_credits: number;
  pool_credits: number;
  paid_credits: number;
  total_gross_usd: number;
  unique_users: number;
}

export interface TokenUserSummary extends TokenTotals {
  username: string;
  organization: string;
  total_credits: number;
  pool_credits: number;
  paid_credits: number;
  total_gross_usd: number;
  pool_usd: number;
  paid_usd: number;
  unique_models: number;
  credits_per_mtok: number;
  cache_hit_rate: number;
}

/** A generic token/cost rollup keyed by an attribution dimension. */
export interface TokenAttributionRow extends TokenTotals {
  /** Organization, cost center or repository name. Empty string ⇒ unattributed. */
  key: string;
  total_credits: number;
  pool_credits: number;
  paid_credits: number;
  total_gross_usd: number;
  unique_users: number;
  record_count: number;
}

export interface TokenAttribution {
  byOrganization: TokenAttributionRow[];
  byCostCenter: TokenAttributionRow[];
  byRepository: TokenAttributionRow[];
}

/** One model/day observation used for correlation and anomaly analysis. */
export interface TokenModelDailyPoint extends TokenTotals {
  day: string;
  model: string;
  total_credits: number;
  total_gross_usd: number;
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
  repository?: string;
  model?: string;
  exceeds_quota?: string;
  total_monthly_quota?: string;
  /** Current AI usage report column names (2026-08-11 changelog). */
  input?: string;
  output?: string;
  cache_read?: string;
  cache_write?: string;
  /** Legacy column names retained for older reports. */
  input_tokens?: string;
  output_tokens?: string;
  cached_tokens?: string;
  cost_center_name?: string;
  aic_quantity?: string;
  aic_gross_amount?: string;
}

/**
 * CSV row shape for the ai_credit report type (the "AI usage report").
 *
 * Verified against a live `octodemo` export (2026-08-19), whose header is:
 * `date, username, product, sku, model, quantity, unit_type,
 *  applied_cost_per_quantity, gross_amount, discount_amount, net_amount,
 *  total_monthly_quota, organization, repository, cost_center_name,
 *  aic_quantity, aic_gross_amount, input, output, cache_read, cache_write`
 *
 * Note there is no `exceeds_quota` column in this report.
 */
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
  repository?: string;
  cost_center_name?: string;
  aic_quantity?: string;
  aic_gross_amount?: string;
  /** Per-model token breakdown (2026-08-11 changelog). */
  input?: string;
  output?: string;
  cache_read?: string;
  cache_write?: string;
  /** Legacy aliases, tolerated if an older export is replayed. */
  input_tokens?: string;
  output_tokens?: string;
  cached_tokens?: string;
}
