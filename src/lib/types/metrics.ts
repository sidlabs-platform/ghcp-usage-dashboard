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

export interface AIAdoptionPhase {
  phase: number;       // 0–3
  label: string;       // "No cohort", "Code first", "Agent first", "Multi-agent"
  version: string;     // e.g. "v1"
}

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
  deltas: { dau: number };
}

export interface OverviewData {
  kpis: OverviewKpis;
  dailyTrendValues?: number[];
  activeUsersTrend: { day: string; daily: number; weekly: number; monthly: number }[];
  acceptanceRateTrend: { day: string; suggested: number; accepted: number; rate: number }[];
  chatModes: { ask: number; edit: number; plan: number; agent: number; custom: number; unknown: number };
  featureUsage: { day: string; completions: number; chat: number; agent: number; cli: number }[];
  cliVsIde: { day: string; ideUsers: number; cliUsers: number }[];
  dataAsOf: string;
  daysLoaded: number;
  filtered?: boolean;
}

// ── Copilot App analytics ─────────────────────────────────────────────

/** Period-level Copilot App KPI summary. */
export interface CopilotAppKpis {
  periodActiveUsers: number;
  appActiveUsers: number;
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

/** Which underlying data source served a Copilot App analytics response. */
export type CopilotAppDataSource = "users" | "enterprise" | "organization" | "none";

/** Feature capabilities available for the resolved Copilot App data source. */
export interface CopilotAppCapabilities {
  adopters: boolean;
  scopedFiltering: boolean;
  modelBreakdown: boolean;
  languageBreakdown: boolean;
}

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

export interface CopilotAppAdoptersResponse {
  adopters: CopilotAppAdopter[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** One day of Copilot App activity from an enterprise/org aggregate fallback. */
export interface CopilotAppAggregateDay {
  day: string;
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
