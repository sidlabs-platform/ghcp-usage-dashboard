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

vi.mock("@/lib/config/dashboard-config", () => ({
  isEnterpriseEnabled: vi.fn(() => true),
  isCopilotSubEnabled: vi.fn(() => true),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  getConfiguredEnterprises: vi.fn(() => [{ slug: "test-ent", displayName: "Test" }]),
  getResolvedOrgsForEnterprise: vi.fn(() => ["test-org"]),
}));

vi.mock("./enterprise-context", () => ({
  getEnterpriseContext: vi.fn(() => null),
  updateEnterpriseRegistry: vi.fn(),
}));

import { syncDay, syncSeats, syncTeams, fullSync } from "./sync-service";
import { isCopilotSubEnabled } from "@/lib/config/dashboard-config";

describe("sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isCopilotSubEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it("syncDay fetches enterprise, users and org data", async () => {
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(1);
    expect(result.users).toBe(1);
    expect(result.orgs["test-org"]).toBe(1);
  });

  it("syncSeats returns 0 when disabled", async () => {
    (isCopilotSubEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const result = await syncSeats();
    expect(result).toBe(0);
  });

  it("syncSeats fetches org seats when enabled", async () => {
    const result = await syncSeats();
    expect(result).toBe(1);
  });

  it("syncTeams returns 0 when disabled", async () => {
    (isCopilotSubEnabled as ReturnType<typeof vi.fn>)
      .mockImplementation((k: string) => k !== "teams");
    const result = await syncTeams();
    expect(result).toBe(0);
  });

  it("fullSync orchestrates backfill + seats + teams", async () => {
    const result = await fullSync();
    expect(result.enterprises).toHaveLength(1);
    expect(result.enterprises[0].enterpriseSlug).toBe("test-ent");
  });
});
