// Helper to separate code completion metrics from agent/edit, CLI and Copilot
// App metrics.
//
// Per GitHub docs: LoC "acceptance" applies ONLY to code completions —
// agent_edit writes code directly (loc_added_sum) without ever showing a
// suggestion, and reports code_acceptance_activity_count as a hard 0.
//
// copilot_app (the standalone Copilot mobile/web app surface) and copilot_cli
// are each distinct surfaces that must not be classified as completion features
// either — their code activity is reported separately so it can never dilute or
// inflate completion LoC totals.
//
// The CLI is nonetheless included in the *acceptance rate* (see
// isAcceptanceEligibleFeature): unlike agent_edit it reports real generation and
// acceptance counts, so dropping it discards genuine accept/reject signal.

import type { UserDayRecord, TotalsByFeature } from "@/lib/types/metrics";

/**
 * The accept/reject counts an acceptance rate is computed from.
 *
 * Structural rather than tied to one row type, so both the SQL-side
 * `CompletionDailyRow` and the JS-side aggregation below satisfy it without
 * either module having to depend on the other.
 */
export interface AcceptanceCounts {
  compGenCount: number;
  compAcceptCount: number;
  cliGenCount?: number;
  cliAcceptCount?: number;
}

/**
 * Acceptance rate over every surface that reports a meaningful accept/reject
 * signal: IDE completion plus the Copilot CLI.
 *
 * THE single definition, shared by every caller, so the overview KPI, the daily
 * trend, the per-user page and the per-team page can never drift apart. It
 * lives in this dependency-free module (types only) so that both the SQLite
 * query layer and the JS aggregation here can reach it without a cycle;
 * `aggregation-queries` re-exports it for callers that already import from
 * there.
 *
 * `agent_edit` is deliberately absent — it reports acceptances as a hard 0
 * against non-zero generations, so including it can only deflate the rate.
 * The CLI is deliberately present: it reports real generations *and*
 * acceptances, and excluding it (as the code previously did, by accident, by
 * classifying `copilot_cli` as nothing at all) discarded roughly three quarters
 * of the fleet's genuine acceptance signal.
 */
export function acceptanceRateFrom(row: AcceptanceCounts): number {
  const generations = (row.compGenCount || 0) + (row.cliGenCount || 0);
  if (generations <= 0) return 0;
  const acceptances = (row.compAcceptCount || 0) + (row.cliAcceptCount || 0);
  return (acceptances / generations) * 100;
}

export interface CompletionMetrics {
  locSuggested: number;
  locAccepted: number;
  codeGenCount: number;
  codeAcceptCount: number;
  acceptanceRate: number; // codeAcceptCount / codeGenCount * 100
}

export interface AgentMetrics {
  locAdded: number;
  locDeleted: number;
}

/**
 * Copilot CLI surface metrics.
 *
 * The CLI is its own bucket, not a completion feature and not an agent feature.
 * It reports genuine generation *and* acceptance counts (so its acceptances are
 * a real accept/reject signal, unlike `agent_edit` which always reports 0), but
 * it writes to files directly, so its `loc_added_sum` is not "accepted
 * suggestions" and must never be pooled with IDE completion LoC.
 */
export interface CliMetrics {
  locSuggested: number;
  locAdded: number;
  locDeleted: number;
  codeGenCount: number;
  codeAcceptCount: number;
}

export interface CopilotAppMetrics {
  locAdded: number;
  locDeleted: number;
  codeGenCount: number;
  codeAcceptCount: number;
}

export interface SeparatedMetrics {
  completion: CompletionMetrics;
  agent: AgentMetrics;
  copilotApp: CopilotAppMetrics;
  cli: CliMetrics;
  totalLocAdded: number; // completion accepted + agent added + copilot app added + cli added
  /**
   * Acceptance rate over every surface that reports a meaningful accept/reject
   * signal — IDE completion plus the CLI. `agent_edit` is excluded because it
   * reports acceptances as a hard 0 while still reporting generations, so it
   * can only deflate the rate.
   */
  acceptanceRate: number;
}

