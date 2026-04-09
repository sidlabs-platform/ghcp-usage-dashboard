// Team-level metrics aggregation engine
// Computes team metrics by cross-referencing user-level data with team membership

import type { UserDayRecord } from "@/lib/types/metrics";
import { extractCompletionMetrics } from "./separate-metrics";

export interface TeamDayMetrics {
  teamSlug: string;
  teamName: string;
  day: string;
  totalMembers: number;
  activeUsers: number;
  agentUsers: number;
  chatUsers: number;
  cliUsers: number;
  codeReviewActiveUsers: number;
  codeReviewPassiveUsers: number;
  codeGenerationCount: number;
  codeAcceptanceCount: number;
  userInteractionCount: number;
  locSuggestedToAdd: number;
  locAdded: number;
  locDeleted: number;
  chatModes: {
    ask: number;
    edit: number;
    plan: number;
    agent: number;
    custom: number;
    unknown: number;
  };
  acceptanceRate: number;
}

export interface TeamSummary {
  teamSlug: string;
  teamName: string;
  totalMembers: number;
  avgDailyActiveUsers: number;
  totalLocAdded: number;
  totalLocSuggested: number;
  totalInteractions: number;
  totalCodeGenCount: number;
  totalCodeAcceptCount: number;
  overallAcceptanceRate: number;
  agentAdoptionRate: number;
  chatAdoptionRate: number;
  cliAdoptionRate: number;
  codeReviewAdoptionRate: number;
  chatModes: {
    ask: number;
    edit: number;
    plan: number;
    agent: number;
    custom: number;
    unknown: number;
  };
  dailyMetrics: TeamDayMetrics[];
}

export function computeTeamDayMetrics(
  teamSlug: string,
  teamName: string,
  members: string[],
  userRecords: UserDayRecord[],
  day: string
): TeamDayMetrics {
  const memberSet = new Set(members);
  const dayRecords = userRecords.filter(
    (u) => u.day === day && memberSet.has(u.user_login)
  );

  const activeUsers = dayRecords.filter(
    (u) => u.code_generation_activity_count > 0 || u.user_initiated_interaction_count > 0 || u.used_agent || u.used_chat || u.used_cli
  ).length;

  const codeGenCount = dayRecords.reduce((s, u) => s + u.code_generation_activity_count, 0);
  const codeAcceptCount = dayRecords.reduce((s, u) => s + u.code_acceptance_activity_count, 0);

  return {
    teamSlug,
    teamName,
    day,
    totalMembers: members.length,
    activeUsers,
    agentUsers: dayRecords.filter((u) => u.used_agent).length,
    chatUsers: dayRecords.filter((u) => u.used_chat).length,
    cliUsers: dayRecords.filter((u) => u.used_cli).length,
    codeReviewActiveUsers: dayRecords.filter((u) => u.used_copilot_code_review_active).length,
    codeReviewPassiveUsers: dayRecords.filter((u) => u.used_copilot_code_review_passive).length,
    codeGenerationCount: codeGenCount,
    codeAcceptanceCount: codeAcceptCount,
    userInteractionCount: dayRecords.reduce((s, u) => s + u.user_initiated_interaction_count, 0),
    locSuggestedToAdd: dayRecords.reduce((s, u) => s + u.loc_suggested_to_add_sum, 0),
    locAdded: dayRecords.reduce((s, u) => s + u.loc_added_sum, 0),
    locDeleted: dayRecords.reduce((s, u) => s + u.loc_deleted_sum, 0),
    chatModes: {
      ask: dayRecords.reduce((s, u) => s + (u.chat_panel_ask_mode || 0), 0),
      edit: dayRecords.reduce((s, u) => s + (u.chat_panel_edit_mode || 0), 0),
      plan: dayRecords.reduce((s, u) => s + (u.chat_panel_plan_mode || 0), 0),
      agent: dayRecords.reduce((s, u) => s + (u.chat_panel_agent_mode || 0), 0),
      custom: dayRecords.reduce((s, u) => s + (u.chat_panel_custom_mode || 0), 0),
      unknown: dayRecords.reduce((s, u) => s + (u.chat_panel_unknown_mode || 0), 0),
    },
    // Acceptance rate: completion-only (excludes agent_edit)
    acceptanceRate: (() => {
      let gen = 0, acc = 0;
      for (const r of dayRecords) {
        const comp = extractCompletionMetrics(r.totals_by_feature || []);
        gen += comp.codeGenCount;
        acc += comp.codeAcceptCount;
      }
      return gen > 0 ? (acc / gen) * 100 : 0;
    })(),
  };
}

