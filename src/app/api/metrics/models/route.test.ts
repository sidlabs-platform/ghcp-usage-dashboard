import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: { allowedLogins: undefined as Set<string> | undefined, enterpriseSlugs: undefined as string[] | undefined, hasFilter: false },
  estimate: { count: 0, exceeds: false },
  modelBreakdown: [] as { model: string; interactions: number }[],
  modelByFeature: [] as { model: string; feature: string; interactions: number }[],
  modelTrend: [] as { day: string; model: string; interactions: number }[],
  modelByLanguage: [] as { model: string; language: string; interactions: number }[],
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  estimateRowCount: vi.fn(() => state.estimate),
  getModelBreakdown: vi.fn(() => state.modelBreakdown),
  getModelByFeatureBreakdown: vi.fn(() => state.modelByFeature),
  getModelTrend: vi.fn(() => state.modelTrend),
  getModelByLanguageBreakdown: vi.fn(() => state.modelByLanguage),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

beforeEach(() => {
  state.scope = { allowedLogins: undefined, enterpriseSlugs: undefined, hasFilter: false };
  state.estimate = { count: 0, exceeds: false };
  state.modelBreakdown = [];
  state.modelByFeature = [];
  state.modelTrend = [];
  state.modelByLanguage = [];
});

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/metrics/models", () => {
  it("returns a valid empty response when no data exists", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/models?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.modelBreakdown).toEqual([]);
    expect(json.modelByFeature).toEqual([]);
    expect(json.kpis).toEqual({ totalModels: 0, totalInteractions: 0, topModel: "N/A", topModelPct: 0 });
  });

  it("labels every feature in modelByFeature using FEATURE_LABELS, including copilot_app as 'Copilot App'", async () => {
    // Regression test: the models API's broad feature comparison must render
    // a friendly label for every raw feature name (per FEATURE_LABELS in
    // src/lib/constants.ts), not just the completion/agent features. In
    // particular, `copilot_app` rows must display as "Copilot App" rather
    // than falling back to the raw feature string.
    state.modelByFeature = [
      { model: "gpt-4o", feature: "copilot_app", interactions: 42 },
      { model: "gpt-4o", feature: "code_completion", interactions: 100 },
      { model: "gpt-4o", feature: "agent_edit", interactions: 12 },
      { model: "gpt-4o", feature: "some_future_feature", interactions: 3 },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/models?days=7"));
    const json = await res.json();

    expect(json.modelByFeature).toEqual([
      { model: "gpt-4o", feature: "copilot_app", interactions: 42, featureLabel: "Copilot App" },
      { model: "gpt-4o", feature: "code_completion", interactions: 100, featureLabel: "Code Completions" },
      { model: "gpt-4o", feature: "agent_edit", interactions: 12, featureLabel: "Agent Edit" },
      // Unknown features gracefully fall back to the raw feature string
      // rather than throwing or rendering `undefined`.
      { model: "gpt-4o", feature: "some_future_feature", interactions: 3, featureLabel: "some_future_feature" },
    ]);
  });

  it("rejects an oversized result set with a 400 before running model queries", async () => {
    state.estimate = { count: 999_999, exceeds: true };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/models?days=365"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Result set too large");
  });
});
