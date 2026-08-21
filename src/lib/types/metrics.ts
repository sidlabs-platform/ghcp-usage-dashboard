// Complete TypeScript types for GitHub Copilot Usage Metrics API (NDJSON schema)
// Based on: https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics

// ── Sub-object types ──────────────────────────────────────────────────

export interface TotalsByIDE {
  ide: string;
  code_acceptance_activity_count: number;
  code_generation_activity_count: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  user_initiated_interaction_count: number;
  last_known_ide_version?: {
    ide_version: string;
    sampled_at: string;
  };
  last_known_plugin_version?: {
    plugin: string;
    plugin_version: string;
    sampled_at: string;
  };
}

export interface TotalsByFeature {
  feature: string; // "code_completion", "inline_chat", "chat_panel", etc.
  code_acceptance_activity_count: number;
  code_generation_activity_count: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  user_initiated_interaction_count: number;
}

export interface TotalsByLanguageFeature {
  language: string;
  feature: string;
  code_acceptance_activity_count: number;
  code_generation_activity_count: number;
  loc_added_sum: number;
  loc_deleted_sum: number;
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
}

export interface TotalsByModelFeature {
  model: string;
  feature: string;
  user_initiated_interaction_count: number;
}

export interface TotalsByLanguageModel {
  language: string;
  model: string;
  user_initiated_interaction_count: number;
}

export interface CLITokenUsage {
  output_tokens_sum: number;
  prompt_tokens_sum: number;
  avg_tokens_per_request: number;
}

export interface TotalsByCLI {
  session_count: number;
  request_count: number;
  prompt_count: number;
  token_usage: CLITokenUsage;
  last_known_cli_version?: {
    cli_version: string;
    sampled_at: string;
  };
}

export interface CopilotAppTokenUsage {
  output_tokens_sum: number;
  prompt_tokens_sum: number;
  avg_tokens_per_request: number | null;
}

export interface TotalsByCopilotApp {
  session_count: number;
  request_count: number;
  prompt_count: number;
  token_usage: CopilotAppTokenUsage;
}

export interface PullRequestMetrics {
  total_created: number;
  total_reviewed: number;
  total_merged: number;
  median_minutes_to_merge: number | null;
  total_suggestions: number;
  total_applied_suggestions: number;
  total_created_by_copilot: number;
  total_reviewed_by_copilot: number;
  total_merged_created_by_copilot: number;
  median_minutes_to_merge_copilot_authored: number | null;
  total_merged_reviewed_by_copilot: number;
  median_minutes_to_merge_copilot_reviewed: number | null;
  total_copilot_suggestions: number;
  total_copilot_applied_suggestions: number;
}

export interface AgentEdit {
  loc_added_sum?: number;
  loc_deleted_sum?: number;
}

/**
 * A user's AI adoption phase, exactly as stored.
 *
 * Two shapes exist in the wild: the current API sends
 * `{ phase_number: 3, phase: "Phase 3", version: "v1" }`, while earlier data
 * used `{ phase: 3, label: "Multi-agent", version: "v1" }` — so `phase` is a
 * number in one and a display string in the other. Never read `phase` as a
 * numeric key; resolve it with `resolvePhaseNumber` from
 * `@/lib/metrics/adoption-phase`.
 */
export interface AIAdoptionPhase {
  /** Numeric phase 0–3. Present in current data; absent in legacy data. */
  phase_number?: number;
  /** Number in legacy data, display string ("Phase 3", "No Cohort") in current data. */
  phase: number | string;
  /** Legacy display name only — the current API does not send this. */
  label?: string;
  version: string;
}

/**
 * One adoption-phase cohort, **after normalization**.
 *
 * This is the canonical internal shape, not the wire format. Stored JSON uses
 * different field names depending on when it was synced (`total_engaged_users`
 * vs `engaged_users`, `avg_loc_added` vs `loc_added_avg`, …); use
 * `parsePhaseTotals` from `@/lib/metrics/adoption-phase` to read the column, and
 * never destructure the raw JSON directly.
 */
export interface TotalsByAIAdoptionPhase {
  phase: number;
  label: string;
  version: string;
  engaged_users: number;
  user_initiated_interaction_avg: number;
  code_generation_activity_avg: number;
  code_acceptance_activity_avg: number;
  loc_added_avg: number;
  loc_deleted_avg: number;
  pull_requests_created_avg: number;
  pull_requests_merged_avg: number;
  pull_requests_reviewed_avg: number;
  median_minutes_to_merge_avg: number | null;
  /**
   * Absolute number of pull requests merged by users in this phase for the
   * period. Added by the GitHub Copilot usage metrics API in June 2026
   * (enterprise/org reports only). Optional for backward compatibility —
   * data synced before this field was available will not include it.
   */
  total_pull_requests_merged?: number;
}

