import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config/dashboard-config", () => ({
  getAutoSyncConfig: vi.fn(() => ({ enabled: false, utcTime: "03:00" })),
}));
vi.mock("@/lib/db/sync-service", () => ({ incrementalSync: vi.fn(async () => ({ daysSynced: 1, daysSkipped: 0, errors: 0, failedEnterprises: [] })) }));
vi.mock("@/lib/db/summary-tables", () => ({ refreshAllSummaries: vi.fn() }));
vi.mock("@/lib/db/ghas-sync-service", () => ({ fullGhasSync: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/billing-sync-service", () => ({ syncBilling: vi.fn(async () => ({})) }));
vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseSlugs: vi.fn(() => ["ent1"]),
  isMetricEnabledForAnyEnterprise: vi.fn(() => false),
}));
vi.mock("@/lib/db/metrics-repo", () => ({
  acquireSyncLock: vi.fn(() => true),
  releaseSyncLock: vi.fn(),
  heartbeatSyncLock: vi.fn(),
}));
vi.mock("@/lib/cache/memory-cache", () => ({
  cache: { invalidateByPrefix: vi.fn(), invalidateAll: vi.fn() },
}));

import { startAutoSync, stopAutoSync, getAutoSyncStatus } from "./auto-sync-scheduler";
import { getAutoSyncConfig } from "@/lib/config/dashboard-config";
import { isMetricEnabledForAnyEnterprise } from "@/lib/config/enterprise-config";
import { incrementalSync } from "@/lib/db/sync-service";
import { acquireSyncLock } from "@/lib/db/metrics-repo";

const mockConfig = getAutoSyncConfig as ReturnType<typeof vi.fn>;
const mockMetric = isMetricEnabledForAnyEnterprise as ReturnType<typeof vi.fn>;
const mockIncrSync = incrementalSync as ReturnType<typeof vi.fn>;
const mockAcquire = acquireSyncLock as ReturnType<typeof vi.fn>;

describe("auto-sync-scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopAutoSync();
    vi.clearAllMocks();
    mockConfig.mockReturnValue({ enabled: false, utcTime: "03:00" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("startAutoSync does not schedule when disabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Disabled"));
    spy.mockRestore();
  });

  it("startAutoSync schedules when enabled", () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Scheduler starting"));
    const status = getAutoSyncStatus();
    expect(status.nextRunAt).not.toBeNull();
    spy.mockRestore();
    stopAutoSync();
  });

  it("startAutoSync handles invalid utcTime gracefully", () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "invalid" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    startAutoSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Invalid utcTime"));
    spy.mockRestore();
  });

  it("startAutoSync handles out-of-range utcTime (hour > 23)", () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "25:00" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    startAutoSync();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Invalid utcTime"));
    spy.mockRestore();
  });

  it("getAutoSyncStatus returns current state", () => {
    const status = getAutoSyncStatus();
    expect(status.enabled).toBe(false);
    expect(status.utcTime).toBe("03:00");
    expect(status.running).toBe(false);
  });

  it("stopAutoSync clears timer", () => {
    stopAutoSync();
    const status = getAutoSyncStatus();
    expect(status.nextRunAt).toBeNull();
  });

  it("executeAutoSync runs full cycle when timer fires", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockMetric.mockReturnValue(true);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(mockIncrSync).toHaveBeenCalled();
    spy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync invokes progress callbacks and heartbeat", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockMetric.mockImplementation((cat: string) => cat === "billing");
    // Make incrementalSync invoke the progress callback
    mockIncrSync.mockImplementation(async (onProgress: (p: { message: string }) => void) => {
      onProgress({ message: "syncing day 1" });
      return { daysSynced: 1, daysSkipped: 0 };
    });
    const { syncBilling } = await import("@/lib/db/billing-sync-service");
    (syncBilling as ReturnType<typeof vi.fn>).mockImplementation(
      async (_slug: string, cb: (p: { current: number; total: number; message: string }) => void) => {
        cb({ current: 1, total: 1, message: "billing done" });
        return {};
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("syncing day 1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("billing done"));
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync handles refreshAllSummaries failure", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(true);
    mockIncrSync.mockResolvedValue({ daysSynced: 1, daysSkipped: 0 });
    const { refreshAllSummaries } = await import("@/lib/db/summary-tables");
    (refreshAllSummaries as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("summary boom"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("refresh summary tables"), expect.any(Error));
    errSpy.mockRestore();
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync skips when lock not acquired", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(false);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(mockIncrSync).not.toHaveBeenCalled();
    spy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync handles incrementalSync failure gracefully", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(true);
    mockIncrSync.mockRejectedValue(new Error("sync blew up"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Incremental sync failed"), expect.any(Error));
    errSpy.mockRestore();
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync reschedules after config becomes disabled mid-run", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    // Disable config after start but before timer fires
    mockConfig.mockReturnValue({ enabled: false, utcTime: "03:00" });
    await vi.runOnlyPendingTimersAsync();
    const status = getAutoSyncStatus();
    expect(status.nextRunAt).toBeNull();
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync handles GHAS sync failure gracefully", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(true);
    mockIncrSync.mockResolvedValue({ daysSynced: 1, daysSkipped: 0 });
    mockMetric.mockReturnValue(true); // enables GHAS
    const { fullGhasSync } = await import("@/lib/db/ghas-sync-service");
    (fullGhasSync as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ghas boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("GHAS sync failed"), expect.any(Error));
    errSpy.mockRestore();
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync handles billing sync failure gracefully", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(true);
    mockIncrSync.mockResolvedValue({ daysSynced: 1, daysSkipped: 0 });
    mockMetric.mockImplementation((cat: string) => cat === "billing");
    const { syncBilling } = await import("@/lib/db/billing-sync-service");
    (syncBilling as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("billing error"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Billing sync failed"), expect.any(Error));
    errSpy.mockRestore();
    logSpy.mockRestore();
    stopAutoSync();
  });

  it("executeAutoSync returns early when stopped is set before async body runs", async () => {
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    mockAcquire.mockReturnValue(true);
    // Stop during incrementalSync to set stopped=true before finally block
    mockIncrSync.mockImplementation(async () => {
      stopAutoSync(); // sets stopped=true mid-execution
      return { daysSynced: 0, daysSkipped: 0 };
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    await vi.runOnlyPendingTimersAsync();
    // After stopping mid-run, scheduleNext should NOT re-schedule
    const status = getAutoSyncStatus();
    expect(status.nextRunAt).toBeNull();
    logSpy.mockRestore();
  });

  it("schedules for next day when current UTC time is past utcTime", () => {
    // Set fake time to 04:00 UTC — past 03:00
    vi.setSystemTime(new Date("2024-06-01T04:00:00Z"));
    mockConfig.mockReturnValue({ enabled: true, utcTime: "03:00" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    startAutoSync();
    const status = getAutoSyncStatus();
    // Next run should be ~23 hours later (next day at 03:00 UTC)
    expect(status.nextRunAt).not.toBeNull();
    const nextRun = new Date(status.nextRunAt!);
    expect(nextRun.getUTCHours()).toBe(3);
    expect(nextRun.getUTCDate()).toBe(2); // next day
    logSpy.mockRestore();
    stopAutoSync();
  });
});
