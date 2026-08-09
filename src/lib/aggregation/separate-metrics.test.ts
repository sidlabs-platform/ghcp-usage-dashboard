import { describe, it, expect } from "vitest";
import {
  extractCompletionMetrics,
  extractAgentMetrics,
  extractCopilotAppMetrics,
  separateMetrics,
  aggregateSeparatedMetrics,
  isCompletionFeature,
  isAgentFeature,
  isCopilotAppFeature,
} from "./separate-metrics";
import type { TotalsByFeature, UserDayRecord } from "@/lib/types/metrics";

// ── Helpers ───────────────────────────────────────────────────────────

function makeFeature(
  feature: string,
  overrides: Partial<TotalsByFeature> = {},
): TotalsByFeature {
  return {
    feature,
    code_acceptance_activity_count: 0,
    code_generation_activity_count: 0,
    loc_added_sum: 0,
    loc_deleted_sum: 0,
    loc_suggested_to_add_sum: 0,
    loc_suggested_to_delete_sum: 0,
    user_initiated_interaction_count: 0,
    ...overrides,
  };
}

// ── isCompletionFeature / isAgentFeature ──────────────────────────────

describe("isCompletionFeature", () => {
  it("matches org-level completion features", () => {
    expect(isCompletionFeature("code_completion")).toBe(true);
    expect(isCompletionFeature("inline_chat")).toBe(true);
    expect(isCompletionFeature("chat_panel")).toBe(true);
  });

  it("matches user-level chat_panel_* modes", () => {
    expect(isCompletionFeature("chat_panel_ask_mode")).toBe(true);
    expect(isCompletionFeature("chat_panel_edit_mode")).toBe(true);
    expect(isCompletionFeature("chat_panel_plan_mode")).toBe(true);
    expect(isCompletionFeature("chat_panel_agent_mode")).toBe(true);
    expect(isCompletionFeature("chat_panel_custom_mode")).toBe(true);
    expect(isCompletionFeature("chat_panel_unknown_mode")).toBe(true);
  });

  it("rejects agent_edit and unknown features", () => {
    expect(isCompletionFeature("agent_edit")).toBe(false);
    expect(isCompletionFeature("unknown_feature")).toBe(false);
  });

  it("rejects copilot_app — App activity is not a completion feature", () => {
    expect(isCompletionFeature("copilot_app")).toBe(false);
  });
});

describe("isAgentFeature", () => {
  it("matches agent_edit", () => {
    expect(isAgentFeature("agent_edit")).toBe(true);
  });

  it("rejects completion features", () => {
    expect(isAgentFeature("code_completion")).toBe(false);
    expect(isAgentFeature("chat_panel_agent_mode")).toBe(false);
  });

  it("rejects copilot_app", () => {
    expect(isAgentFeature("copilot_app")).toBe(false);
  });
});

describe("isCopilotAppFeature", () => {
  it("matches only copilot_app", () => {
    expect(isCopilotAppFeature("copilot_app")).toBe(true);
  });

  it("rejects completion and agent features", () => {
    expect(isCopilotAppFeature("code_completion")).toBe(false);
    expect(isCopilotAppFeature("chat_panel_agent_mode")).toBe(false);
    expect(isCopilotAppFeature("agent_edit")).toBe(false);
    expect(isCopilotAppFeature("unknown_feature")).toBe(false);
  });
});

// ── extractCompletionMetrics ──────────────────────────────────────────

