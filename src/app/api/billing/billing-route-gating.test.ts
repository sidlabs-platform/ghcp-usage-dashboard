import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
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
  getRepositoryBreakdown: vi.fn(() => []),
}));

vi.mock("@/lib/db/teams-repo", () => ({
  resolveFilteredUsers: vi.fn(() => []),
}));

const routeLoaders = {
  overview: () => import("./overview/route"),
  usage: () => import("./usage/route"),
  usageSummary: () => import("./usage/summary/route"),
  premium: () => import("./premium/route"),
  premiumSummary: () => import("./premium/summary/route"),
};

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("billing route gating", () => {
  it("uses enterprise-aware billing visibility for overview", async () => {
    const isMetricEnabledForAnyEnterprise = vi.fn(() => false);
    const isBillingSubEnabledForAnyEnterprise = vi.fn(() => true);
    const isMetricEnabled = vi.fn(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    vi.doMock("@/lib/config/enterprise-config", () => ({
      isMetricEnabledForAnyEnterprise,
      isBillingSubEnabledForAnyEnterprise,
    }));
    vi.doMock("@/lib/config/dashboard-config", () => ({ isMetricEnabled }));

    const { GET } = await routeLoaders.overview();
    const response = await GET(new NextRequest("http://localhost/api/billing/overview"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
    expect(isMetricEnabledForAnyEnterprise).toHaveBeenCalledWith("billing");
    expect(isBillingSubEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(isMetricEnabled).not.toHaveBeenCalled();
  });

  it("uses meteredUsage sub-toggle for usage routes", async () => {
    const isMetricEnabledForAnyEnterprise = vi.fn(() => true);
    const isBillingSubEnabledForAnyEnterprise = vi.fn(() => false);
    const isMetricEnabled = vi.fn(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    vi.doMock("@/lib/config/enterprise-config", () => ({
      isMetricEnabledForAnyEnterprise,
      isBillingSubEnabledForAnyEnterprise,
    }));
    vi.doMock("@/lib/config/dashboard-config", () => ({ isMetricEnabled }));

    for (const loadRoute of [routeLoaders.usage, routeLoaders.usageSummary]) {
      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/billing/usage"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ enabled: false });
    }

    expect(isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("meteredUsage");
    expect(isMetricEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(isMetricEnabled).not.toHaveBeenCalled();
  });

  it("uses premiumRequests sub-toggle for premium routes", async () => {
    const isMetricEnabledForAnyEnterprise = vi.fn(() => true);
    const isBillingSubEnabledForAnyEnterprise = vi.fn(() => false);
    const isMetricEnabled = vi.fn(() => {
      throw new Error("dashboard-config gating should not be used");
    });

    vi.doMock("@/lib/config/enterprise-config", () => ({
      isMetricEnabledForAnyEnterprise,
      isBillingSubEnabledForAnyEnterprise,
    }));
    vi.doMock("@/lib/config/dashboard-config", () => ({ isMetricEnabled }));

    for (const loadRoute of [routeLoaders.premium, routeLoaders.premiumSummary]) {
      const { GET } = await loadRoute();
      const response = await GET(new NextRequest("http://localhost/api/billing/premium"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ enabled: false });
    }

    expect(isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("premiumRequests");
    expect(isMetricEnabledForAnyEnterprise).not.toHaveBeenCalled();
    expect(isMetricEnabled).not.toHaveBeenCalled();
  });
});
