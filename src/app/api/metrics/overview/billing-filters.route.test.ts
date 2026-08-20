import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const billingState = vi.hoisted(() => ({
  getOverviewKPIs: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/utils", () => ({
  parseAndClampDays: () => ({ days: 1 }),
  getDateRange: () => ({ start: "2026-07-01", end: "2026-07-01" }),
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: () => ({
    selectedTeams: [],
    selectedOrgs: ["octo-org"],
    selectedEnterprises: ["ent1"],
    hasFilter: true,
    allowedLogins: undefined,
    enterpriseSlugs: ["ent1"],
  }),
}));

vi.mock("@/lib/db/database", () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => ({ total: 0 }),
    }),
  }),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  getEnterpriseMetrics: () => [],
  getAggregatedDailySummary: () => [],
  resolveEnterpriseId: () => null,
  countEffectiveEnterprises: () => 1,
}));

vi.mock("@/lib/db/seats-repo", () => ({
  getSeatStats: () => ({ total: 0, active30d: 0, inactive30d: 0 }),
}));

vi.mock("@/lib/db/aggregation-queries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/aggregation-queries")>(
    "@/lib/db/aggregation-queries",
  );
  return {
    buildLoginFilter: actual.buildLoginFilter,
    buildEnterpriseFilter: actual.buildEnterpriseFilter,
    estimateRowCount: () => ({ count: 0, exceeds: false }),
    getFeatureUsageDaily: () => [],
    getActiveUsersDailyTrend: () => [],
    getActiveUsersRollingTrend: () => [
      { day: "2026-07-01", daily: 0, weekly: 0, monthly: 0, cliUsers: 0 },
    ],
    getCompletionDailyTrend: () => [],
    getChatModeSums: () => ({ ask: 0, edit: 0, plan: 0, agent: 0, custom: 0, unknown: 0 }),
    getAdoptionStats: () => ({
      totalUsers: 0,
      agentUsers: 0,
      codingAgentUsers: 0,
      codeReviewUsers: 0,
      cliUsers: 0,
      chatUsers: 0,
      appUsers: 0,
    }),
    getCompletionTotals: () => ({
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
    }),
  };
});

vi.mock("@/lib/db/billing-repo", () => ({
  getOverviewKPIs: (...a: unknown[]) => billingState.getOverviewKPIs(...a),
}));

import { GET } from "./route";

beforeEach(() => {
  billingState.getOverviewKPIs.mockReset();
  billingState.getOverviewKPIs.mockReturnValue({
    totalNet: 0,
    totalGross: 0,
    totalDiscount: 0,
    uniqueProducts: 0,
    uniqueOrgs: 0,
    userChargesNet: 0,
    orgChargesNet: 0,
  });
});

describe("overview route billing filters", () => {
  it("preserves an undefined user allowlist when only org scope is available", async () => {
    const res = await GET(new NextRequest("http://localhost/api/metrics/overview?days=1&orgs=octo-org&enterprises=ent1"));

    expect(res.status).toBe(200);
    expect(billingState.getOverviewKPIs).toHaveBeenCalledWith(
      "2026-07-01",
      "2026-07-01",
      { allowedLogins: undefined, scopeOrgs: ["octo-org"] },
      ["ent1"],
    );
  });
});