/** Check if a feature is a completion/chat feature (not agent_edit, not copilot_app).
 *  Handles both org-level ("chat_panel") and user-level ("chat_panel_ask_mode", etc.) names. */
export function isCompletionFeature(feature: string): boolean {
  return feature === "code_completion"
    || feature === "inline_chat"
    || feature === "chat_panel"
    || feature.startsWith("chat_panel_");
}

/** Check if a feature is an agent edit feature */
export function isAgentFeature(feature: string): boolean {
  return feature === "agent_edit";
}

/**
 * Check if a feature is the Copilot CLI surface.
 *
 * Kept separate from both {@link isCompletionFeature} and
 * {@link isAgentFeature} — see {@link CliMetrics} for why.
 */
export function isCliFeature(feature: string): boolean {
  return feature === "copilot_cli";
}

/**
 * Check whether a feature's accept/reject counts belong in an acceptance rate.
 *
 * True for IDE completion surfaces and the CLI. False for `agent_edit` (always
 * reports 0 acceptances against non-zero generations, so it only deflates the
 * rate) and for `copilot_app` and unknown surfaces, which are reported
 * separately.
 */
export function isAcceptanceEligibleFeature(feature: string): boolean {
  return isCompletionFeature(feature) || isCliFeature(feature);
}

/** Check if a feature is the standalone Copilot App surface */
export function isCopilotAppFeature(feature: string): boolean {
  return feature === "copilot_app";
}

/** Extract completion-only metrics from totals_by_feature array */
export function extractCompletionMetrics(features: TotalsByFeature[]): CompletionMetrics {
  let locSuggested = 0;
  let locAccepted = 0;
  let codeGenCount = 0;
  let codeAcceptCount = 0;

  for (const f of features) {
    if (isCompletionFeature(f.feature)) {
      locSuggested += f.loc_suggested_to_add_sum || 0;
      locAccepted += f.loc_added_sum || 0;
      codeGenCount += f.code_generation_activity_count || 0;
      codeAcceptCount += f.code_acceptance_activity_count || 0;
    }
  }

  return {
    locSuggested,
    locAccepted,
    codeGenCount,
    codeAcceptCount,
    acceptanceRate: codeGenCount > 0 ? (codeAcceptCount / codeGenCount) * 100 : 0,
  };
}

/** Extract agent/edit metrics from totals_by_feature array */
export function extractAgentMetrics(features: TotalsByFeature[]): AgentMetrics {
  let locAdded = 0;
  let locDeleted = 0;

  for (const f of features) {
    if (isAgentFeature(f.feature)) {
      locAdded += f.loc_added_sum || 0;
      locDeleted += f.loc_deleted_sum || 0;
    }
  }

  return { locAdded, locDeleted };
}

/** Extract Copilot App metrics from totals_by_feature array */
export function extractCopilotAppMetrics(features: TotalsByFeature[]): CopilotAppMetrics {
  let locAdded = 0;
  let locDeleted = 0;
  let codeGenCount = 0;
  let codeAcceptCount = 0;

  for (const f of features) {
    if (isCopilotAppFeature(f.feature)) {
      locAdded += f.loc_added_sum || 0;
      locDeleted += f.loc_deleted_sum || 0;
      codeGenCount += f.code_generation_activity_count || 0;
      codeAcceptCount += f.code_acceptance_activity_count || 0;
    }
  }

  return { locAdded, locDeleted, codeGenCount, codeAcceptCount };
}

/** Extract Copilot CLI metrics from totals_by_feature array */
export function extractCliMetrics(features: TotalsByFeature[]): CliMetrics {
  let locSuggested = 0;
  let locAdded = 0;
  let locDeleted = 0;
  let codeGenCount = 0;
  let codeAcceptCount = 0;

  for (const f of features) {
    if (isCliFeature(f.feature)) {
      locSuggested += f.loc_suggested_to_add_sum || 0;
      locAdded += f.loc_added_sum || 0;
      locDeleted += f.loc_deleted_sum || 0;
      codeGenCount += f.code_generation_activity_count || 0;
      codeAcceptCount += f.code_acceptance_activity_count || 0;
    }
  }

  return { locSuggested, locAdded, locDeleted, codeGenCount, codeAcceptCount };
}

