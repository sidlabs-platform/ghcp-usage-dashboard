import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: { allowedLogins: undefined as Set<string> | undefined, enterpriseSlugs: undefined as string[] | undefined, hasFilter: false },
  effectiveEnterprises: 1,
  enterpriseId: null as string | null,
  enterpriseRecords: [] as unknown[],
  aggregated: [] as unknown[],
  activeUsersTrend: [] as unknown[],
  cliDailyVolume: [] as unknown[],
  cliUsers: [] as unknown[],
  cliSuggestion: { locSuggestedAdd: 0, locSuggestedDelete: 0, locAdded: 0, locDeleted: 0, acceptanceRate: 0 },
  cliVersions: [] as { version: string; users: number }[],
  outdated: 0,
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  resolveEnterpriseId: vi.fn(() => state.enterpriseId),
  getEnterpriseMetrics: vi.fn(() => state.enterpriseRecords),
  getAggregatedDailySummary: vi.fn(() => state.aggregated),
  countEffectiveEnterprises: vi.fn(() => state.effectiveEnterprises),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  getActiveUsersDailyTrend: vi.fn(() => state.activeUsersTrend),
  getCliDailyVolume: vi.fn(() => state.cliDailyVolume),
  getCliUserBreakdown: vi.fn(() => state.cliUsers),
  getCliSuggestionStats: vi.fn(() => state.cliSuggestion),
  getCliVersionBreakdown: vi.fn(() => state.cliVersions),
  countOutdatedCliUsers: vi.fn(() => state.outdated),
  MIN_RELIABLE_CLI_VERSION: "1.0.64",
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

beforeEach(() => {
  state.scope = { allowedLogins: undefined, enterpriseSlugs: undefined, hasFilter: false };
  state.effectiveEnterprises = 1;
  state.enterpriseId = null;
  state.enterpriseRecords = [];
  state.aggregated = [];
  state.activeUsersTrend = [];
  state.cliDailyVolume = [];
  state.cliUsers = [];
  state.cliSuggestion = { locSuggestedAdd: 0, locSuggestedDelete: 0, locAdded: 0, locDeleted: 0, acceptanceRate: 0 };
  state.cliVersions = [];
  state.outdated = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/metrics/cli", () => {
  it("returns valid empty response including new keys when no data exists", async () => {
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/cli?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.cliSuggestion).toEqual({ locSuggestedAdd: 0, locSuggestedDelete: 0, locAdded: 0, locDeleted: 0, acceptanceRate: 0 });
    expect(json.cliVersions).toEqual([]);
    expect(json.outdatedCliUsers).toBe(0);
    expect(json.minReliableCliVersion).toBe("1.0.64");
  });

  it("surfaces suggestion stats, versions and outdated count", async () => {
    state.cliSuggestion = { locSuggestedAdd: 200, locSuggestedDelete: 10, locAdded: 60, locDeleted: 3, acceptanceRate: 30 };
    state.cliVersions = [
      { version: "1.0.70", users: 5 },
      { version: "1.0.60", users: 3 },
    ];
    state.outdated = 3;
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/cli?days=28"));
    const json = await res.json();
    expect(json.cliSuggestion.acceptanceRate).toBe(30);
    expect(json.cliSuggestion.locSuggestedAdd).toBe(200);
    expect(json.cliVersions).toHaveLength(2);
    expect(json.outdatedCliUsers).toBe(3);
    expect(json.minReliableCliVersion).toBe("1.0.64");
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("returns 400 for invalid days", async () => {
    const GET = await getHandler();
    const res = await GET(new Request("http://localhost/api/metrics/cli?days=abc"));
    expect(res.status).toBe(400);
  });

  it("queries the explicit window when startDate/endDate are supplied", async () => {
    const { getCliDailyVolume } = await import("@/lib/db/aggregation-queries");
    const GET = await getHandler();
    const res = await GET(
      new Request("http://localhost/api/metrics/cli?startDate=2026-03-01&endDate=2026-03-31"),
    );

    expect(res.status).toBe(200);
    // Month mode sends bounds and no `days`; resolving them as a rolling window
    // would silently query a different month.
    expect(getCliDailyVolume).toHaveBeenCalledWith("2026-03-01", "2026-03-31", undefined, undefined);
  });

  it("returns 400 for an inverted explicit window", async () => {
    const GET = await getHandler();
    const res = await GET(
      new Request("http://localhost/api/metrics/cli?startDate=2026-03-31&endDate=2026-03-01"),
    );
    expect(res.status).toBe(400);
  });
});
