import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getPremiumUserSummary: vi.fn(),
  getPremiumModelSummary: vi.fn(),
  getPremiumDailyTrend: vi.fn(),
  getPremiumCostCenterBreakdown: vi.fn(),
  getPremiumOrgBreakdown: vi.fn(),
}));

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/utils", () => ({
  parseAndClampDays: vi.fn(() => ({ days: 28 })),
  getDateRange: vi.fn(() => ({ start: "2026-06-01", end: "2026-06-28" })),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
}));

vi.mock("@/lib/db/billing-repo", () => ({
  getPremiumUserSummary: (...a: unknown[]) => repoState.getPremiumUserSummary(...a),
  getPremiumModelSummary: (...a: unknown[]) => repoState.getPremiumModelSummary(...a),
  getPremiumDailyTrend: (...a: unknown[]) => repoState.getPremiumDailyTrend(...a),
  getPremiumCostCenterBreakdown: (...a: unknown[]) => repoState.getPremiumCostCenterBreakdown(...a),
  getPremiumOrgBreakdown: (...a: unknown[]) => repoState.getPremiumOrgBreakdown(...a),
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

import { GET } from "./route";
import { AI_CREDIT_COVERAGE_NOTE } from "@/lib/constants";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/billing/premium/summary?days=28");
}

beforeEach(() => {
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  repoState.getPremiumUserSummary.mockReturnValue([]);
  repoState.getPremiumModelSummary.mockReturnValue([]);
  repoState.getPremiumDailyTrend.mockReturnValue([]);
  repoState.getPremiumCostCenterBreakdown.mockReturnValue([]);
  repoState.getPremiumOrgBreakdown.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("premium summary route — AI credit attribution", () => {
  it("returns empty breakdowns and the coverage note when there is no data", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.enabled).toBe(true);
    expect(body.costCenterBreakdown).toEqual([]);
    expect(body.orgBreakdown).toEqual([]);
    expect(body.coverageNote).toEqual(AI_CREDIT_COVERAGE_NOTE);
    expect(body.coverageNote.effectiveDate).toBe("2026-07-02");
    expect(body.coverageNote.message).toContain("earlier periods may undercount");
  });

  it("passes through cost-center and org breakdowns including unattributed buckets", async () => {
    repoState.getPremiumCostCenterBreakdown.mockReturnValue([
      { cost_center_name: "engineering", total_aic_quantity: 150, total_aic_gross: 3, unique_users: 2, record_count: 2 },
      { cost_center_name: "", total_aic_quantity: 30, total_aic_gross: 0.5, unique_users: 1, record_count: 1 },
    ]);
    repoState.getPremiumOrgBreakdown.mockReturnValue([
      { organization: "org1", total_aic_quantity: 125, total_aic_gross: 2.5, unique_users: 2, record_count: 2 },
      { organization: "", total_aic_quantity: 70, total_aic_gross: 1.2, unique_users: 1, record_count: 1 },
    ]);

    const res = await GET(req());
    const body = await res.json();

    expect(body.costCenterBreakdown).toHaveLength(2);
    expect(body.costCenterBreakdown.some((c: { cost_center_name: string }) => c.cost_center_name === "")).toBe(true);
    expect(body.orgBreakdown).toHaveLength(2);
    expect(body.orgBreakdown.some((o: { organization: string }) => o.organization === "")).toBe(true);
  });

  it("returns enabled:false and skips repo queries when billing is disabled", async () => {
    configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
    expect(repoState.getPremiumCostCenterBreakdown).not.toHaveBeenCalled();
    expect(repoState.getPremiumOrgBreakdown).not.toHaveBeenCalled();
  });
});
