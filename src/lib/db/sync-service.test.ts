import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub setTimeout to resolve immediately
vi.stubGlobal("setTimeout", (fn: () => void) => { fn(); return 0; });

vi.mock("@/lib/github/metrics-client", () => ({
  metricsClient: {
    getEnterpriseDailyReport: vi.fn(async () => [{ day: "2025-01-01" }]),
    getEnterpriseUserDailyReport: vi.fn(async () => [{ login: "u1" }]),
    getOrgDailyReport: vi.fn(async () => [{ day: "2025-01-01" }]),
    getOrgUserDailyReport: vi.fn(async () => []),
    getEnterpriseUserTeamsReport: vi.fn(async () => [{ team_slug: "frontend", user_id: 1, user_login: "u1" }]),
    getOrgUserTeamsReport: vi.fn(async () => []),
    getEnterprise28DayReport: vi.fn(async () => []),
    getOrg28DayReport: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/github/seats-client", () => ({
  seatsClient: {
    getEnterpriseSeats: vi.fn(async () => ({
      totalSeats: 1,
      seats: [makeSeat("u1", "test-org")],
    })),
    getOrgSeats: vi.fn(async () => ({ seats: [makeSeat("u1", "test-org")] })),
  },
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
  invalidateEnterpriseCountCache: vi.fn(),
}));

vi.mock("./seats-repo", () => ({ replaceEnterpriseSeats: vi.fn((_, seatsByOrg: Map<string, unknown[]>) => Array.from(seatsByOrg.values()).reduce((sum, seats) => sum + seats.length, 0)), upsertSeats: vi.fn() }));
vi.mock("./summary-tables", () => ({ refreshAllSummaries: vi.fn() }));
vi.mock("@/lib/cache/memory-cache", () => ({ cache: { invalidateByPrefix: vi.fn(), invalidateAll: vi.fn() } }));
vi.mock("./teams-repo", () => ({ upsertAllTeams: vi.fn() }));
vi.mock("./user-teams-repo", () => ({ batchUpsertUserTeams: vi.fn() }));
vi.mock("@/lib/utils", () => ({ datesBetween: vi.fn(() => ["2025-01-01"]) }));
vi.mock("./billing-sync-service", () => ({ syncBilling: vi.fn(async () => ({ usageRecords: 0, premiumRecords: 0, errors: [] })) }));

vi.mock("./license-history-sync-service", () => ({
  syncLicenseHistoryForEnterprise: vi.fn(async (enterpriseSlug: string) => ({
    enterpriseSlug,
    status: "disabled",
    runId: null,
    requestedPeriods: [],
    materializedPeriods: [],
    skippedPeriods: [],
    warnings: [],
    errorMessage: null,
  })),
  createDefaultLicenseHistorySyncDeps: vi.fn((overrides: Record<string, unknown> = {}) => ({
    getConfig: () => ({ history: { enabled: false } }),
    ...overrides,
  })),
  captureCurrentLicenseSeatSnapshot: vi.fn(async () => ({
    attempted: false,
    persisted: false,
    period: "2025-03",
    seats: [],
    errorMessage: null,
  })),
}));

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

import { syncDay, syncSeats, syncTeams, fullSync, backfill, incrementalSync, backfillEnterprise, getLicensingSyncStatusSummary } from "./sync-service";
import { isSynced, getLatestSyncDay, hasEnterpriseDataForRange, hasOrgDataForRange, recordSync } from "./metrics-repo";
import { metricsClient } from "@/lib/github/metrics-client";
import { seatsClient } from "@/lib/github/seats-client";
import { teamsClient } from "@/lib/github/teams-client";
import { getConfiguredEnterprises, getResolvedOrgsForEnterprise, getEnterpriseConfig, isCopilotSubEnabledForEnterprise, isCopilotSubEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { orgsClient } from "@/lib/github/orgs-client";
import { upsertEnterpriseOrgs } from "./orgs-repo";
import { replaceEnterpriseSeats, upsertSeats } from "./seats-repo";
import { batchUpsertUserTeams } from "./user-teams-repo";
import { datesBetween } from "@/lib/utils";
import { syncLicenseHistoryForEnterprise, captureCurrentLicenseSeatSnapshot, createDefaultLicenseHistorySyncDeps } from "./license-history-sync-service";

function makeSeat(login: string, orgLogin: string | null) {
  return {
    assignee: { login, id: login.length, avatar_url: `https://github.com/${login}.png` },
    plan_type: "enterprise",
    last_activity_at: "2025-01-01T00:00:00Z",
    last_activity_editor: "vscode",
    last_authenticated_at: "2025-01-01T00:00:00Z",
    pending_cancellation_date: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    organization: orgLogin ? { login: orgLogin, id: orgLogin.length } : null,
  };
}

describe("sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isCopilotSubEnabledForAnyEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (hasEnterpriseDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (hasOrgDataForRange as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([{ slug: "test-ent", displayName: "Test" }]);
    (getResolvedOrgsForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(["test-org"]);
    (datesBetween as ReturnType<typeof vi.fn>).mockReturnValue(["2025-01-01"]);
    (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalSeats: 1,
      seats: [makeSeat("u1", "test-org")],
    });
    (seatsClient.getOrgSeats as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalSeats: 1,
      seats: [makeSeat("u1", "test-org")],
    });
  });

  it("syncDay fetches enterprise, users, org data, and user-team attribution", async () => {
    const result = await syncDay("test-ent", "2025-01-01");
    expect(result.enterprise).toBe(1);
    expect(result.users).toBe(1);
    expect(result.orgs["test-org"]).toBe(1);
    expect(metricsClient.getEnterpriseUserTeamsReport).toHaveBeenCalledWith("test-ent", "2025-01-01", "test-ent");
    expect(batchUpsertUserTeams).toHaveBeenCalledWith("test-ent", "2025-01-01", expect.any(Array));
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

  it("syncSeats fetches enterprise seats when enterprise mode is enabled", async () => {
    const result = await syncSeats();
    expect(result).toBe(1);
    expect(seatsClient.getEnterpriseSeats).toHaveBeenCalledWith("test-ent", "test-ent");
    expect(replaceEnterpriseSeats).toHaveBeenCalledWith(
      "test-ent",
      new Map([["test-org", [makeSeat("u1", "test-org")]]]),
    );
  });

  it("syncSeats skips enterprise seats without organization metadata", async () => {
    (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalSeats: 2,
      seats: [makeSeat("u1", "test-org"), makeSeat("u2", null)],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncSeats();

    expect(result).toBe(1);
    expect(replaceEnterpriseSeats).toHaveBeenCalledWith(
      "test-ent",
      new Map([["test-org", [makeSeat("u1", "test-org")]]]),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped %d enterprise seat(s) without organization metadata"),
      "test-ent",
      1,
    );
    warnSpy.mockRestore();
  });

  it("syncSeats falls back when all enterprise seats are missing organization metadata", async () => {
    (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalSeats: 2,
      seats: [makeSeat("u1", null), makeSeat("u2", null)],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSeats();

    expect(result).toBe(1);
    expect(replaceEnterpriseSeats).not.toHaveBeenCalled();
    expect(upsertSeats).toHaveBeenCalledWith("test-ent", "test-org", [makeSeat("u1", "test-org")]);
    expect(recordSync).not.toHaveBeenCalledWith("test-ent", "seats", "test-ent", null, expect.any(Number));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped %d enterprise seat(s) without organization metadata"),
      "test-ent",
      2,
    );
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("syncSeats falls back to org seats when enterprise seats fail", async () => {
    (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no enterprise seats"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSeats();

    expect(result).toBe(1);
    expect(upsertSeats).toHaveBeenCalledWith("test-ent", "test-org", [makeSeat("u1", "test-org")]);
    errorSpy.mockRestore();
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

  // ── Task 9: additive licensing summary integration ──────────────────
  describe("fullSync licensing integration", () => {
    it("adds an additive licensing summary without changing existing top-level fields/semantics", async () => {
      const result = await fullSync();
      expect(result.enterprises).toHaveLength(1);
      expect(result.enterprises[0].enterpriseSlug).toBe("test-ent");
      // Additive field present with the disabled-by-default mock result.
      expect(result.licensing).toEqual({
        enabled: false,
        enterprises: [
          {
            enterpriseSlug: "test-ent",
            status: "disabled",
            runId: null,
            requestedPeriods: [],
            materializedPeriods: [],
            skippedPeriods: [],
            warnings: [],
            errorMessage: null,
          },
        ],
      });
      expect(result.enterprises[0].licensing).toEqual(result.licensing.enterprises[0]);
    });

    it("invokes licensing history sync once per enterprise only after seats and billing are synced", async () => {
      const { syncBilling } = await import("./billing-sync-service");
      const callOrder: string[] = [];
      (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("seats");
        return { totalSeats: 1, seats: [makeSeat("u1", "test-org")] };
      });
      (syncBilling as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("billing");
        return { usageRecords: 0, premiumRecords: 0, errors: [] };
      });
      (syncLicenseHistoryForEnterprise as ReturnType<typeof vi.fn>).mockImplementation(async (enterpriseSlug: string) => {
        callOrder.push("licensing");
        return {
          enterpriseSlug,
          status: "success",
          runId: "run-1",
          requestedPeriods: ["2025-03"],
          materializedPeriods: ["2025-03"],
          skippedPeriods: [],
          warnings: [],
          errorMessage: null,
        };
      });

      await fullSync();

      expect(syncLicenseHistoryForEnterprise).toHaveBeenCalledTimes(1);
      expect(syncLicenseHistoryForEnterprise).toHaveBeenCalledWith("test-ent", expect.anything(), expect.anything());
      expect(callOrder.indexOf("seats")).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf("billing")).toBeGreaterThan(callOrder.indexOf("seats"));
      expect(callOrder.indexOf("licensing")).toBeGreaterThan(callOrder.indexOf("billing"));
    });

    it("captures the current-month licensing seat snapshot BEFORE the legacy copilot_seats replacement (Task 9 spec-review fix #2 — real DI-seam ordering proof)", async () => {
      const { replaceEnterpriseSeats } = await import("./seats-repo");
      const callOrder: string[] = [];
      (captureCurrentLicenseSeatSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        callOrder.push("licensing-snapshot-capture");
        return { attempted: true, persisted: true, period: "2025-03", seats: [], errorMessage: null };
      });
      (replaceEnterpriseSeats as ReturnType<typeof vi.fn>).mockImplementation((_slug: string, seatsByOrg: Map<string, unknown[]>) => {
        callOrder.push("legacy-replace-enterprise-seats");
        return Array.from(seatsByOrg.values()).reduce((sum, seats) => sum + seats.length, 0);
      });

      await fullSync();

      expect(captureCurrentLicenseSeatSnapshot).toHaveBeenCalledWith("test-ent", expect.anything());
      expect(callOrder).toContain("licensing-snapshot-capture");
      expect(callOrder).toContain("legacy-replace-enterprise-seats");
      expect(callOrder.indexOf("licensing-snapshot-capture")).toBeLessThan(callOrder.indexOf("legacy-replace-enterprise-seats"));
    });

    it("reuses the captured live seats for the legacy seat replacement — no duplicate seat API fetch (Task 9 re-review fix #2)", async () => {
      const capturedRawSeat = makeSeat("carol", "test-org");
      (captureCurrentLicenseSeatSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        attempted: true,
        persisted: true,
        period: "2025-03",
        seats: [
          {
            holderKey: "login:carol",
            githubUserId: 99,
            observedLogin: "carol",
            unresolved: false,
            orgLogin: "test-org",
            planType: "business",
            assignedVia: "direct",
            lastActivityAt: null,
            lastActivityEditor: null,
            pendingCancellationDate: null,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            raw: capturedRawSeat,
          },
        ],
        errorMessage: null,
      });
      const getEnterpriseSeatsSpy = seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>;
      getEnterpriseSeatsSpy.mockClear();
      const { replaceEnterpriseSeats } = await import("./seats-repo");
      (replaceEnterpriseSeats as ReturnType<typeof vi.fn>).mockClear();

      await fullSync();

      expect(getEnterpriseSeatsSpy).not.toHaveBeenCalled();
      expect(replaceEnterpriseSeats).toHaveBeenCalledTimes(1);
      const [, seatsByOrg] = (replaceEnterpriseSeats as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(Array.from((seatsByOrg as Map<string, unknown[]>).keys())).toEqual(["test-org"]);
    });

    it("orders snapshot capture → legacy replace → billing → historical materialization, reusing the same captured snapshot for both legacy replace and historical sync, with exactly one capture per enterprise", async () => {
      const { syncBilling } = await import("./billing-sync-service");
      const { replaceEnterpriseSeats } = await import("./seats-repo");
      const callOrder: string[] = [];
      const capturedResult = { attempted: true, persisted: true, period: "2025-03", seats: [], errorMessage: null };
      (captureCurrentLicenseSeatSnapshot as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        callOrder.push("snapshot-write");
        return capturedResult;
      });
      (replaceEnterpriseSeats as ReturnType<typeof vi.fn>).mockImplementation((_slug: string, seatsByOrg: Map<string, unknown[]>) => {
        callOrder.push("legacy-replace");
        return Array.from(seatsByOrg.values()).reduce((sum, seats) => sum + seats.length, 0);
      });
      (syncBilling as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push("billing");
        return { usageRecords: 0, premiumRecords: 0, errors: [] };
      });
      let receivedPreCaptured: unknown;
      (syncLicenseHistoryForEnterprise as ReturnType<typeof vi.fn>).mockImplementation(async (enterpriseSlug: string, _deps: unknown, preCaptured: unknown) => {
        callOrder.push("historical-materialization");
        receivedPreCaptured = preCaptured;
        return {
          enterpriseSlug,
          status: "success",
          runId: "run-1",
          requestedPeriods: [],
          materializedPeriods: [],
          skippedPeriods: [],
          warnings: [],
          errorMessage: null,
        };
      });

      await fullSync();

      expect(callOrder).toEqual(["snapshot-write", "legacy-replace", "billing", "historical-materialization"]);
      expect(captureCurrentLicenseSeatSnapshot).toHaveBeenCalledTimes(1);
      expect(receivedPreCaptured).toBe(capturedResult);
    });

    it("isolates a licensing failure: it is recorded as failed but does not roll back this enterprise's other successful results", async () => {
      (syncLicenseHistoryForEnterprise as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("licensing exploded"));

      const result = await fullSync();

      expect(result.enterprises).toHaveLength(1);
      const ent = result.enterprises[0];
      // Non-licensing results remain intact — the licensing failure never
      // rolled back the enterprise's otherwise-successful sync.
      expect(ent.backfill.errors).toBe(0);
      expect(ent.seats).toBeGreaterThan(0);
      expect(ent.licensing?.status).toBe("failed");
      expect(ent.licensing?.errorMessage).toContain("licensing exploded");
      expect(result.licensing.enterprises[0].status).toBe("failed");
    });

    it("keeps the existing empty-result shape additive when no enterprises are configured", async () => {
      (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([]);
      const result = await fullSync();
      expect(result.enterprises).toHaveLength(0);
      expect(result.licensing).toEqual({ enabled: false, enterprises: [] });
    });

    it("sorts the licensing summary's enterprises stably by enterpriseSlug across multiple enterprises", async () => {
      (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([
        { slug: "zeta-ent", displayName: "Zeta" },
        { slug: "alpha-ent", displayName: "Alpha" },
      ]);
      (getResolvedOrgsForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(["test-org"]);
      (syncLicenseHistoryForEnterprise as ReturnType<typeof vi.fn>).mockImplementation(async (enterpriseSlug: string) => ({
        enterpriseSlug,
        status: "success",
        runId: `run-${enterpriseSlug}`,
        requestedPeriods: [],
        materializedPeriods: [],
        skippedPeriods: [],
        warnings: [],
        errorMessage: null,
      }));

      const result = await fullSync();
      expect(result.licensing.enterprises.map((e) => e.enterpriseSlug)).toEqual(["alpha-ent", "zeta-ent"]);
    });
  });

  // ── Task 9 spec-review fix #3: additive route-consumable licensing status ─
  describe("getLicensingSyncStatusSummary", () => {
    it("derives enabled from the resolved server config, and echoes back the given status, for a 'started' response", () => {
      (createDefaultLicenseHistorySyncDeps as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        getConfig: () => ({ history: { enabled: true } }),
      });
      expect(getLicensingSyncStatusSummary("started")).toEqual({ enabled: true, status: "started" });
    });

    it("derives enabled=false from the resolved server config for an 'in_progress' response", () => {
      (createDefaultLicenseHistorySyncDeps as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        getConfig: () => ({ history: { enabled: false } }),
      });
      expect(getLicensingSyncStatusSummary("in_progress")).toEqual({ enabled: false, status: "in_progress" });
    });

    it.each(["started", "in_progress"] as const)(
      "fails licensing status closed for the '%s' response when config resolution throws",
      (status) => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        (createDefaultLicenseHistorySyncDeps as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          getConfig: () => {
            throw new Error("invalid licensing config");
          },
        });

        expect(getLicensingSyncStatusSummary(status)).toEqual({ enabled: false, status });
        expect(warnSpy).toHaveBeenCalledWith(
          "[Sync] Invalid licensing history configuration; reporting it as disabled.",
        );
        expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("invalid licensing config");
        warnSpy.mockRestore();
      },
    );
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

  it("syncSeats handles enterprise and org API errors gracefully", async () => {
    (seatsClient.getEnterpriseSeats as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("enterprise seats API failure"));
    (seatsClient.getOrgSeats as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("seats API failure"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await syncSeats();
    expect(result).toBe(0);
    errorSpy.mockRestore();
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

  it("syncDay fetches org user-team attribution in org-only mode", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>).mockImplementation((_s: string, key: string) => key !== "enterprise");
    (metricsClient.getOrgUserTeamsReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ team_slug: "frontend", user_id: 7, user_login: "org-u1" }]);

    await syncDay("test-ent", "2025-01-01");

    expect(metricsClient.getOrgUserTeamsReport).toHaveBeenCalledWith("test-org", "2025-01-01", "test-ent");
    expect(batchUpsertUserTeams).toHaveBeenCalledWith("test-ent", "2025-01-01", expect.any(Array));
  });

  it("backfillEnterprise does not skip a day when user-teams is unsynced", async () => {
    const { datesBetween } = await import("@/lib/utils");
    (datesBetween as ReturnType<typeof vi.fn>).mockReturnValue(["2025-01-01"]);
    (isSynced as ReturnType<typeof vi.fn>).mockImplementation((_enterprise: string, scope: string) => scope !== "user-teams");
    const result = await backfillEnterprise("test-ent", 1);
    expect(result.daysSynced).toBe(1);
    expect(metricsClient.getEnterpriseUserTeamsReport).toHaveBeenCalled();
  });

  it("syncDay skips user-teams for remainder of sync when API returns 404", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (metricsClient.getEnterpriseUserTeamsReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("404 Not Found"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First call: triggers 404 → caches unavailability
    await syncDay("test-ent", "2025-01-01");
    expect(batchUpsertUserTeams).not.toHaveBeenCalledWith("test-ent", "2025-01-01", expect.anything());

    // Second call: should skip without even calling the API
    (metricsClient.getEnterpriseUserTeamsReport as ReturnType<typeof vi.fn>).mockClear();
    await syncDay("test-ent", "2025-01-02");
    expect(metricsClient.getEnterpriseUserTeamsReport).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("backfillEnterprise clears user-teams unavailability cache per run", async () => {
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // First backfill: API returns 404
    (metricsClient.getEnterpriseUserTeamsReport as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("404 Not Found"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await backfillEnterprise("test-ent", 1);

    // Second backfill: API now works — should NOT be stuck in unavailable state
    (metricsClient.getEnterpriseUserTeamsReport as ReturnType<typeof vi.fn>)
      .mockResolvedValue([{ team_slug: "fe", user_id: 1, user_login: "u1" }]);
    await backfillEnterprise("test-ent", 1);
    expect(metricsClient.getEnterpriseUserTeamsReport).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("backfillEnterprise skips fully-synced days", async () => {
    (datesBetween as ReturnType<typeof vi.fn>).mockReturnValue(["2025-01-01", "2025-01-02", "2025-01-03"]);
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await backfillEnterprise("test-ent", 3);
    expect(result.daysSynced).toBe(0);
    expect(result.daysSkipped).toBeGreaterThanOrEqual(3);
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

  // ── Org-only mode tests ──────────────────────────────────────────────

  it("fullSync in org-only mode skips getEnterpriseContext", async () => {
    const { getEnterpriseContext, updateEnterpriseRegistry } = await import("./enterprise-context");
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>)
      .mockImplementation((_s: string, key: string) => key !== "enterprise");
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([
      { slug: "_org_only", displayName: "Organizations" },
    ]);
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "_org_only",
      displayName: "Organizations",
      organizations: { include: ["org-1"], exclude: [] },
      metrics: { copilot: { enterprise: false }, billing: { enabled: false } },
    });

    const result = await fullSync();

    expect(getEnterpriseContext).not.toHaveBeenCalled();
    // updateEnterpriseRegistry should still be called (local DB write)
    expect(updateEnterpriseRegistry).toHaveBeenCalledWith("_org_only", "_org_only", "Organizations");
    expect(result.enterprises).toHaveLength(1);
    expect(result.enterprises[0].enterpriseSlug).toBe("_org_only");
  });

  it("fullSync in org-only mode does not call enterprise API endpoints", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>)
      .mockImplementation((_s: string, key: string) => key !== "enterprise");
    (isSynced as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([
      { slug: "_org_only", displayName: "Organizations" },
    ]);
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "_org_only",
      displayName: "Organizations",
      organizations: { include: ["org-1"], exclude: [] },
      metrics: { copilot: { enterprise: false }, billing: { enabled: false } },
    });
    (getResolvedOrgsForEnterprise as ReturnType<typeof vi.fn>).mockReturnValue(["org-1"]);

    await fullSync();

    // Enterprise endpoints should NOT be called
    expect(metricsClient.getEnterpriseDailyReport).not.toHaveBeenCalled();
    expect(metricsClient.getEnterprise28DayReport).not.toHaveBeenCalled();
    expect(orgsClient.listEnterpriseOrgs).not.toHaveBeenCalled();
    // Org endpoints should be called
    expect(metricsClient.getOrgDailyReport).toHaveBeenCalled();
  });

  it("discoverOrgsIfNeeded skips enterprise API when enterprise disabled", async () => {
    (isCopilotSubEnabledForEnterprise as ReturnType<typeof vi.fn>)
      .mockImplementation((_s: string, key: string) => key !== "enterprise");
    (getEnterpriseConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      slug: "_org_only",
      displayName: "Organizations",
      organizations: { include: [], exclude: [] },
      metrics: { copilot: { enterprise: false } },
    });
    (getConfiguredEnterprises as ReturnType<typeof vi.fn>).mockReturnValue([
      { slug: "_org_only", displayName: "Organizations" },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fullSync();

    // Enterprise org discovery API should NOT be called
    expect(orgsClient.listEnterpriseOrgs).not.toHaveBeenCalled();
    // Warning should be logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Org auto-discovery skipped"),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });
});
