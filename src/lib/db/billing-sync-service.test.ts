import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/github/billing-client", () => ({
  billingClient: {
    fetchUsageReport: vi.fn(async () => []),
    fetchPremiumRequestReport: vi.fn(async () => []),
  },
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  getEffectiveBillingEnabled: vi.fn(() => true),
  isBillingSubEnabled: vi.fn(() => true),
}));

vi.mock("./billing-repo", () => ({
  upsertUsageRecords: vi.fn(),
  upsertPremiumRequests: vi.fn(),
  refreshBillingDailyAggregates: vi.fn(),
  getBillingSyncState: vi.fn(() => null),
  updateBillingSyncState: vi.fn(),
}));

import { syncBilling } from "./billing-sync-service";
import { billingClient } from "@/lib/github/billing-client";
import { getEffectiveBillingEnabled, isBillingSubEnabled } from "@/lib/config/dashboard-config";
import { refreshBillingDailyAggregates, getBillingSyncState } from "./billing-repo";

const mockBillingEnabled = getEffectiveBillingEnabled as ReturnType<typeof vi.fn>;
const mockSubEnabled = isBillingSubEnabled as ReturnType<typeof vi.fn>;
const mockFetchUsage = billingClient.fetchUsageReport as ReturnType<typeof vi.fn>;
const mockFetchPremium = billingClient.fetchPremiumRequestReport as ReturnType<typeof vi.fn>;

describe("billing-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBillingEnabled.mockReturnValue(true);
    mockSubEnabled.mockReturnValue(true);
    mockFetchUsage.mockResolvedValue([{ day: "2025-01-01" }]);
    mockFetchPremium.mockResolvedValue([{ day: "2025-01-01" }]);
    (getBillingSyncState as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  it("returns zeros when billing disabled", async () => {
    mockBillingEnabled.mockReturnValue(false);
    const result = await syncBilling("test-ent");
    expect(result).toEqual({ usageRecords: 0, premiumRecords: 0, errors: [] });
    expect(mockFetchUsage).not.toHaveBeenCalled();
  });

  it("syncs all report types when enabled", async () => {
    const result = await syncBilling("test-ent");
    expect(result.usageRecords).toBe(2); // summarized + detailed
    expect(result.premiumRecords).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(refreshBillingDailyAggregates).toHaveBeenCalledWith("test-ent");
  });

  it("handles 403 permission error with clear message", async () => {
    mockFetchUsage.mockRejectedValueOnce(new Error("HTTP 403 Forbidden"));
    const result = await syncBilling("test-ent");
    expect(result.errors[0]).toContain("Enterprise administration");
  });

  it("skips metered usage when sub-toggle off", async () => {
    mockSubEnabled.mockImplementation((key: string) => key !== "meteredUsage");
    const result = await syncBilling("test-ent");
    expect(mockFetchUsage).not.toHaveBeenCalled();
    expect(result.premiumRecords).toBe(1);
  });

  it("skips when no date range needed (already synced)", async () => {
    (getBillingSyncState as ReturnType<typeof vi.fn>).mockReturnValue({
      status: "ok",
      last_report_end: new Date().toISOString().split("T")[0],
    });
    const result = await syncBilling("test-ent");
    // detailed range start > today means null range → 0
    expect(result.usageRecords).toBe(0);
  });

  it("handles premium_request errors independently", async () => {
    mockSubEnabled.mockImplementation((key: string) => key === "premiumRequests");
    mockFetchPremium.mockRejectedValue(new Error("premium timeout"));
    const result = await syncBilling("test-ent");
    expect(result.premiumRecords).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("premium_request");
    expect(result.errors[0]).toContain("premium timeout");
  });

  it("handles non-Error thrown objects in formatError", async () => {
    mockFetchUsage.mockRejectedValueOnce("raw string error");
    const result = await syncBilling("test-ent");
    expect(result.errors[0]).toContain("summarized");
    expect(result.errors[0]).toContain("raw string error");
  });

  it("handles detailed usage sync error", async () => {
    mockSubEnabled.mockImplementation((key: string) => key === "meteredUsage");
    mockFetchUsage.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("detailed fail"));
    const result = await syncBilling("test-ent");
    expect(result.errors.some(e => e.includes("detailed"))).toBe(true);
  });

  it("handles refreshBillingDailyAggregates error", async () => {
    (refreshBillingDailyAggregates as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("agg crash"); });
    const result = await syncBilling("test-ent");
    expect(result.errors.some(e => e.includes("daily aggregates"))).toBe(true);
  });

  it("syncBilling uses sync state lastEnd for summarized incremental fetch", async () => {
    // Simulate existing sync state with last_report_end far enough back
    (getBillingSyncState as ReturnType<typeof vi.fn>).mockImplementation((type: string) => {
      if (type === "summarized") return { status: "ok", last_report_end: "2024-01-01", last_report_start: "2023-06-01" };
      return null;
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await syncBilling("test-ent");
    expect(mockFetchUsage).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("syncBilling skips premium when sub-toggle off", async () => {
    mockSubEnabled.mockImplementation((key: string) => key !== "premiumRequests");
    const result = await syncBilling("test-ent");
    expect(mockFetchPremium).not.toHaveBeenCalled();
    expect(result.premiumRecords).toBe(0);
  });
});