describe("extractCompletionMetrics", () => {
  it("returns zeros for empty array", () => {
    const result = extractCompletionMetrics([]);
    expect(result).toEqual({
      locSuggested: 0,
      locAccepted: 0,
      codeGenCount: 0,
      codeAcceptCount: 0,
      acceptanceRate: 0,
    });
  });

  it("sums code_completion features", () => {
    const features = [
      makeFeature("code_completion", {
        loc_suggested_to_add_sum: 100,
        loc_added_sum: 80,
        code_generation_activity_count: 50,
        code_acceptance_activity_count: 40,
      }),
    ];
    const result = extractCompletionMetrics(features);
    expect(result.locSuggested).toBe(100);
    expect(result.locAccepted).toBe(80);
    expect(result.codeGenCount).toBe(50);
    expect(result.codeAcceptCount).toBe(40);
    expect(result.acceptanceRate).toBe(80); // 40/50 * 100
  });

  it("includes inline_chat and chat_panel as completion features", () => {
    const features = [
      makeFeature("inline_chat", { loc_added_sum: 10, code_generation_activity_count: 5, code_acceptance_activity_count: 3 }),
      makeFeature("chat_panel", { loc_added_sum: 20, code_generation_activity_count: 10, code_acceptance_activity_count: 7 }),
    ];
    const result = extractCompletionMetrics(features);
    expect(result.locAccepted).toBe(30);
    expect(result.codeGenCount).toBe(15);
    expect(result.codeAcceptCount).toBe(10);
    expect(result.acceptanceRate).toBeCloseTo(66.667, 2);
  });

  it("ignores agent_edit features", () => {
    const features = [
      makeFeature("code_completion", { loc_added_sum: 50, code_generation_activity_count: 10, code_acceptance_activity_count: 8 }),
      makeFeature("agent_edit", { loc_added_sum: 200, code_generation_activity_count: 100, code_acceptance_activity_count: 100 }),
    ];
    const result = extractCompletionMetrics(features);
    expect(result.locAccepted).toBe(50);
    expect(result.codeGenCount).toBe(10);
  });

  it("handles null/undefined numeric fields gracefully (|| 0 fallback)", () => {
    const features = [
      makeFeature("code_completion", {
        loc_suggested_to_add_sum: undefined as unknown as number,
        loc_added_sum: null as unknown as number,
      }),
    ];
    const result = extractCompletionMetrics(features);
    expect(result.locSuggested).toBe(0);
    expect(result.locAccepted).toBe(0);
  });

  it("returns 0 acceptance rate when codeGenCount is 0", () => {
    const features = [
      makeFeature("code_completion", { code_generation_activity_count: 0, code_acceptance_activity_count: 0 }),
    ];
    expect(extractCompletionMetrics(features).acceptanceRate).toBe(0);
  });

  it("includes user-level chat_panel_* modes as completion features", () => {
    const features = [
      makeFeature("chat_panel_ask_mode", { loc_added_sum: 15, loc_suggested_to_add_sum: 20, code_generation_activity_count: 8, code_acceptance_activity_count: 5 }),
      makeFeature("chat_panel_edit_mode", { loc_added_sum: 10, loc_suggested_to_add_sum: 12, code_generation_activity_count: 6, code_acceptance_activity_count: 4 }),
      makeFeature("agent_edit", { loc_added_sum: 500, code_generation_activity_count: 50, code_acceptance_activity_count: 0 }),
    ];
    const result = extractCompletionMetrics(features);
    expect(result.locAccepted).toBe(25); // 15 + 10, agent excluded
    expect(result.locSuggested).toBe(32); // 20 + 12, agent excluded
    expect(result.codeGenCount).toBe(14); // 8 + 6, agent excluded
    expect(result.codeAcceptCount).toBe(9); // 5 + 4, agent excluded
  });
});

// ── extractAgentMetrics ───────────────────────────────────────────────

describe("extractAgentMetrics", () => {
  it("returns zeros for empty array", () => {
    expect(extractAgentMetrics([])).toEqual({ locAdded: 0, locDeleted: 0 });
  });

  it("extracts only agent_edit features", () => {
    const features = [
      makeFeature("code_completion", { loc_added_sum: 100 }),
      makeFeature("agent_edit", { loc_added_sum: 300, loc_deleted_sum: 50 }),
    ];
    const result = extractAgentMetrics(features);
    expect(result.locAdded).toBe(300);
    expect(result.locDeleted).toBe(50);
  });

  it("handles null fields via || 0", () => {
    const features = [
      makeFeature("agent_edit", { loc_added_sum: null as unknown as number }),
    ];
    expect(extractAgentMetrics(features).locAdded).toBe(0);
  });
});

// ── extractCopilotAppMetrics ──────────────────────────────────────────

describe("extractCopilotAppMetrics", () => {
  it("returns zeros for empty array", () => {
    expect(extractCopilotAppMetrics([])).toEqual({
      locAdded: 0,
      locDeleted: 0,
      codeGenCount: 0,
      codeAcceptCount: 0,
    });
  });

  it("extracts only copilot_app features", () => {
    const features = [
      makeFeature("code_completion", { loc_added_sum: 100, code_generation_activity_count: 50, code_acceptance_activity_count: 40 }),
      makeFeature("agent_edit", { loc_added_sum: 300, loc_deleted_sum: 50 }),
      makeFeature("copilot_app", {
        loc_added_sum: 75,
        loc_deleted_sum: 12,
        code_generation_activity_count: 9,
        code_acceptance_activity_count: 6,
      }),
    ];
    const result = extractCopilotAppMetrics(features);
    expect(result.locAdded).toBe(75);
    expect(result.locDeleted).toBe(12);
    expect(result.codeGenCount).toBe(9);
    expect(result.codeAcceptCount).toBe(6);
  });

  it("handles null fields via || 0", () => {
    const features = [
      makeFeature("copilot_app", {
        loc_added_sum: null as unknown as number,
        loc_deleted_sum: undefined as unknown as number,
        code_generation_activity_count: null as unknown as number,
        code_acceptance_activity_count: undefined as unknown as number,
      }),
    ];
    expect(extractCopilotAppMetrics(features)).toEqual({
      locAdded: 0,
      locDeleted: 0,
      codeGenCount: 0,
      codeAcceptCount: 0,
    });
  });
});

