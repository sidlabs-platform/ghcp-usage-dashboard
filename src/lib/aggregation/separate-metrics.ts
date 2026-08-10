// Helper to separate code completion metrics from agent/edit and Copilot App metrics
// Per GitHub docs: acceptance rate applies ONLY to code completions,
// agent_edit writes code directly (loc_added_sum) without suggestions.
// copilot_app (the standalone Copilot mobile/web app surface) is a distinct
// surface that must not be classified as a completion feature either — its
// code activity is reported separately so it can never dilute or inflate
// the completion acceptance rate or completion LoC totals.

import type { UserDayRecord, TotalsByFeature } from "@/lib/types/metrics";

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
  totalLocAdded: number; // completion accepted + agent added + copilot app added
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

/** Get separated metrics from a user record's totals_by_feature */
export function separateMetrics(features: TotalsByFeature[]): SeparatedMetrics {
  const completion = extractCompletionMetrics(features);
  const agent = extractAgentMetrics(features);
  const copilotApp = extractCopilotAppMetrics(features);

  return {
    completion,
    agent,
    copilotApp,
    totalLocAdded: completion.locAccepted + agent.locAdded + copilotApp.locAdded,
  };
}

/** Aggregate separated metrics across multiple user day records */
export function aggregateSeparatedMetrics(records: UserDayRecord[]): SeparatedMetrics {
  let compLocSuggested = 0, compLocAccepted = 0, compGenCount = 0, compAcceptCount = 0;
  let agentLocAdded = 0, agentLocDeleted = 0;
  let appLocAdded = 0, appLocDeleted = 0, appGenCount = 0, appAcceptCount = 0;

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
    }
  }

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
    totalLocAdded: compLocAccepted + agentLocAdded + appLocAdded,
  };
}
