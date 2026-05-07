import { describe, it, expect } from "vitest";
import { computeTeamDayMetrics, computeTeamSummary } from "./team-metrics";
import type { UserDayRecord } from "@/lib/types/metrics";

function makeRecord(overrides: Partial<UserDayRecord> = {}): UserDayRecord {
  return {
    day: "2024-01-15",
    enterprise_id: "ent-1",
    user_id: 1,
    user_login: "alice",
    code_generation_activity_count: 10,
    code_acceptance_activity_count: 8,
    user_initiated_interaction_count: 5,
    loc_suggested_to_add_sum: 100,
    loc_suggested_to_delete_sum: 10,
    loc_added_sum: 80,
    loc_deleted_sum: 5,
    used_agent: false,
    used_chat: true,
    used_cli: false,
    totals_by_ide: [],
    totals_by_feature: [],
    totals_by_language_feature: [],
    totals_by_model_feature: [],
    totals_by_language_model: [],
    ...overrides,
  };
}

describe("computeTeamDayMetrics", () => {
  it("returns zeros when no records match", () => {
    const result = computeTeamDayMetrics("team-a", "Team A", ["alice"], [], "2024-01-15");
    expect(result.activeUsers).toBe(0);
    expect(result.totalMembers).toBe(1);
    expect(result.codeGenerationCount).toBe(0);
  });

  it("counts active users correctly", () => {
    const records: UserDayRecord[] = [
      makeRecord({ user_login: "alice", day: "2024-01-15", code_generation_activity_count: 5 }),
      makeRecord({ user_login: "bob", day: "2024-01-15", code_generation_activity_count: 0, user_initiated_interaction_count: 0, used_agent: false, used_chat: false, used_cli: false }),
    ];
    const result = computeTeamDayMetrics("team-a", "Team A", ["alice", "bob"], records, "2024-01-15");
    expect(result.activeUsers).toBe(1);
    expect(result.totalMembers).toBe(2);
  });

  it("aggregates code metrics across members", () => {
    const records: UserDayRecord[] = [
      makeRecord({ user_login: "alice", day: "2024-01-15", loc_added_sum: 50 }),
      makeRecord({ user_login: "bob", day: "2024-01-15", loc_added_sum: 30 }),
    ];
    const result = computeTeamDayMetrics("team-a", "Team A", ["alice", "bob"], records, "2024-01-15");
    expect(result.locAdded).toBe(80);
  });

  it("only includes records for team members", () => {
    const records: UserDayRecord[] = [
      makeRecord({ user_login: "alice", day: "2024-01-15", loc_added_sum: 50 }),
      makeRecord({ user_login: "outsider", day: "2024-01-15", loc_added_sum: 999 }),
    ];
    const result = computeTeamDayMetrics("team-a", "Team A", ["alice"], records, "2024-01-15");
    expect(result.locAdded).toBe(50);
  });

  it("computes acceptanceRate from totals_by_feature", () => {
    const records: UserDayRecord[] = [
      makeRecord({
        user_login: "alice", day: "2024-01-15",
        totals_by_feature: [
          { feature: "code_completion", code_generation_activity_count: 100, code_acceptance_activity_count: 40, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, user_initiated_interaction_count: 0 },
        ],
      }),
    ];
    const result = computeTeamDayMetrics("team-a", "Team A", ["alice"], records, "2024-01-15");
    expect(result.acceptanceRate).toBe(40);
  });
});

describe("computeTeamSummary", () => {
  it("returns empty summary for no records", () => {
    const result = computeTeamSummary("team-a", "Team A", ["alice", "bob"], []);
    expect(result.totalMembers).toBe(2);
    expect(result.avgDailyActiveUsers).toBe(0);
    expect(result.dailyMetrics).toEqual([]);
  });

  it("computes adoption rates", () => {
    const records: UserDayRecord[] = [
      makeRecord({ user_login: "alice", day: "2024-01-15", used_agent: true, used_chat: true }),
      makeRecord({ user_login: "bob", day: "2024-01-15", used_agent: false, used_chat: false }),
    ];
    const result = computeTeamSummary("team-a", "Team A", ["alice", "bob"], records);
    expect(result.agentAdoptionRate).toBe(50);
    expect(result.chatAdoptionRate).toBe(50);
  });

  it("aggregates chat modes", () => {
    const records: UserDayRecord[] = [
      makeRecord({ user_login: "alice", day: "2024-01-15", chat_panel_agent_mode: 3, chat_panel_ask_mode: 2 }),
      makeRecord({ user_login: "bob", day: "2024-01-15", chat_panel_agent_mode: 1, chat_panel_ask_mode: 5 }),
    ];
    const result = computeTeamSummary("team-a", "Team A", ["alice", "bob"], records);
    expect(result.chatModes.agent).toBe(4);
    expect(result.chatModes.ask).toBe(7);
  });

  it("computes overallAcceptanceRate from totals_by_feature", () => {
    const records: UserDayRecord[] = [
      makeRecord({
        user_login: "alice", day: "2024-01-15",
        used_cli: true, used_copilot_code_review_active: true,
        totals_by_feature: [
          { feature: "code_completion", code_generation_activity_count: 50, code_acceptance_activity_count: 25, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, loc_added_sum: 0, loc_deleted_sum: 0, user_initiated_interaction_count: 0 },
        ],
      }),
    ];
    const result = computeTeamSummary("team-a", "Team A", ["alice"], records);
    expect(result.overallAcceptanceRate).toBe(50);
    expect(result.cliAdoptionRate).toBe(100);
    expect(result.codeReviewAdoptionRate).toBe(100);
  });

  it("returns 0 adoption rates when members is empty", () => {
    const result = computeTeamSummary("team-x", "Team X", [], []);
    expect(result.agentAdoptionRate).toBe(0);
    expect(result.chatAdoptionRate).toBe(0);
    expect(result.cliAdoptionRate).toBe(0);
    expect(result.codeReviewAdoptionRate).toBe(0);
  });
});
