// Helper to separate code completion metrics from agent/edit metrics
// Per GitHub docs: acceptance rate applies ONLY to code completions,
// agent_edit writes code directly (loc_added_sum) without suggestions

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

export interface SeparatedMetrics {
  completion: CompletionMetrics;
  agent: AgentMetrics;
  totalLocAdded: number; // completion accepted + agent added
}

const COMPLETION_FEATURES = new Set(["code_completion", "inline_chat", "chat_panel"]);
const AGENT_FEATURES = new Set(["agent_edit"]);

/** Extract completion-only metrics from totals_by_feature array */
export function extractCompletionMetrics(features: TotalsByFeature[]): CompletionMetrics {
  let locSuggested = 0;
  let locAccepted = 0;
  let codeGenCount = 0;
  let codeAcceptCount = 0;

  for (const f of features) {
    if (COMPLETION_FEATURES.has(f.feature)) {
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
    if (AGENT_FEATURES.has(f.feature)) {
      locAdded += f.loc_added_sum || 0;
      locDeleted += f.loc_deleted_sum || 0;
    }
  }

  return { locAdded, locDeleted };
}

/** Get separated metrics from a user record's totals_by_feature */
export function separateMetrics(features: TotalsByFeature[]): SeparatedMetrics {
  const completion = extractCompletionMetrics(features);
  const agent = extractAgentMetrics(features);

  return {
    completion,
    agent,
    totalLocAdded: completion.locAccepted + agent.locAdded,
  };
}

/** Aggregate separated metrics across multiple user day records */
export function aggregateSeparatedMetrics(records: UserDayRecord[]): SeparatedMetrics {
  let compLocSuggested = 0, compLocAccepted = 0, compGenCount = 0, compAcceptCount = 0;
  let agentLocAdded = 0, agentLocDeleted = 0;

  for (const r of records) {
    const features = r.totals_by_feature || [];
    for (const f of features) {
      if (COMPLETION_FEATURES.has(f.feature)) {
        compLocSuggested += f.loc_suggested_to_add_sum || 0;
        compLocAccepted += f.loc_added_sum || 0;
        compGenCount += f.code_generation_activity_count || 0;
        compAcceptCount += f.code_acceptance_activity_count || 0;
      }
      if (AGENT_FEATURES.has(f.feature)) {
        agentLocAdded += f.loc_added_sum || 0;
        agentLocDeleted += f.loc_deleted_sum || 0;
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
    totalLocAdded: compLocAccepted + agentLocAdded,
  };
}