// ── separateMetrics ───────────────────────────────────────────────────

describe("separateMetrics", () => {
  it("calculates totalLocAdded as completion accepted + agent added", () => {
    const features = [
      makeFeature("code_completion", { loc_added_sum: 50 }),
      makeFeature("agent_edit", { loc_added_sum: 200 }),
    ];
    const result = separateMetrics(features);
    expect(result.totalLocAdded).toBe(250);
    expect(result.completion.locAccepted).toBe(50);
    expect(result.agent.locAdded).toBe(200);
    expect(result.copilotApp).toEqual({ locAdded: 0, locDeleted: 0, codeGenCount: 0, codeAcceptCount: 0 });
  });

  it("includes copilot_app loc in totalLocAdded and keeps it out of completion/agent", () => {
    const features = [
      makeFeature("code_completion", { loc_added_sum: 50, code_generation_activity_count: 10, code_acceptance_activity_count: 8 }),
      makeFeature("agent_edit", { loc_added_sum: 200, loc_deleted_sum: 30 }),
      makeFeature("copilot_app", { loc_added_sum: 40, loc_deleted_sum: 5, code_generation_activity_count: 4, code_acceptance_activity_count: 3 }),
    ];
    const result = separateMetrics(features);
    expect(result.copilotApp.locAdded).toBe(40);
    expect(result.copilotApp.locDeleted).toBe(5);
    expect(result.copilotApp.codeGenCount).toBe(4);
    expect(result.copilotApp.codeAcceptCount).toBe(3);
    // copilot_app must not leak into completion or agent metrics
    expect(result.completion.locAccepted).toBe(50);
    expect(result.completion.codeGenCount).toBe(10);
    expect(result.agent.locAdded).toBe(200);
    // total includes App LoC added
    expect(result.totalLocAdded).toBe(290); // 50 + 200 + 40
  });
});

// ── aggregateSeparatedMetrics ─────────────────────────────────────────

