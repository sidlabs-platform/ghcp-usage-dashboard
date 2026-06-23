import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300, FILTERS: 300 },
}));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("additional API route coverage", { timeout: 15000 }, () => {
  it("returns filter options scoped to selected enterprises", async () => {
    const prepare = vi
      .fn()
      .mockReturnValueOnce({
        all: vi.fn(() => [
          { slug: "eng", name: "Engineering", enterpriseSlug: "ent-a", memberCount: 2 },
        ]),
      })
      .mockReturnValueOnce({
        all: vi.fn(() => [
          {
            slug: "platform-team",
            name: "Platform Team",
            orgSlug: "platform",
            enterpriseSlug: "ent-a",
            memberCount: 1,
          },
        ]),
      })
      .mockReturnValueOnce({
        all: vi.fn(() => [{ slug: "platform", enterpriseSlug: "ent-a" }]),
      });

    vi.doMock("@/lib/db/database", () => ({
      getDb: vi.fn(() => ({ prepare })),
    }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: vi.fn(() => [{ slug: "ent-a", displayName: "Enterprise A" }]),
    }));

    const { GET } = await import("./filters/route");
    const response = await GET(new NextRequest("http://localhost/api/filters?enterprises=ent-a"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enterprises: [{ slug: "ent-a", displayName: "Enterprise A" }],
      enterpriseTeams: [
        { slug: "eng", name: "Engineering", enterpriseSlug: "ent-a", memberCount: 2 },
      ],
      orgTeams: [
        {
          slug: "platform-team",
          name: "Platform Team",
          orgSlug: "platform",
          enterpriseSlug: "ent-a",
          memberCount: 1,
        },
      ],
      orgs: [{ slug: "platform", name: "platform", enterpriseSlug: "ent-a" }],
    });
  });

  it("surfaces filter route failures", async () => {
    vi.doMock("@/lib/db/database", () => ({
      getDb: vi.fn(() => {
        throw new Error("filters unavailable");
      }),
    }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: vi.fn(() => []),
    }));

    const { GET } = await import("./filters/route");
    const response = await GET(new NextRequest("http://localhost/api/filters"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "filters unavailable" });
  });

  it("normalizes seat query params and computes utilization", async () => {
    const parseScopeFilter = vi.fn(() => ({
      allowedLogins: new Set(["octocat"]),
      enterpriseSlugs: ["ent-a"],
      selectedTeams: ["eng"],
      selectedOrgs: [],
    }));
    const getSeatStats = vi.fn(() => ({ total: 5, active30d: 4 }));
    const getSeatsPaginated = vi.fn(() => ({
      seats: [{ login: "octocat", lastActivity: "2024-01-10" }],
      total: 1,
    }));

    vi.doMock("@/lib/api/scope-filter", () => ({ parseScopeFilter }));
    vi.doMock("@/lib/db/seats-repo", () => ({ getSeatStats, getSeatsPaginated }));

    const { GET } = await import("./seats/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/seats?page=0&pageSize=999&sort=login&sortDir=asc&teams=eng",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      seats: [{ login: "octocat", lastActivity: "2024-01-10" }],
      stats: { total: 5, active30d: 4 },
      utilization: 80,
      filtered: true,
      pagination: {
        page: 1,
        pageSize: 200,
        totalItems: 1,
        totalPages: 1,
      },
    });
    expect(getSeatsPaginated).toHaveBeenCalledWith(
      1,
      200,
      "login",
      "asc",
      new Set(["octocat"]),
      ["ent-a"],
    );
  });

  it("validates date ranges and paginates users", async () => {
    const parseScopeFilter = vi.fn(() => ({
      allowedLogins: new Set(["octocat"]),
      enterpriseSlugs: ["ent-a"],
    }));
    const getUserSummariesPaginated = vi.fn(() => ({
      users: [{ login: "octocat", activeDays: 7 }],
      total: 1,
    }));

    vi.doMock("@/lib/api/scope-filter", () => ({ parseScopeFilter }));
    vi.doMock("@/lib/db/aggregation-queries", () => ({ getUserSummariesPaginated }));

    const route = await import("./users/route");
    const invalidResponse = await route.GET(new NextRequest("http://localhost/api/users?days=0"));
    const validResponse = await route.GET(
      new NextRequest(
        "http://localhost/api/users?days=7&page=0&pageSize=999&sort=login&sortDir=asc&search=octo&includeInactive=true",
      ),
    );

    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid days parameter"),
    });
    await expect(validResponse.json()).resolves.toEqual({
      users: [{ login: "octocat", activeDays: 7 }],
      pagination: {
        page: 1,
        pageSize: 200,
        totalItems: 1,
        totalPages: 1,
      },
    });
    expect(getUserSummariesPaginated).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      1,
      200,
      "login",
      "asc",
      "octo",
      ["octocat"],
      ["ent-a"],
      true,
    );
  });

  it("rejects invalid sync-day requests", async () => {
    vi.doMock("@/lib/db/sync-service", () => ({ syncDay: vi.fn() }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getConfiguredEnterprises: vi.fn(() => []),
    }));

    const { POST } = await import("./sync/day/route");
    const response = await POST(
      new NextRequest("http://localhost/api/sync/day", {
        method: "POST",
        body: JSON.stringify({ day: "2024/01/01" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid day format. Use YYYY-MM-DD.",
    });
  });

  it("syncs one enterprise or all configured enterprises for a specific day", async () => {
    const syncDay = vi
      .fn()
      .mockResolvedValueOnce({ synced: 1 })
      .mockResolvedValueOnce({ synced: 2 })
      .mockRejectedValueOnce(new Error("sync failed"));
    const getConfiguredEnterprises = vi.fn(() => [{ slug: "ent-a" }, { slug: "ent-b" }]);

    vi.doMock("@/lib/db/sync-service", () => ({ syncDay }));
    vi.doMock("@/lib/config/enterprise-config", () => ({ getConfiguredEnterprises }));

    const { POST } = await import("./sync/day/route");
    const singleResponse = await POST(
      new NextRequest("http://localhost/api/sync/day", {
        method: "POST",
        body: JSON.stringify({ day: "2024-01-01", enterpriseSlug: "ent-a" }),
      }),
    );
    const allResponse = await POST(
      new NextRequest("http://localhost/api/sync/day", {
        method: "POST",
        body: JSON.stringify({ day: "2024-01-01" }),
      }),
    );

    await expect(singleResponse.json()).resolves.toEqual({
      success: true,
      day: "2024-01-01",
      enterpriseSlug: "ent-a",
      result: { synced: 1 },
    });
    await expect(allResponse.json()).resolves.toEqual({
      success: true,
      day: "2024-01-01",
      results: {
        "ent-a": { synced: 2 },
        "ent-b": { error: "sync failed" },
      },
    });
  });

  it("reports sync status snapshots", async () => {
    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncStatus: vi.fn(() => [{ enterprise_slug: "ent-a", days_synced: 3 }]),
      getSyncLockInfo: vi.fn(() => ({ locked: false })),
      isSyncLocked: vi.fn(() => false),
      acquireSyncLock: vi.fn(),
      releaseSyncLock: vi.fn(),
      clearEmptySyncEntries: vi.fn(),
      forceReleaseSyncLock: vi.fn(),
    }));
    vi.doMock("@/lib/db/sync-service", () => ({ fullSync: vi.fn() }));
    vi.doMock("@/lib/db/ghas-sync-service", () => ({ fullGhasSync: vi.fn() }));
    vi.doMock("@/lib/sync/auto-sync-scheduler", () => ({
      getAutoSyncStatus: vi.fn(() => ({ enabled: true, utcTime: "04:00", nextRunAt: null })),
    }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: vi.fn(() => [{ slug: "ent-a", displayName: "Enterprise A" }]),
      isMetricEnabledForAnyEnterprise: vi.fn(() => false),
    }));

    const { GET } = await import("./sync/route");
    const response = await GET();

    await expect(response.json()).resolves.toEqual({
      syncInProgress: false,
      status: [{ enterprise_slug: "ent-a", days_synced: 3 }],
      lockInfo: { locked: false },
      autoSync: { enabled: true, utcTime: "04:00", nextRunAt: null },
      enterprises: [{ slug: "ent-a", displayName: "Enterprise A" }],
    });
  });

  it("returns an in-progress sync response when the lock is already held", async () => {
    const acquireSyncLock = vi.fn(() => false);
    const getSyncStatus = vi.fn(() => [{ days_synced: 2 }]);
    const getSyncLockInfo = vi.fn(() => ({ locked: true, owner: "job-1" }));

    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncStatus,
      getSyncLockInfo,
      acquireSyncLock,
      releaseSyncLock: vi.fn(),
      isSyncLocked: vi.fn(),
      clearEmptySyncEntries: vi.fn(),
      forceReleaseSyncLock: vi.fn(),
    }));
    vi.doMock("@/lib/db/sync-service", () => ({ fullSync: vi.fn() }));
    vi.doMock("@/lib/db/ghas-sync-service", () => ({ fullGhasSync: vi.fn() }));
    vi.doMock("@/lib/sync/auto-sync-scheduler", () => ({
      getAutoSyncStatus: vi.fn(() => ({ enabled: false })),
    }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: vi.fn(() => []),
      isMetricEnabledForAnyEnterprise: vi.fn(() => false),
    }));

    const { POST } = await import("./sync/route");
    const response = await POST(new Request("http://localhost/api/sync"));

    await expect(response.json()).resolves.toEqual({
      success: true,
      message:
        "Sync already in progress. Check GET /api/sync/status for progress. Use ?forceLock=true to force-release a stale lock.",
      inProgress: true,
      status: [{ days_synced: 2 }],
      lockInfo: { locked: true, owner: "job-1" },
    });
    expect(acquireSyncLock).toHaveBeenCalledTimes(1);
  });

  it("starts sync jobs, force-releases stale locks, and runs GHAS follow-up when enabled", async () => {
    const fullSync = vi.fn(async (onProgress: (progress: { message: string }) => void) => {
      onProgress({ message: "Syncing enterprise data" });
      return {
        backfill: { daysSynced: 3, daysSkipped: 1, errors: [] },
        seats: 5,
        teams: 2,
      };
    });
    const fullGhasSync = vi.fn(async (onProgress: (progress: { message: string }) => void) => {
      onProgress({ message: "Syncing GHAS" });
      return { synced: 4 };
    });
    const clearEmptySyncEntries = vi.fn(() => 2);
    const forceReleaseSyncLock = vi.fn(() => ({ locked: false }));
    const releaseSyncLock = vi.fn();

    vi.doMock("@/lib/db/sync-service", () => ({ fullSync }));
    vi.doMock("@/lib/db/ghas-sync-service", () => ({ fullGhasSync }));
    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncStatus: vi.fn(() => []),
      getSyncLockInfo: vi.fn(() => ({ locked: true, owner: "stale-job" })),
      acquireSyncLock: vi.fn(() => true),
      releaseSyncLock,
      isSyncLocked: vi.fn(() => false),
      clearEmptySyncEntries,
      forceReleaseSyncLock,
    }));
    vi.doMock("@/lib/sync/auto-sync-scheduler", () => ({
      getAutoSyncStatus: vi.fn(() => ({ enabled: false })),
    }));
    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: vi.fn(() => []),
      isMetricEnabledForAnyEnterprise: vi
        .fn()
        .mockImplementation((metric: string) => metric === "codeScanning"),
    }));

    const { POST } = await import("./sync/route");
    const response = await POST(
      new Request("http://localhost/api/sync?resync=true&forceLock=true", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: "Sync started. Poll GET /api/sync/status for progress.",
      inProgress: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clearEmptySyncEntries).toHaveBeenCalledTimes(1);
    expect(forceReleaseSyncLock).toHaveBeenCalledTimes(1);
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(fullGhasSync).toHaveBeenCalledTimes(1);
    expect(releaseSyncLock).toHaveBeenCalledTimes(1);
  });
});
