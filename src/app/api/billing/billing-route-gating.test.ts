import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  isMetricEnabledForAnyEnterprise: vi.fn(),
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  isMetricEnabled: vi.fn(),
}));

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

vi.mock("@/lib/utils", () => ({
  parseAndClampDays: vi.fn(() => ({ days: 28 })),
  getDateRange: vi.fn(() => ({ start: "2024-01-01", end: "2024-01-28" })),
}));

vi.mock("@/lib/db/billing-repo", () => ({
  getOverviewKPIs: vi.fn(() => ({})),
  getDailyAggregates: vi.fn(() => []),
  getProductBreakdown: vi.fn(() => []),
  getOrgBreakdown: vi.fn(() => []),
  getUserBreakdown: vi.fn(() => []),
  getCostCenterBreakdown: vi.fn(() => []),
  getUsageRecordsPaginated: vi.fn(() => ({ records: [], total: 0 })),
  getUsageFilterOptions: vi.fn(() => ({})),
  getPremiumRequestsPaginated: vi.fn(() => ({ records: [], total: 0 })),
  getPremiumFilterOptions: vi.fn(() => ({})),
  getPremiumUserSummary: vi.fn(() => []),
  getPremiumModelSummary: vi.fn(() => []),
  getPremiumDailyTrend: vi.fn(() => []),
  getPremiumCostCenterBreakdown: vi.fn(() => []),
  getPremiumOrgBreakdown: vi.fn(() => []),
  getRepositoryBreakdown: vi.fn(() => []),
}));

vi.mock("@/lib/db/teams-repo", () => ({
  resolveFilteredUsers: vi.fn(() => []),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  getUserAiCreditsSummary: vi.fn(() => []),
  getUserAiCreditsTotals: vi.fn(() => ({
    total_ai_credits_used: 0,
    tracked_users: 0,
    top_user_login: null,
  })),
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => ({
    enterpriseSlugs: undefined,
    allowedLogins: undefined,
    selectedOrgs: [],
  })),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  isMetricEnabledForAnyEnterprise: (...args: unknown[]) =>
    mockState.isMetricEnabledForAnyEnterprise(...args),
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    mockState.isBillingSubEnabledForAnyEnterprise(...args),
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  isMetricEnabled: (...args: unknown[]) => mockState.isMetricEnabled(...args),
}));

const routeModules = {
  overview: import("./overview/route"),
  usage: import("./usage/route"),
  usageSummary: import("./usage/summary/route"),
  premium: import("./premium/route"),
  premiumSummary: import("./premium/summary/route"),
};

beforeEach(() => {
  mockState.isMetricEnabledForAnyEnterprise.mockImplementation(() => true);
  mockState.isBillingSubEnabledForAnyEnterprise.mockImplementation(() => true);
  mockState.isMetricEnabled.mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("billing route gating", { timeout: 10000 }, () => {
  it("uses enterprise-aware billing visibility for overview", async () => {
    mockState.isMetricEnabledForAnyEnterprise.mockImplementation(() => false);
    mockState.isBillingSubEnabledForAnyEnterprise.mockImplementation(() => true);
    mockState.isMetricEnabled.mockImplementation(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    const { GET } = await routeModules.overview;
    const response = await GET(new NextRequest("http://localhost/api/billing/overview"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
    expect(mockState.isMetricEnabledForAnyEnterprise).toHaveBeenCalledWith("billing");
    expect(mockState.isBillingSubEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(mockState.isMetricEnabled).not.toHaveBeenCalled();
  });

  it("uses meteredUsage sub-toggle for usage routes", async () => {
    mockState.isMetricEnabledForAnyEnterprise.mockImplementation(() => true);
    mockState.isBillingSubEnabledForAnyEnterprise.mockImplementation(() => false);
    mockState.isMetricEnabled.mockImplementation(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    for (const routePromise of [routeModules.usage, routeModules.usageSummary]) {
      const { GET } = await routePromise;
      const response = await GET(new NextRequest("http://localhost/api/billing/usage"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ enabled: false });
    }

    expect(mockState.isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("meteredUsage");
    expect(mockState.isMetricEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(mockState.isMetricEnabled).not.toHaveBeenCalled();
  });

  it("uses premiumRequests sub-toggle for premium routes", async () => {
    mockState.isMetricEnabledForAnyEnterprise.mockImplementation(() => true);
    mockState.isBillingSubEnabledForAnyEnterprise.mockImplementation(() => false);
    mockState.isMetricEnabled.mockImplementation(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    for (const routePromise of [routeModules.premium, routeModules.premiumSummary]) {
      const { GET } = await routePromise;
      const response = await GET(new NextRequest("http://localhost/api/billing/premium"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ enabled: false });
    }

    expect(mockState.isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("premiumRequests");
    expect(mockState.isMetricEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(mockState.isMetricEnabled).not.toHaveBeenCalled();
  });
});