describe("aggregateSeparatedMetrics", () => {
  it("returns zeros for empty records", () => {
    const result = aggregateSeparatedMetrics([]);
    expect(result.completion.locAccepted).toBe(0);
    expect(result.agent.locAdded).toBe(0);
    expect(result.copilotApp.locAdded).toBe(0);
    expect(result.totalLocAdded).toBe(0);
  });

  it("aggregates across multiple user day records", () => {
    const records = [
      {
        totals_by_feature: [
          makeFeature("code_completion", { loc_added_sum: 10, code_generation_activity_count: 5, code_acceptance_activity_count: 3 }),
          makeFeature("agent_edit", { loc_added_sum: 20, loc_deleted_sum: 5 }),
        ],
      },
      {
        totals_by_feature: [
          makeFeature("code_completion", { loc_added_sum: 30, code_generation_activity_count: 15, code_acceptance_activity_count: 12 }),
          makeFeature("agent_edit", { loc_added_sum: 40, loc_deleted_sum: 10 }),
        ],
      },
    ] as any[];

    const result = aggregateSeparatedMetrics(records);
    expect(result.completion.locAccepted).toBe(40); // 10 + 30
    expect(result.completion.codeGenCount).toBe(20); // 5 + 15
    expect(result.completion.codeAcceptCount).toBe(15); // 3 + 12
    expect(result.completion.acceptanceRate).toBe(75); // 15/20 * 100
    expect(result.agent.locAdded).toBe(60); // 20 + 40
    expect(result.agent.locDeleted).toBe(15); // 5 + 10
    expect(result.totalLocAdded).toBe(100); // 40 + 60
  });

  it("handles records with undefined totals_by_feature", () => {
    const records = [{ totals_by_feature: undefined }] as any[];
    const result = aggregateSeparatedMetrics(records);
    expect(result.totalLocAdded).toBe(0);
  });

  it("regression: completion accepted never exceeds suggested when agent is excluded", () => {
    // Scenario: user with heavy agent usage — top-level loc_added > loc_suggested
    const records = [{
      totals_by_feature: [
        makeFeature("code_completion", {
          loc_suggested_to_add_sum: 100,
          loc_added_sum: 25,
          code_generation_activity_count: 50,
          code_acceptance_activity_count: 12,
        }),
        makeFeature("agent_edit", {
          loc_suggested_to_add_sum: 0, // always 0 per GitHub API
          loc_added_sum: 2342,
          loc_deleted_sum: 947,
          code_generation_activity_count: 1,
          code_acceptance_activity_count: 0, // always 0 for agent
        }),
      ],
    }] as any[];

    const result = aggregateSeparatedMetrics(records);
    // Completion-only: accepted (25) should NOT exceed suggested (100)
    expect(result.completion.locAccepted).toBeLessThanOrEqual(result.completion.locSuggested);
    expect(result.completion.locSuggested).toBe(100);
    expect(result.completion.locAccepted).toBe(25);
    // Agent separate
    expect(result.agent.locAdded).toBe(2342);
    expect(result.agent.locDeleted).toBe(947);
    // Acceptance rate: completion-only (12/50 = 24%), NOT deflated by agent
    expect(result.completion.acceptanceRate).toBe(24); // 12/50 * 100
    // Total includes both
    expect(result.totalLocAdded).toBe(2367); // 25 + 2342
  });

  it("handles null numeric fields in aggregation (|| 0 fallbacks)", () => {
    const records = [{
      totals_by_feature: [
        { feature: "code_completion", loc_suggested_to_add_sum: null, loc_added_sum: null, code_generation_activity_count: null, code_acceptance_activity_count: null, loc_deleted_sum: 0, user_initiated_interaction_count: 0, loc_suggested_to_delete_sum: 0 },
        { feature: "agent_edit", loc_added_sum: null, loc_deleted_sum: null, loc_suggested_to_add_sum: 0, loc_suggested_to_delete_sum: 0, code_generation_activity_count: 0, code_acceptance_activity_count: 0, user_initiated_interaction_count: 0 },
      ],
    }] as any[];
    const result = aggregateSeparatedMetrics(records);
    expect(result.completion.locSuggested).toBe(0);
    expect(result.completion.locAccepted).toBe(0);
    expect(result.completion.codeGenCount).toBe(0);
    expect(result.agent.locAdded).toBe(0);
    expect(result.agent.locDeleted).toBe(0);
  });

  it("aggregates copilot_app metrics across records and keeps them isolated from completion/agent", () => {
    const records = [
      {
        totals_by_feature: [
          makeFeature("code_completion", { loc_added_sum: 10, code_generation_activity_count: 5, code_acceptance_activity_count: 3 }),
          makeFeature("agent_edit", { loc_added_sum: 20, loc_deleted_sum: 5 }),
          makeFeature("copilot_app", { loc_added_sum: 8, loc_deleted_sum: 1, code_generation_activity_count: 2, code_acceptance_activity_count: 1 }),
        ],
      },
      {
        totals_by_feature: [
          makeFeature("code_completion", { loc_added_sum: 30, code_generation_activity_count: 15, code_acceptance_activity_count: 12 }),
          makeFeature("copilot_app", { loc_added_sum: 12, loc_deleted_sum: 3, code_generation_activity_count: 4, code_acceptance_activity_count: 2 }),
        ],
      },
    ] as unknown as UserDayRecord[];

    const result = aggregateSeparatedMetrics(records);
    expect(result.copilotApp.locAdded).toBe(20); // 8 + 12
    expect(result.copilotApp.locDeleted).toBe(4); // 1 + 3
    expect(result.copilotApp.codeGenCount).toBe(6); // 2 + 4
    expect(result.copilotApp.codeAcceptCount).toBe(3); // 1 + 2
    // App activity must not affect completion counts
    expect(result.completion.locAccepted).toBe(40); // 10 + 30, App excluded
    expect(result.completion.codeGenCount).toBe(20); // 5 + 15, App excluded
    expect(result.completion.acceptanceRate).toBe(75); // 15/20 * 100, unaffected by App
    // Agent stays isolated too
    expect(result.agent.locAdded).toBe(20);
    // Total includes completion + agent + App added
    expect(result.totalLocAdded).toBe(80); // 40 (completion) + 20 (agent) + 20 (app)
  });
});