export function computeTeamSummary(
  teamSlug: string,
  teamName: string,
  members: string[],
  userRecords: UserDayRecord[]
): TeamSummary {
  // Get unique days
  const days = [...new Set(userRecords.map((u) => u.day))].sort();
  const memberSet = new Set(members);

  // Filter records to team members
  const teamRecords = userRecords.filter((u) => memberSet.has(u.user_login));

  // Daily breakdown
  const dailyMetrics = days.map((day) =>
    computeTeamDayMetrics(teamSlug, teamName, members, userRecords, day)
  );

  // Aggregate stats — completion-only acceptance rate
  let compGenTotal = 0, compAcceptTotal = 0;
  for (const r of teamRecords) {
    const comp = extractCompletionMetrics(r.totals_by_feature || []);
    compGenTotal += comp.codeGenCount;
    compAcceptTotal += comp.codeAcceptCount;
  }

  // Unique users who used each feature in the period
  const uniqueMembers = new Set(teamRecords.map((u) => u.user_login));
  const uniqueAgentUsers = new Set(teamRecords.filter((u) => u.used_agent).map((u) => u.user_login));
  const uniqueChatUsers = new Set(teamRecords.filter((u) => u.used_chat).map((u) => u.user_login));
  const uniqueCliUsers = new Set(teamRecords.filter((u) => u.used_cli).map((u) => u.user_login));
  const uniqueCodeReviewUsers = new Set(teamRecords.filter((u) => u.used_copilot_code_review_active).map((u) => u.user_login));

  const avgDailyActive = dailyMetrics.length > 0
    ? dailyMetrics.reduce((s, d) => s + d.activeUsers, 0) / dailyMetrics.length
    : 0;

  return {
    teamSlug,
    teamName,
    totalMembers: members.length,
    avgDailyActiveUsers: Math.round(avgDailyActive * 10) / 10,
    totalLocAdded: teamRecords.reduce((s, u) => s + u.loc_added_sum, 0),
    totalLocSuggested: teamRecords.reduce((s, u) => s + u.loc_suggested_to_add_sum, 0),
    totalInteractions: teamRecords.reduce((s, u) => s + u.user_initiated_interaction_count, 0),
    totalCodeGenCount: compGenTotal,
    totalCodeAcceptCount: compAcceptTotal,
    overallAcceptanceRate: compGenTotal > 0 ? (compAcceptTotal / compGenTotal) * 100 : 0,
    agentAdoptionRate: members.length > 0 ? (uniqueAgentUsers.size / members.length) * 100 : 0,
    chatAdoptionRate: members.length > 0 ? (uniqueChatUsers.size / members.length) * 100 : 0,
    cliAdoptionRate: members.length > 0 ? (uniqueCliUsers.size / members.length) * 100 : 0,
    codeReviewAdoptionRate: members.length > 0 ? (uniqueCodeReviewUsers.size / members.length) * 100 : 0,
    chatModes: {
      ask: teamRecords.reduce((s, u) => s + (u.chat_panel_ask_mode || 0), 0),
      edit: teamRecords.reduce((s, u) => s + (u.chat_panel_edit_mode || 0), 0),
      plan: teamRecords.reduce((s, u) => s + (u.chat_panel_plan_mode || 0), 0),
      agent: teamRecords.reduce((s, u) => s + (u.chat_panel_agent_mode || 0), 0),
      custom: teamRecords.reduce((s, u) => s + (u.chat_panel_custom_mode || 0), 0),
      unknown: teamRecords.reduce((s, u) => s + (u.chat_panel_unknown_mode || 0), 0),
    },
    dailyMetrics,
  };
}
