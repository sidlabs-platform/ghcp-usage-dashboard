import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("system routes", { timeout: 10000 }, () => {
  it("exposes health liveness and readiness details", async () => {
    const { GET } = await import("./health/route");

    const liveness = await GET(new Request("http://localhost/api/health"));
    const readiness = await GET(new Request("http://localhost/api/health?ready=1"));

    await expect(liveness.json()).resolves.toEqual({ status: "ok" });
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toMatchObject({
      status: "ok",
      checks: {
        dataDir: true,
        schemaFiles: true,
        dashboardConfig: expect.any(Boolean),
      },
    });
  });

  it("passes enterprise filters through sync status", async () => {
    const getSyncStatus = vi.fn(() => [{ days_synced: 4 }, { days_synced: 2 }]);

    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncStatus,
    }));

    const { GET } = await import("./sync/status/route");
    const response = await GET(
      new NextRequest("http://localhost/api/sync/status?enterprises=ent-a,ent-b"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      status: [{ days_synced: 4 }, { days_synced: 2 }],
    });
    expect(getSyncStatus).toHaveBeenCalledWith(["ent-a", "ent-b"]);
  });

  it("surfaces sync status failures", async () => {
    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncStatus: vi.fn(() => {
        throw new Error("status unavailable");
      }),
    }));

    const { GET } = await import("./sync/status/route");
    const response = await GET(new NextRequest("http://localhost/api/sync/status"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "status unavailable",
    });
  });

  it("reports and clears sync locks", async () => {
    const getSyncLockInfo = vi
      .fn()
      .mockReturnValueOnce({ locked: true, owner: "sync-job" })
      .mockReturnValueOnce({ locked: false, owner: null })
      .mockReturnValueOnce({ locked: true, owner: "sync-job" });
    const forceReleaseSyncLock = vi.fn(() => ({ locked: false, clearedAt: "2024-01-02T00:00:00Z" }));

    vi.doMock("@/lib/db/metrics-repo", () => ({
      getSyncLockInfo,
      forceReleaseSyncLock,
    }));

    const route = await import("./sync/lock/route");
    const getResponse = await route.GET();
    const idleDeleteResponse = await route.DELETE();
    const clearingResponse = await route.DELETE();

    await expect(getResponse.json()).resolves.toEqual({
      locked: true,
      owner: "sync-job",
    });
    await expect(idleDeleteResponse.json()).resolves.toEqual({
      success: true,
      message: "No lock was held.",
      lockInfo: { locked: false, owner: null },
    });
    await expect(clearingResponse.json()).resolves.toEqual({
      success: true,
      message: "Sync lock cleared.",
      clearedLock: { locked: false, clearedAt: "2024-01-02T00:00:00Z" },
    });
    expect(forceReleaseSyncLock).toHaveBeenCalledTimes(1);
  });
});