/** Get separated metrics from a user record's totals_by_feature */
export function separateMetrics(features: TotalsByFeature[]): SeparatedMetrics {
  const completion = extractCompletionMetrics(features);
  const agent = extractAgentMetrics(features);
  const copilotApp = extractCopilotAppMetrics(features);
  const cli = extractCliMetrics(features);

  return {
    completion,
    agent,
    copilotApp,
    cli,
    totalLocAdded: completion.locAccepted + agent.locAdded + copilotApp.locAdded + cli.locAdded,
    acceptanceRate: acceptanceRateFrom({
      compGenCount: completion.codeGenCount,
      compAcceptCount: completion.codeAcceptCount,
      cliGenCount: cli.codeGenCount,
      cliAcceptCount: cli.codeAcceptCount,
    }),
  };
}

/** Aggregate separated metrics across multiple user day records */
export function aggregateSeparatedMetrics(records: UserDayRecord[]): SeparatedMetrics {
  let compLocSuggested = 0, compLocAccepted = 0, compGenCount = 0, compAcceptCount = 0;
  let agentLocAdded = 0, agentLocDeleted = 0;
  let appLocAdded = 0, appLocDeleted = 0, appGenCount = 0, appAcceptCount = 0;
  let cliLocSuggested = 0, cliLocAdded = 0, cliLocDeleted = 0, cliGenCount = 0, cliAcceptCount = 0;

  for (const r of records) {
    const features = r.totals_by_feature || [];
    for (const f of features) {
      if (isCompletionFeature(f.feature)) {
        compLocSuggested += f.loc_suggested_to_add_sum || 0;
        compLocAccepted += f.loc_added_sum || 0;
        compGenCount += f.code_generation_activity_count || 0;
        compAcceptCount += f.code_acceptance_activity_count || 0;
      }
      if (isAgentFeature(f.feature)) {
        agentLocAdded += f.loc_added_sum || 0;
        agentLocDeleted += f.loc_deleted_sum || 0;
      }
      if (isCopilotAppFeature(f.feature)) {
        appLocAdded += f.loc_added_sum || 0;
        appLocDeleted += f.loc_deleted_sum || 0;
        appGenCount += f.code_generation_activity_count || 0;
        appAcceptCount += f.code_acceptance_activity_count || 0;
      }
      if (isCliFeature(f.feature)) {
        cliLocSuggested += f.loc_suggested_to_add_sum || 0;
        cliLocAdded += f.loc_added_sum || 0;
        cliLocDeleted += f.loc_deleted_sum || 0;
        cliGenCount += f.code_generation_activity_count || 0;
        cliAcceptCount += f.code_acceptance_activity_count || 0;
      }
    }
  }

  const acceptEligible: AcceptanceCounts = {
    compGenCount,
    compAcceptCount,
    cliGenCount,
    cliAcceptCount,
  };

  return {
    completion: {
      locSuggested: compLocSuggested,
      locAccepted: compLocAccepted,
      codeGenCount: compGenCount,
      codeAcceptCount: compAcceptCount,
      acceptanceRate: compGenCount > 0 ? (compAcceptCount / compGenCount) * 100 : 0,
    },
    agent: { locAdded: agentLocAdded, locDeleted: agentLocDeleted },
    copilotApp: {
      locAdded: appLocAdded,
      locDeleted: appLocDeleted,
      codeGenCount: appGenCount,
      codeAcceptCount: appAcceptCount,
    },
    cli: {
      locSuggested: cliLocSuggested,
      locAdded: cliLocAdded,
      locDeleted: cliLocDeleted,
      codeGenCount: cliGenCount,
      codeAcceptCount: cliAcceptCount,
    },
    totalLocAdded: compLocAccepted + agentLocAdded + appLocAdded + cliLocAdded,
    acceptanceRate: acceptanceRateFrom(acceptEligible),
  };
}