// ── Potential Return on Investment ────────────────────────────────────

/**
 * Average number of days in a month, used to normalize window totals to a
 * monthly figure. 365.25 / 12 = 30.4375.
 */
export const DAYS_PER_MONTH = 30.44;

/**
 * Length of the rolling window that the GitHub Copilot usage metrics API uses
 * for `totals_by_ai_adoption_phase`. Each enterprise/org day row carries the
 * aggregate for the preceding 28 days, so merged-PR totals must be normalized
 * against this constant rather than the caller's requested range.
 */
export const ENTERPRISE_ROLLING_WINDOW_DAYS = 28;

/**
 * Which underlying data set produced the ROI cost figures.
 * - `billing`: actual billed USD from `billing_premium_requests.aic_gross_amount`
 * - `credits`: estimated from `user_daily_metrics.ai_credits_used` × `creditToUsd`
 * - `none`: neither source had data for the requested range/scope
 */
export type RoiCostSource = "billing" | "credits" | "none";

/** Identifier for the two adoption groups compared in the ROI section. */
export type RoiGroupKey = "early" | "agent";

/**
 * One side of the ROI comparison — either the early-phase group (passive users
 * and Phase 1) or the agent-first group (Phase 2 and Phase 3).
 */
export interface RoiGroup {
  key: RoiGroupKey;
  label: string;
  /** Adoption phases folded into this group. */
  phases: number[];
  /** Distinct users assigned to these phases anywhere in the window. */
  developers: number;
  /**
   * Total Copilot cost attributed to these users across the window — seat
   * subscription plus consumption. Seat cost dominates in practice; reporting
   * consumption alone understated cost per developer by ~70x.
   */
  totalCostUsd: number;
  /** Consumption-only portion of `totalCostUsd` (AI credits / premium requests). */
  usageCostUsd: number;
  /** Seat-subscription portion of `totalCostUsd`. Zero when no seat charges are synced. */
  seatCostUsd: number;
  /** `totalCostUsd` per developer, normalized to a month. */
  costPerDevPerMonth: number;
  /** Absolute pull requests merged by this group (28-day rolling snapshot). */
  prsMerged: number;
  /** `prsMerged` per developer, normalized to a month. */
  prsMergedPerDevPerMonth: number;
}

/** Response payload for `/api/metrics/roi`. */
export interface RoiResponse {
  hasData: boolean;
  /** True when merged-PR totals were available for at least one group. */
  hasPrData: boolean;
  costSource: RoiCostSource;
  /** ISO currency code the cost figures are expressed in. */
  currency: string;
  /** USD value of one AI credit used for the `credits` cost path. */
  creditToUsd: number;
  /**
   * Average billed USD per Copilot seat per month over the window, applied
   * uniformly per developer. 0 when no `user-months` charges are synced, in
   * which case the cost figures cover consumption only and should say so.
   */
  seatCostPerUserMonth: number;
  groups: RoiGroup[];
  windowDays: number;
  dataAsOf: string;
  daysLoaded: number;
  filtered: boolean;
}

// ── Enterprise/Org aggregate (day_totals) ─────────────────────────────

export interface DayTotal {
  day: string;
  enterprise_id: string;
  organization_id?: string;

  // Active users
  daily_active_users: number;
  weekly_active_users: number;
  monthly_active_users: number;
  monthly_active_agent_users: number;
  monthly_active_chat_users: number;
  daily_active_cli_users?: number;
  daily_active_copilot_app_users?: number | null;

  // Code activity
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  user_initiated_interaction_count: number;

  // Lines of code
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;

  // Breakdowns
  totals_by_ide: TotalsByIDE[];
  totals_by_feature: TotalsByFeature[];
  totals_by_language_feature: TotalsByLanguageFeature[];
  totals_by_model_feature: TotalsByModelFeature[];
  totals_by_language_model: TotalsByLanguageModel[];
  totals_by_cli?: TotalsByCLI;
  totals_by_copilot_app?: TotalsByCopilotApp | null;

  // AI adoption cohorts
  totals_by_ai_adoption_phase?: TotalsByAIAdoptionPhase[];

  // Pull requests
  pull_requests?: PullRequestMetrics;
}

