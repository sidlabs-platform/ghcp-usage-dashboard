import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: { allowedLogins: undefined as Set<string> | undefined, enterpriseSlugs: undefined as string[] | undefined, hasFilter: false },
  estimate: { exceeds: false, count: 0 },
  ideBreakdown: [] as unknown[],
  ideTrend: [] as unknown[],
  langByFeature: [] as unknown[],
  ideVersions: [] as unknown[],
  pluginVersions: [] as unknown[],
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  estimateRowCount: vi.fn(() => state.estimate),
  getIdeBreakdown: vi.fn(() => state.ideBreakdown),
  getIdeTrend: vi.fn(() => state.ideTrend),
  getLanguageByFeatureBreakdown: vi.fn(() => state.langByFeature),
  getIdeVersionBreakdown: vi.fn(() => state.ideVersions),
  getPluginVersionBreakdown: vi.fn(() => state.pluginVersions),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

beforeEach(() => {
  state.scope = { allowedLogins: undefined, enterpriseSlugs: undefined, hasFilter: false };
  state.estimate = { exceeds: false, count: 0 };
  state.ideBreakdown = [];
  state.ideTrend = [];
  state.langByFeature = [];
  state.ideVersions = [];
  state.pluginVersions = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/metrics/ide-languages", () => {
  it("returns valid empty response when no data exists", async () => {
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/ide-languages?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ideDistribution).toEqual([]);
    expect(json.languageDistribution).toEqual([]);
    expect(json.ideVersions).toEqual([]);
    expect(json.pluginVersions).toEqual([]);
    expect(json.allIdes).toEqual([]);
  });

  it("passes suggested LoC through ideDistribution and includes version keys", async () => {
    state.ideBreakdown = [
      { ide: "vscode", locAdded: 100, locDeleted: 5, locSuggestedAdd: 250, locSuggestedDelete: 12, interactions: 40, generations: 30, acceptances: 20 },
    ];
    state.ideVersions = [{ version: "1.90.0", users: 3 }];
    state.pluginVersions = [{ plugin: "copilot", version: "1.2.3", users: 3 }];
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/ide-languages?days=7"));
    const json = await res.json();
    expect(json.ideDistribution[0]).toMatchObject({
      name: "vscode",
      locSuggestedAdd: 250,
      locSuggestedDelete: 12,
    });
    expect(json.ideVersions).toEqual([{ version: "1.90.0", users: 3 }]);
    expect(json.pluginVersions).toEqual([{ plugin: "copilot", version: "1.2.3", users: 3 }]);
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("returns 400 when the row-count guard is exceeded", async () => {
    state.estimate = { exceeds: true, count: 999999 };
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/ide-languages?days=90"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid days", async () => {
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/ide-languages?days=-5"));
    expect(res.status).toBe(400);
  });
});
