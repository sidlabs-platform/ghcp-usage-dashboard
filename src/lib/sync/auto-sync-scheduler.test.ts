import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config/dashboard-config", () => ({
  getAutoSyncConfig: vi.fn(() => ({ enabled: false, utcTime: "03:00" })),
  isMetricEnabled: vi.fn(() => true),
  getEffectiveBillingEnabled: vi.fn(() => true),
}));
vi.mock("@/lib/db/sync-service", () => ({ incrementalSync: vi.fn() }));
vi.mock("@/lib/db/summary-tables", () => ({ refreshAllSummaries: vi.fn() }));
vi.mock("@/lib/db/ghas-sync-service", () => ({ fullGhasSync: vi.fn() }));
vi.mock("@/lib/db/billing-sync-service", () => ({ syncBilling: vi.fn() }));
vi.mock("@/lib/config/enterprise-config", () => ({ getEnterpriseSlugs: vi.fn(() => ["ent1"]) }));
vi.mock("@/lib/db/metrics-repo", () => ({
  acquireSyncLock: vi.fn(() => true),
  releaseSyncLock: vi.fn(),
  heartbeatSyncLock: vi.fn(),
}));
vi.mock("@/lib/cache/memory-cache", () => ({
  cache: { invalidateAll: vi.fn() },
}));

import { startAutoSync, stopAutoSync, getAutoSyncStatus } from "./auto-sync-scheduler";
import { getAutoSyncConfig } from "@/lib/config/dashboard-config";

const mockConfig = getAutoSyncConfig as ReturnType<typeof vi.fn>;

describe("auto-sync-scheduler", () => {
  beforeEach(() => {
    stopAutoSync();
    mockConfig.mockReturnValue({ enabled: false, utcTime: "03:00" });
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
});