export interface EnterpriseReport {
  enterprise_id: string;
  report_start_day: string;
  report_end_day: string;
  day_totals: DayTotal[];
  etl_id?: string;
  day_partition?: string;
  entity_id_partition?: number;
}

export interface OrgReport {
  organization_id: string;
  report_start_day: string;
  report_end_day: string;
  day_totals: DayTotal[];
  etl_id?: string;
}

// ── User-level record ─────────────────────────────────────────────────

export interface UserDayRecord {
  day: string;
  enterprise_id: string;
  organization_id?: string;
  user_id: number;
  user_login: string;

  // Code activity
  code_generation_activity_count: number;
  code_acceptance_activity_count: number;
  user_initiated_interaction_count: number;

  // Lines of code
  loc_suggested_to_add_sum: number;
  loc_suggested_to_delete_sum: number;
  loc_added_sum: number;
  loc_deleted_sum: number;

  // AI Credits consumed by this user-day, from the Usage Metrics API.
  ai_credits_used?: number;

  // Chat mode breakdown
  chat_panel_agent_mode?: number;
  chat_panel_ask_mode?: number;
  chat_panel_custom_mode?: number;
  chat_panel_edit_mode?: number;
  chat_panel_plan_mode?: number;
  chat_panel_unknown_mode?: number;

  // Feature flags
  used_agent: boolean;
  used_chat: boolean;
  used_cli: boolean;
  used_copilot_code_review_active?: boolean;
  used_copilot_code_review_passive?: boolean;
  used_copilot_coding_agent?: boolean;
  used_copilot_app?: boolean | null;

  // Breakdowns
  totals_by_ide: TotalsByIDE[];
  totals_by_feature: TotalsByFeature[];
  totals_by_language_feature: TotalsByLanguageFeature[];
  totals_by_model_feature: TotalsByModelFeature[];
  totals_by_language_model: TotalsByLanguageModel[];
  totals_by_cli?: TotalsByCLI;
  totals_by_copilot_app?: TotalsByCopilotApp;

  // Agent edit
  agent_edit?: AgentEdit;

  // AI adoption cohort
  ai_adoption_phase?: AIAdoptionPhase;

  // Internal fields
  etl_id?: string;
  day_partition?: string;
  entity_id_partition?: number;
}

/** Row from the user-teams-1-day NDJSON report */
export interface UserTeamRecord {
  day: string;
  enterprise_id?: string;
  organization_id?: string;
  team_slug: string;
  team_name?: string;
  user_id: number;
  user_login: string;
}

// ── API response types ────────────────────────────────────────────────

export interface ReportResponse {
  download_links: string[];
  report_day?: string;
  report_start_day?: string;
  report_end_day?: string;
}

// ── Overview page response ────────────────────────────────────────────

export interface OverviewKpis {
  dailyActiveUsers: number;
  weeklyActiveUsers: number;
  monthlyActiveUsers: number;
  agentAdoption: number;
  codingAgentAdoption: number;
  codeReviewAdoption: number;
  cliUsers: number;
  licenseUtilization: number;
  periodActiveUsers: number;
  // Latest-day Copilot App active-user count (from the featureUsage series'
  // last entry). An overlapping active-surface signal — not additive with
  // the other adoption KPIs above (see OverviewData.featureUsage.app).
  copilotAppUsers: number;
  deltas: { dau: number };
  // ── Added in #100 ──────────────────────────────────────────────────────────
  /** Period-level completion acceptance rate (accept events / generation events × 100). */
  completionAcceptanceRate: number;
  /** Seats with no activity in the last 30 days (seatStats.inactive30d). */
  inactiveSeats: number;
  /** Total provisioned seats; 0 when seat data is unavailable or filter is active. */
  totalSeats: number;
  /**
   * Monthly-normalised net cost in USD (totalNet × 30 / days).
   * `null` when no billing data has been synced.
   */
  monthlyNetCost: number | null;
  /**
   * Total AI credits consumed from usage-API data (`ai_credits_used` column).
   * `null` when the field is all-zero (no data yet).
   */
  aiCreditsConsumed: number | null;
  /** False when billing tables are empty; drives graceful "—" display in the UI. */
  billingAvailable: boolean;
  /**
   * How the active/inactive seat split was derived.
   *
   * - `"last_activity"` — from the live `copilot_seats` snapshot's
   *   `last_activity_at`. Only meaningful for a window that ends today.
   * - `"usage"` — from recorded usage inside the selected window. Used for
   *   historical windows, because the snapshot stores only each seat's
   *   latest-ever activity and therefore cannot answer "was this seat active
   *   in June?".
   *
   * `null` when a scope filter is active, since seat data is enterprise-wide
   * and is not reported for a filtered view.
   */
  seatActivityBasis: "last_activity" | "usage" | null;
  /** True when the seat snapshot describes the selected window (i.e. it ends today). */
  seatSnapshotIsLive: boolean;
  /** LoC accepted from IDE completion features only (excludes agent and CLI). */
  completionLocAccepted: number;
  /** LoC suggested by IDE completion features only. */
  completionLocSuggested: number;
  /** LoC written directly to files by agent features; never "accepted". */
  agentLocAdded: number;
  /** LoC added via the Copilot CLI, reported separately from IDE completions. */
  cliLocAdded: number;
  /**
   * Users with usage in the window who hold no seat in the current snapshot.
   * Explains why the active-user count can exceed the seat count.
   */
  activeUsersWithoutSeat: number;
}

