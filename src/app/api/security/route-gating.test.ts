import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  isMetricEnabled: vi.fn(),
  isEnterpriseEnabled: vi.fn(),
  getResolvedOrgs: vi.fn(),
  resolveDefaultScope: vi.fn(),
  fullGhasSync: vi.fn(),
  getAllGhasSyncStates: vi.fn(),
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  isMetricEnabled: (...args: unknown[]) => mockState.isMetricEnabled(...args),
  isEnterpriseEnabled: (...args: unknown[]) => mockState.isEnterpriseEnabled(...args),
  getResolvedOrgs: (...args: unknown[]) => mockState.getResolvedOrgs(...args),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  resolveDefaultScope: (...args: unknown[]) => mockState.resolveDefaultScope(...args),
}));

vi.mock("@/lib/db/ghas-sync-service", () => ({
  fullGhasSync: (...args: unknown[]) => mockState.fullGhasSync(...args),
}));

vi.mock("@/lib/db/ghas-repo", () => ({
  getCodeScanningDaily: vi.fn(() => []),
  getDependabotDaily: vi.fn(() => []),
  getSecretScanningDaily: vi.fn(() => []),
  getSecurityOverview: vi.fn(() => ({})),
  computeMTTR: vi.fn(() => null),
  getAllGhasSyncStates: (...args: unknown[]) => mockState.getAllGhasSyncStates(...args),
}));

vi.mock("@/lib/aggregation/ghas-aggregation", () => ({
  computeFixRate: vi.fn(() => 0),
  computeAutofixAdoption: vi.fn(() => 0),
  computeTrendDirection: vi.fn(() => "flat"),
  getSeverityDistribution: vi.fn(() => []),
  getTopEcosystems: vi.fn(() => []),
  computeSecuritySummary: vi.fn(() => ({})),
  formatMTTR: vi.fn(() => "N/A"),
}));

const gatedRouteLoaders = [
  { name: "code scanning", route: import("./code-scanning/route"), metric: "codeScanning" },
  { name: "dependabot", route: import("./dependabot/route"), metric: "dependabot" },
  { name: "secret scanning", route: import("./secret-scanning/route"), metric: "secretScanning" },
] as const;

const overviewRoutePromise = import("./overview/route");
const syncRoutePromise = import("./sync/route");

beforeEach(() => {
  mockState.isMetricEnabled.mockImplementation(() => true);
  mockState.isEnterpriseEnabled.mockImplementation(() => false);
  mockState.getResolvedOrgs.mockReturnValue(["platform"]);
  mockState.resolveDefaultScope.mockReturnValue({ scope: "org", scopeId: "platform" });
  mockState.fullGhasSync.mockImplementation(async () => ({ synced: 0 }));
  mockState.getAllGhasSyncStates.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("security route gating", { timeout: 10000 }, () => {
  it.each(gatedRouteLoaders)("returns enabled=false when $name is disabled", async ({ route, metric }) => {
    mockState.isMetricEnabled.mockImplementation(() => false);

    const { GET } = await route;
    const response = await GET(new NextRequest("http://localhost/api/security/test"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false, data: [] });
    expect(mockState.isMetricEnabled).toHaveBeenCalledWith(metric);
    expect(mockState.isEnterpriseEnabled).not.toHaveBeenCalled();
  });

  it("validates days before resolving security overview scope", async () => {
    const { GET } = await overviewRoutePromise;
    const response = await GET(new NextRequest("http://localhost/api/security/overview?days=0"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid days parameter"),
    });
    expect(mockState.isEnterpriseEnabled).not.toHaveBeenCalled();
  });

  it("starts GHAS sync in the background and reports aggregated sync state", async () => {
    mockState.fullGhasSync.mockImplementation(async (onProgress: (progress: { message: string }) => void) => {
      onProgress({ message: "Syncing alerts" });
      return { synced: 12 };
    });
    mockState.getAllGhasSyncStates.mockReturnValue([
      { enterprise_slug: "ent-a", status: "syncing" },
      { enterprise_slug: "ent-b", status: "completed" },
    ]);

    const route = await syncRoutePromise;
    const postResponse = await route.POST();
    const getResponse = await route.GET();

    await expect(postResponse.json()).resolves.toMatchObject({
      success: true,
      message: expect.stringContaining("GHAS sync started"),
    });
    await expect(getResponse.json()).resolves.toEqual({
      syncing: true,
      states: [
        { enterprise_slug: "ent-a", status: "syncing" },
        { enterprise_slug: "ent-b", status: "completed" },
      ],
    });
    expect(mockState.fullGhasSync).toHaveBeenCalledTimes(1);
    expect(mockState.getAllGhasSyncStates).toHaveBeenCalledTimes(1);
  });
});
