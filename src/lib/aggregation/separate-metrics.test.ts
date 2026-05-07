import { describe, it, expect } from "vitest";
import {
  extractCompletionMetrics,
  extractAgentMetrics,
  separateMetrics,
  aggregateSeparatedMetrics,
} from "./separate-metrics";
import type { TotalsByFeature } from "@/lib/types/metrics";

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
  });
});

// ── aggregateSeparatedMetrics ─────────────────────────────────────────

describe("aggregateSeparatedMetrics", () => {
  it("returns zeros for empty records", () => {
    const result = aggregateSeparatedMetrics([]);
    expect(result.completion.locAccepted).toBe(0);
    expect(result.agent.locAdded).toBe(0);
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
});