export interface OverviewData {
  kpis: OverviewKpis;
  /**
   * Sparkline series, one per KPI that has a daily basis. Each card must be
   * given its own series — `periodActiveUsers` is a distinct count over the
   * whole window rather than a daily series, so it has none.
   */
  dailyTrendValues?: number[];
  weeklyTrendValues?: number[];
  monthlyTrendValues?: number[];
  activeUsersTrend: { day: string; daily: number; weekly: number; monthly: number }[];
  acceptanceRateTrend: { day: string; suggested: number; accepted: number; rate: number }[];
  chatModes: { ask: number; edit: number; plan: number; agent: number; custom: number; unknown: number };
  // `app` is an overlapping active-surface count (Copilot App usage), not
  // an exclusive/additive slice of completions/chat/agent/cli — a user can
  // be counted in `app` and in any of the other fields for the same day.
  featureUsage: { day: string; completions: number; chat: number; agent: number; cli: number; app: number }[];
  cliVsIde: { day: string; ideUsers: number; cliUsers: number }[];
  dataAsOf: string;
  daysLoaded: number;
  /**
   * Whether the selected window is actually backed by synced usage data.
   * Absent on responses produced before this field existed.
   */
  coverage?: {
    earliest: string | null;
    latest: string | null;
    daysCovered: number;
    daysRequested: number;
    isEmpty: boolean;
    isPartial: boolean;
  };
  filtered?: boolean;
}

// ── Copilot App analytics ─────────────────────────────────────────────

/** Period-level Copilot App KPI summary. */
export interface CopilotAppKpis {
  /**
   * Dual semantics depending on `dataSource` (see {@link CopilotAppDataSource}):
   * - `"users"`: distinct **period-active users** in the scope — one row per
   *   user in `user_daily_metrics`, so this is a true user headcount.
   * - `"enterprise"` / `"organization"` (aggregate fallback): the enterprise/org
   *   daily-metrics tables have no per-user rows, only one row per day, so
   *   this field is the **sum of each day's `sourceActiveUsers`** across the
   *   period — i.e. active **user-days**, not distinct users. A user active
   *   on every day of a 28-day window is counted 28 times. Callers/UI must
   *   label this accordingly (e.g. "Active User-Days") instead of implying a
   *   distinct-user count for aggregate sources.
   */
  periodActiveUsers: number;
  /**
   * Same dual semantics as {@link CopilotAppKpis.periodActiveUsers}: distinct
   * App-active users for `dataSource: "users"`, but a sum-of-daily-counts
   * (active App user-days) for the `"enterprise"`/`"organization"` aggregate
   * fallback.
   */
  appActiveUsers: number;
  /**
   * `appActiveUsers / periodActiveUsers * 100`. For `dataSource: "users"`
   * this is the App-active distinct user count divided by *all*
   * period-active scoped users (not just users with App telemetry support),
   * per the approved product definition for user-level adoption rate. This
   * is intentionally a different denominator than the enterprise/org
   * aggregate fallback's `sourceActiveUsers` (see
   * {@link CopilotAppAggregateDay.sourceActiveUsers}): at user level every
   * scoped user's `user_daily_metrics` row is known and countable, so the
   * full scoped population is the correct denominator. At aggregate level,
   * only rows with explicit App support evidence can be safely summed into
   * the denominator — see {@link CopilotAppAggregateDay.sourceActiveUsers}
   * for why. Do not "align" these two denominators; they measure different
   * things by design.
   *
   * For aggregate sources, both numerator and denominator are sums of daily
   * counts (user-days), so this ratio remains a meaningful *weighted*
   * adoption share across the period even though neither input is a
   * distinct-user count — it should be labeled "share of active user-days",
   * not "share of active users".
   */
  adoptionRate: number;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  avgTokensPerRequest: number;
  codeGenerations: number;
  codeAcceptances: number;
  locAdded: number;
  locDeleted: number;
  locChanged: number;
}

