import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({
  withRateLimit: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => ({
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
    hasFilter: false,
    selectedTeams: [],
    selectedOrgs: [],
  })),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  countEffectiveEnterprises: vi.fn(() => 1),
  getAggregatedDailySummary: vi.fn(() => []),
  getAllOrgMetrics: vi.fn(() => []),
  getEnterpriseMetrics: vi.fn(() => []),
  getFilteredOrgMetrics: vi.fn(() => []),
  resolveEnterpriseId: vi.fn(() => "ent-1"),
}));

vi.mock("@/lib/db/seats-repo", () => ({
  getSeatStats: vi.fn(() => ({})),
}));

vi.mock("@/lib/db/database", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
    })),
  })),
}));

vi.mock("@/lib/aggregation/separate-metrics", () => ({
  extractCompletionMetrics: vi.fn(() => ({})),
  extractAgentMetrics: vi.fn(() => ({})),
  isCompletionFeature: vi.fn(() => false),
  isAgentFeature: vi.fn(() => false),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  estimateRowCount: vi.fn(() => ({ exceeds: false, count: 0 })),
  getActiveUsersDailyTrend: vi.fn(() => []),
  getActiveUsersRollingTrend: vi.fn(() => []),
  getAdoptionDailyTrend: vi.fn(() => []),
  getAdoptionStats: vi.fn(() => ({ totalUsers: 0, agentUsers: 0, chatUsers: 0, cliUsers: 0 })),
  getChatModeSums: vi.fn(() => []),
  getCliDailyVolume: vi.fn(() => []),
  getCliUserBreakdown: vi.fn(() => []),
  getCompletionDailyTrend: vi.fn(() => []),
  getCompletionTotals: vi.fn(() => ({
    day: "",
    completionSuggested: 0,
    completionAccepted: 0,
    completionDeleted: 0,
    completionSuggestedDelete: 0,
    agentAdded: 0,
    agentDeleted: 0,
    compGenCount: 0,
    compAcceptCount: 0,
    appAdded: 0,
    appDeleted: 0,
    appGenCount: 0,
    appAcceptCount: 0,
  })),
  getFeatureBreakdown: vi.fn(() => []),
  getFeatureDailyTrend: vi.fn(() => []),
  getFeatureUsageDaily: vi.fn(() => []),
  getIdeBreakdown: vi.fn(() => []),
  getIdeTrend: vi.fn(() => []),
  getLanguageBreakdown: vi.fn(() => []),
  getLanguageByFeatureBreakdown: vi.fn(() => []),
  getModelBreakdown: vi.fn(() => []),
  getModelByFeatureBreakdown: vi.fn(() => []),
  getModelByLanguageBreakdown: vi.fn(() => []),
  getModelTrend: vi.fn(() => []),
}));

vi.mock("@/lib/db/copilot-app-queries", () => ({
  estimateCopilotAppRowCount: vi.fn(() => ({ exceeds: false, count: 0 })),
  getCopilotAppUserSummary: vi.fn(() => ({
    periodActiveUsers: 0,
    appActiveUsers: 0,
    adoptionRate: 0,
    sessions: 0,
    requests: 0,
    prompts: 0,
    promptTokens: 0,
    outputTokens: 0,
    avgTokensPerRequest: 0,
    codeGenerations: 0,
    codeAcceptances: 0,
    locAdded: 0,
    locDeleted: 0,
    locChanged: 0,
    supportedRows: 0,
  })),
  getCopilotAppDailyUsage: vi.fn(() => []),
  getCopilotAppDailyCodeImpact: vi.fn(() => []),
  getCopilotAppModelBreakdown: vi.fn(() => []),
  getCopilotAppLanguageBreakdown: vi.fn(() => []),
  getEnterpriseCopilotAppDaily: vi.fn(() => []),
  getOrganizationCopilotAppDaily: vi.fn(() => []),
  getCopilotAppAdopters: vi.fn(() => ({ adopters: [], total: 0 })),
}));

const routeLoaders = [
  { name: "chat modes", load: () => import("./chat-modes/route") },
  { name: "CLI", load: () => import("./cli/route") },
  { name: "code generation", load: () => import("./code-generation/route") },
  { name: "IDE languages", load: () => import("./ide-languages/route") },
  { name: "models", load: () => import("./models/route") },
  { name: "overview", load: () => import("./overview/route") },
  { name: "pull requests", load: () => import("./pull-requests/route") },
  { name: "adoption cohorts", load: () => import("./adoption-cohorts/route") },
  { name: "Copilot App", load: () => import("./copilot-app/route") },
  { name: "Copilot App adopters", load: () => import("./copilot-app/adopters/route") },
];

afterEach(() => {
  vi.clearAllMocks();
});

const routeModulesPromise = Promise.all(
  routeLoaders.map(async ({ name, load }) => ({
    name,
    route: await load(),
  })),
);

async function getRouteHandler(name: string) {
  const loadedRoutes = await routeModulesPromise;
  const match = loadedRoutes.find((entry) => entry.name === name);
  if (!match) throw new Error(`Unknown route: ${name}`);
  return match.route.GET;
}

describe("metrics route validation", { timeout: 10000 }, () => {
  it.each(routeLoaders)("rejects non-positive days for $name", async ({ name }) => {
    const GET = await getRouteHandler(name);

    const response = await GET(new NextRequest("http://localhost/api/metrics/test?days=0"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid days parameter"),
    });
  });

  it.each(routeLoaders)("rejects oversized days for $name", async ({ name }) => {
    const GET = await getRouteHandler(name);

    const response = await GET(new NextRequest("http://localhost/api/metrics/test?days=999"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("days parameter exceeds maximum allowed value"),
    });
  });
});
