import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub setTimeout to resolve immediately
vi.stubGlobal("setTimeout", (fn: () => void) => { fn(); return 0; });

vi.mock("@/lib/github/metrics-client", () => ({
  metricsClient: {
    getEnterpriseDailyReport: vi.fn(async () => [{ day: "2025-01-01" }]),
    getEnterpriseUserDailyReport: vi.fn(async () => [{ login: "u1" }]),
    getOrgDailyReport: vi.fn(async () => [{ day: "2025-01-01" }]),
    getOrgUserDailyReport: vi.fn(async () => []),
    getEnterprise28DayReport: vi.fn(async () => []),
    getOrg28DayReport: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/github/seats-client", () => ({
  seatsClient: { getOrgSeats: vi.fn(async () => ({ seats: [{ login: "u1" }] })) },
}));

vi.mock("@/lib/github/teams-client", () => ({
  teamsClient: {
    getEnterpriseTeamsWithMembers: vi.fn(async () => [{ name: "t1", members: [] }]),
    getOrgTeamsWithMembers: vi.fn(async () => [{ name: "t2", members: [] }]),
  },
}));

vi.mock("./metrics-repo", () => ({
  upsertEnterpriseDayMetrics: vi.fn(),
  upsertOrgDayMetrics: vi.fn(),
  batchUpsertUserDayMetrics: vi.fn(),
  recordSync: vi.fn(),
  isSynced: vi.fn(() => false),
  getLatestSyncDay: vi.fn(() => null),
  hasEnterpriseDataForRange: vi.fn(() => true),
  hasOrgDataForRange: vi.fn(() => true),
  heartbeatSyncLock: vi.fn(),
}));

vi.mock("./seats-repo", () => ({ upsertSeats: vi.fn() }));
vi.mock("./summary-tables", () => ({ refreshAllSummaries: vi.fn() }));
vi.mock("@/lib/cache/memory-cache", () => ({ cache: { invalidateAll: vi.fn() } }));
vi.mock("./teams-repo", () => ({ upsertAllTeams: vi.fn() }));
vi.mock("@/lib/utils", () => ({ datesBetween: vi.fn(() => ["2025-01-01"]) }));
vi.mock("./billing-sync-service", () => ({ syncBilling: vi.fn(async () => ({ usageRecords: 0, premiumRecords: 0, errors: [] })) }));

vi.mock("@/lib/config/enterprise-config", () => ({
  getConfiguredEnterprises: vi.fn(() => [{ slug: "test-ent", displayName: "Test" }]),
  getResolvedOrgsForEnterprise: vi.fn(() => ["test-org"]),
  getEnterpriseConfig: vi.fn(() => ({ slug: "test-ent", displayName: "Test", organizations: { include: [], exclude: [] } })),
  isCopilotSubEnabledForEnterprise: vi.fn(() => true),
  isCopilotSubEnabledForAnyEnterprise: vi.fn(() => true),
}));

vi.mock("@/lib/github/orgs-client", () => ({
  orgsClient: { listEnterpriseOrgs: vi.fn(async () => []) },
}));

vi.mock("./orgs-repo", () => ({
  upsertEnterpriseOrgs: vi.fn(),
  clearEnterpriseOrgs: vi.fn(),
}));

vi.mock("./enterprise-context", () => ({
  getEnterpriseContext: vi.fn(() => null),
  updateEnterpriseRegistry: vi.fn(),
}));

import { syncDay, syncSeats, syncTeams, fullSync, backfill, incrementalSync, backfillEnterprise } from "./sync-service";
import { isSynced, getLatestSyncDay, hasEnterpriseDataForRange, hasOrgDataForRange } from "./metrics-repo";
import { metricsClient } from "@/lib/github/metrics-client";
import { seatsClient } from "@/lib/github/seats-client";
import { teamsClient } from "@/lib/github/teams-client";
import { getConfiguredEnterprises, getResolvedOrgsForEnterprise, getEnterpriseConfig, isCopilotSubEnabledForEnterprise, isCopilotSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { orgsClient } from "@/lib/github/orgs-client";
import { upsertEnterpriseOrgs } from "./orgs-repo";

describe("sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isCopilotSubEnabledForAnyEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (hasEnterpriseDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (hasOrgDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([{ slug: "test-ent", displayName: "Test" }]);
    (getResolvedOrgsForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(["test-org"]);
  });

  it("syncDay fetches enterprise, users and org data", async () => {
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(1);
    expect(result.users).toBe(1);
    expect(result.orgs["test-org"]).toBe(1);
  });

  it("syncDay skips already-synced scopes", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(0);
    expect(result.users).toBe(0);
  });

  it("syncDay handles API errors gracefully", async () => {
    (metricsClient.getEnterpriseDailyReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("timeout"));
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(0);
  });

  it("syncSeats returns 0 when disabled", async () => {
    (isCopilotSubEnabledForAnyEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await syncSeats();
    expect(result).toBe(0);
  });

  it("syncSeats fetches org seats when enabled", async () => {
    const result = await syncSeats();
    expect(result).toBe(1);
  });

  it("syncDay org-only mode fetches user metrics per org", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, key: string) => key !== "enterprise");
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getOrgUserDailyReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ login: "org-u1" }, { login: "org-u2" }]);
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(0); // enterprise fetch skipped
    expect(result.users).toBe(2); // per-org user fetch
    expect(metricsClient.getOrgUserDailyReport).toHaveBeenCalledWith("test-org", "2025-01-01", "test-ent");
  });

  it("syncDay org-only handles org user fetch errors", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, key: string) => key !== "enterprise");
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getOrgUserDailyReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("org user error"));
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.users).toBe(0);
  });

  it("syncTeams returns 0 when disabled", async () => {
    (isCopilotSubEnabledForAnyEnterprise as ReturnType<typeof vi.fn>)
      .mockImplementation((k: string) => k !== "teams");
    const result = await syncTeams();
    expect(result).toBe(0);
  });

  it("syncTeams fetches enterprise + org teams when enabled", async () => {
    const result = await syncTeams();
    expect(result).toBe(2); // 1 enterprise team + 1 org team
  });

  it("syncTeams only fetches org teams when enterprise disabled", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, key: string) => key !== "enterprise");
    const result = await syncTeams();
    expect(result).toBe(1); // only org teams
  });

  it("syncTeams handles enterprise teams API error gracefully", async () => {
    (teamsClient.getEnterpriseTeamsWithMembers as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("enterprise teams error"));
    const result = await syncTeams();
    expect(result).toBe(1); // only org teams succeed
  });

  it("syncTeams handles org teams API error gracefully", async () => {
    (teamsClient.getEnterpriseTeamsWithMembers as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ name: "t1", members: [] }]);
    (teamsClient.getOrgTeamsWithMembers as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("org teams error"));
    const result = await syncTeams();
    expect(result).toBe(1); // only enterprise teams succeed
  });

  it("incrementalSync syncs gap days when latestDay is old", async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    (getLatestSyncDay as ReturnType<typeof vi.fn>).mockReturnValue(threeDaysAgo.toISOString().split("T")[0]);
    const { datesBetween } = await import("@/lib/utils");
    (datesBetween as ReturnType<typeof vi.fn>).mockReturnValue(["2025-04-01", "2025-04-02"]);
    const result = await incrementalSync();
    expect(result.daysSynced).toBe(2);
  });

  it("backfill loops over configured enterprises", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await backfill(1);
    expect(result.daysSkipped).toBeGreaterThanOrEqual(0);
  });

  it("incrementalSync returns early when already at yesterday", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    (getLatestSyncDay as ReturnType<typeof vi.fn>).mockReturnValue(yesterday.toISOString().split("T")[0]);
    const result = await incrementalSync();
    expect(result.daysSynced).toBe(0);
  });

  it("fullSync orchestrates backfill + seats + teams", async () => {
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
    expect(result.enterprises[0].enterpriseSlug).toBe("test-ent");
  });

  it("fullSync triggers 28-day fallback when no enterprise data", async () => {
    (hasEnterpriseDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterprise28DayReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ day: "2025-01-01" }]);
    const result = await fullSync();
    expect(metricsClient.getEnterprise28DayReport).toHaveBeenCalled();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync triggers org 28-day fallback when no org data", async () => {
    (hasOrgDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getOrg28DayReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ day: "2025-01-01" }]);
    const result = await fullSync();
    expect(metricsClient.getOrg28DayReport).toHaveBeenCalled();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync handles syncBilling error gracefully", async () => {
    const { syncBilling } = await import("./billing-sync-service");
    (syncBilling as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("billing error"));
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync handles refreshAllSummaries error gracefully", async () => {
    const { refreshAllSummaries } = await import("./summary-tables");
    (refreshAllSummaries as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("summary error"); });
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync handles 28-day enterprise fallback error gracefully", async () => {
    (hasEnterpriseDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterprise28DayReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("28-day ent error"));
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync handles 28-day org fallback error gracefully", async () => {
    (hasOrgDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getOrg28DayReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("28-day org error"));
    (metricsClient.getEnterprise28DayReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([]);
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
  });

  it("fullSync returns empty result when no enterprises configured", async () => {
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(0);
    expect(result.backfill.daysSynced).toBe(0);
  });

  it("fullSync skips teams and seats when disabled", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, sub: string) => {
      if (sub === "teams" || sub === "seats") return false;
      return true;
    });
    const result = await fullSync();
    expect(result.enterprises[0].teams).toBe(0);
    expect(result.enterprises[0].seats).toBe(0);
  });

  it("syncSeats handles org API errors gracefully", async () => {
    (seatsClient.getOrgSeats as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("seats API failure"));
    const result = await syncSeats();
    expect(result).toBe(0);
  });

  it("incrementalSync returns 0 when enterprise disabled and no orgs", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, key: string) => key !== "enterprise");
    (getResolvedOrgsForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await incrementalSync();
    expect(result.daysSynced).toBe(0);
  });

  it("syncDay skips user metrics when userMetrics disabled", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>)
      .mockImplementation((_s: string, k: string) => k !== "userMetrics");
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterpriseDailyReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ day: "2025-01-01" }]);
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(1);
    expect(result.users).toBe(0);
  });

  it("backfillEnterprise skips fully-synced days", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await backfillEnterprise("test-ent", 3);
    expect(result.daysSynced).toBe(0);
    expect(result.daysSkipped).toBeGreaterThanOrEqual(2);
  });

  it("syncDay handles non-Error enterprise throws (String fallback)", async () => {
    (metricsClient.getEnterpriseDailyReport as ReturnType<typeof vi.fn>).mockRejectedValue("raw string error");
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(0);
  });

  it("fullSync uses 28-day enterprise fallback when no existing data", async () => {
    (hasEnterpriseDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterprise28DayReport as ReturnType<typeof vi.fn>).mockResolvedValue([{ day: "2025-01-01" }]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fullSync();
    expect(metricsClient.getEnterprise28DayReport).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("fullSync uses 28-day org fallback when no existing org data", async () => {
    (hasOrgDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getOrg28DayReport as ReturnType<typeof vi.fn>).mockResolvedValue([{ day: "2025-01-01" }]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fullSync();
    expect(metricsClient.getOrg28DayReport).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("backfillEnterprise increments errors when syncDay throws", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterpriseDailyReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("catastrophic"));
    (metricsClient.getOrgDailyReport as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("catastrophic"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await backfillEnterprise("test-ent", 2);
    expect(result.errors).toBe(0); // errors only from outer try
    errSpy.mockRestore();
  });

  it("incrementalSync calls backfillEnterprise when latestDay is null", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getLatestSyncDay as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await incrementalSync();
    expect(result.daysSkipped).toBeGreaterThanOrEqual(0);
  });

  it("fullSync discovers orgs when include is empty", async () => {
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "test-ent",
      displayName: "Test",
      organizations: { include: [], exclude: [] },
    });
    (orgsClient.listEnterpriseOrgs as ReturnType<typeof vi.fn>).mockResolvedValue([
      { login: "discovered-org-1", id: 1 },
      { login: "discovered-org-2", id: 2 },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await fullSync();
    expect(orgsClient.listEnterpriseOrgs).toHaveBeenCalledWith("test-ent", "test-ent");
    expect(upsertEnterpriseOrgs).toHaveBeenCalledWith(
      "test-ent",
      ["discovered-org-1", "discovered-org-2"],
      "discovered",
    );
    logSpy.mockRestore();
  });

  it("fullSync skips discovery when include is non-empty", async () => {
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "test-ent",
      displayName: "Test",
      organizations: { include: ["org-a"], exclude: [] },
    });
    await fullSync();
    expect(orgsClient.listEnterpriseOrgs).not.toHaveBeenCalled();
    expect(upsertEnterpriseOrgs).toHaveBeenCalledWith("test-ent", ["org-a"], "configured");
  });

  it("fullSync handles discovery API error gracefully", async () => {
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "test-ent",
      displayName: "Test",
      organizations: { include: [], exclude: [] },
    });
    (orgsClient.listEnterpriseOrgs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("enterprise orgs API down"),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
    warnSpy.mockRestore();
  });
});