/** One day of Copilot App adoption/usage trend. */
export interface CopilotAppAdoptionTrendPoint {
  day: string;
  activeUsers: number;
  sessions: number;
  requests: number;
  prompts: number;
}

/** One day of Copilot App code-impact trend. */
export interface CopilotAppCodeImpactPoint {
  day: string;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
}

/** A single model/language breakdown row for Copilot App usage. */
export interface CopilotAppBreakdown {
  name: string;
  interactions: number;
  locAdded?: number;
  locDeleted?: number;
}

/** A per-user Copilot App adopter row. */
export interface CopilotAppAdopter {
  login: string;
  activeDays: number;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  locAdded: number;
  locDeleted: number;
}

/** Which underlying data source served a Copilot App analytics response.
 * `"users"` is the precise per-user-row source (see
 * {@link CopilotAppKpis.adoptionRate}); `"enterprise"`/`"organization"` are
 * the aggregate fallback used when user-row data isn't available/permitted,
 * with the coarser `sourceActiveUsers` denominator (see
 * {@link CopilotAppAggregateDay.sourceActiveUsers}); `"none"` means no
 * Copilot App data was found for the scope. The UI must read this field
 * (together with {@link CopilotAppCapabilities}) to identify when it is
 * displaying aggregate-fallback data rather than silently presenting it as
 * equivalent to user-level data. */
export type CopilotAppDataSource = "users" | "enterprise" | "organization" | "none";

/** Feature capabilities available for the resolved Copilot App data source.
 * The aggregate fallback (`dataSource: "enterprise" | "organization"`)
 * cannot support per-user views, so `adopters` is always `false` in that
 * case; API/UI callers must check this rather than assuming every
 * `CopilotAppDataSource` supports the full user-level feature set. */
export interface CopilotAppCapabilities {
  adopters: boolean;
  scopedFiltering: boolean;
  modelBreakdown: boolean;
  languageBreakdown: boolean;
}

/** Top-level Copilot App analytics response. `dataSource` and
 * `capabilities` together let the UI distinguish a precise user-level
 * response from an enterprise/organization aggregate fallback (see
 * {@link CopilotAppDataSource} and {@link CopilotAppKpis.adoptionRate}) —
 * the two sources use intentionally different adoption-rate denominators
 * and must never be presented as interchangeable without that context. */
export interface CopilotAppAnalyticsResponse {
  hasCopilotAppData: boolean;
  dataSource: CopilotAppDataSource;
  capabilities: CopilotAppCapabilities;
  kpis: CopilotAppKpis;
  adoptionTrend: CopilotAppAdoptionTrendPoint[];
  codeImpactTrend: CopilotAppCodeImpactPoint[];
  modelBreakdown: CopilotAppBreakdown[];
  languageBreakdown: CopilotAppBreakdown[];
}

/** Paginated Copilot App adopter roster response. Nests pagination metadata
 * under `pagination` (rather than flattening `page`/`pageSize`/... at the top
 * level) to match every other paginated API route in this codebase (e.g.
 * `/api/teams`, `/api/billing/ai-credits/users`). */
export interface CopilotAppAdoptersResponse {
  adopters: CopilotAppAdopter[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

/** One day of Copilot App activity from an enterprise/org aggregate
 * fallback (used when precise per-user data isn't available/permitted —
 * see {@link CopilotAppDataSource}). */
export interface CopilotAppAggregateDay {
  day: string;
  /**
   * Sum of `daily_active_users` restricted to rows carrying explicit
   * Copilot App support evidence for that day (see
   * {@link CopilotAppKpis.adoptionRate} for the contrast with the
   * user-level denominator). This deliberately excludes rows from
   * enterprises/orgs with no App tracking at all, so a partial App rollout
   * across a multi-enterprise/org scope doesn't dilute the adoption-rate
   * denominator with users who could never have used the App. Because of
   * this restriction, `sourceActiveUsers` is *not* directly comparable to
   * `periodActiveUsers` in {@link CopilotAppKpis} — it is scoped to
   * App-supported rows only, not the full active-user population.
   */
  sourceActiveUsers: number;
  activeUsers: number;
  sessions: number;
  requests: number;
  prompts: number;
  promptTokens: number;
  outputTokens: number;
  generations: number;
  acceptances: number;
  locAdded: number;
  locDeleted: number;
  isSupported: boolean;
}
