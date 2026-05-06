import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";

// Mock fs before importing the module under test
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  },
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
}));

import {
  getDashboardConfig,
  isMetricEnabled,
  getSecurityConfig,
  getAutoSyncConfig,
  isCodeScanningAutofixEnabled,
  getResolvedOrgs,
  isEnterpriseEnabled,
  isCopilotSubEnabled,
  getEffectiveBillingEnabled,
  isBillingSubEnabled,
} from "./dashboard-config";

const mockReadFileSync = vi.mocked(fs.readFileSync);

describe("dashboard-config (defaults)", () => {
  afterEach(() => {
    delete process.env.GITHUB_ORGS;
  });

  describe("getDashboardConfig", () => {
    it("returns defaults when config file does not exist", () => {
      const config = getDashboardConfig();
      expect(config.metrics.copilot.enabled).toBe(true);
      expect(config.metrics.billing.enabled).toBe(false);
      expect(config.security.backfillDays).toBe(90);
    });

    it("returns metrics config structure", () => {
      const config = getDashboardConfig();
      expect(config.metrics.codeScanning.enabled).toBe(true);
      expect(config.metrics.dependabot.enabled).toBe(true);
      expect(config.metrics.secretScanning.enabled).toBe(true);
    });
  });

  describe("isMetricEnabled", () => {
    it("returns true for copilot", () => {
      expect(isMetricEnabled("copilot")).toBe(true);
    });

    it("returns true for codeScanning", () => {
      expect(isMetricEnabled("codeScanning")).toBe(true);
    });

    it("returns false for billing (disabled by default)", () => {
      expect(isMetricEnabled("billing")).toBe(false);
    });
  });

  describe("getSecurityConfig", () => {
    it("returns default security config", () => {
      const config = getSecurityConfig();
      expect(config.syncIntervalMinutes).toBe(60);
      expect(config.backfillDays).toBe(90);
    });
  });

  describe("getAutoSyncConfig", () => {
    it("returns defaults when not configured", () => {
      const config = getAutoSyncConfig();
      expect(config.enabled).toBe(false);
      expect(config.utcTime).toBe("03:00");
    });
  });

  describe("isCodeScanningAutofixEnabled", () => {
    it("returns false by default", () => {
      expect(isCodeScanningAutofixEnabled()).toBe(false);
    });
  });

  describe("getResolvedOrgs", () => {
    it("returns empty when GITHUB_ORGS is not set", () => {
      delete process.env.GITHUB_ORGS;
      expect(getResolvedOrgs()).toEqual([]);
    });

    it("splits GITHUB_ORGS by comma and trims", () => {
      process.env.GITHUB_ORGS = "org-a, org-b, org-c";
      const result = getResolvedOrgs();
      expect(result).toEqual(["org-a", "org-b", "org-c"]);
    });

    it("filters empty entries", () => {
      process.env.GITHUB_ORGS = "org-a,,org-b,";
      const result = getResolvedOrgs();
      expect(result).toEqual(["org-a", "org-b"]);
    });
  });

  describe("isEnterpriseEnabled", () => {
    it("returns false when GITHUB_ENTERPRISE is not set", () => {
      delete process.env.GITHUB_ENTERPRISE;
      expect(isEnterpriseEnabled()).toBe(false);
    });

    it("returns true when GITHUB_ENTERPRISE is set", () => {
      process.env.GITHUB_ENTERPRISE = "my-ent";
      expect(isEnterpriseEnabled()).toBe(true);
      delete process.env.GITHUB_ENTERPRISE;
    });
  });

  describe("isCopilotSubEnabled", () => {
    it("returns true for userMetrics by default", () => {
      expect(isCopilotSubEnabled("userMetrics")).toBe(true);
    });

    it("returns true for seats by default", () => {
      expect(isCopilotSubEnabled("seats")).toBe(true);
    });

    it("returns false for enterprise when env var missing", () => {
      delete process.env.GITHUB_ENTERPRISE;
      expect(isCopilotSubEnabled("enterprise")).toBe(false);
    });
  });

  describe("getEffectiveBillingEnabled / isBillingSubEnabled", () => {
    it("returns false when enterprise is disabled", () => {
      delete process.env.GITHUB_ENTERPRISE;
      expect(getEffectiveBillingEnabled()).toBe(false);
      expect(isBillingSubEnabled("meteredUsage")).toBe(false);
    });
  });
});

describe("dashboard-config (with config file)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Move system time forward past 5-min cache TTL
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    delete process.env.GITHUB_ORGS;
  });

  it("deep merges overrides with defaults", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { enabled: true }, codeScanning: { autofix: true } },
      security: { backfillDays: 30 },
    }));
    const config = getDashboardConfig();
    expect(config.metrics.billing.enabled).toBe(true);
    expect(config.metrics.codeScanning.autofix).toBe(true);
    expect(config.metrics.copilot.enabled).toBe(true); // preserved from defaults
    expect(config.security.backfillDays).toBe(30);
    expect(config.security.syncIntervalMinutes).toBe(60); // default preserved
  });

  it("getResolvedOrgs with include filter", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      organizations: { include: ["org-a"] },
    }));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    process.env.GITHUB_ORGS = "org-a,org-b,org-c";
    const orgs = getResolvedOrgs();
    expect(orgs).toEqual(["org-a"]);
  });

  it("getResolvedOrgs with exclude filter", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      organizations: { exclude: ["org-b"] },
    }));
    vi.setSystemTime(Date.now() + 20 * 60 * 1000);
    process.env.GITHUB_ORGS = "org-a,org-b,org-c";
    const orgs = getResolvedOrgs();
    expect(orgs).toEqual(["org-a", "org-c"]);
  });

  it("isBillingSubEnabled returns true when billing enabled and sub not disabled", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { enabled: true, meteredUsage: true, premiumRequests: true } },
    }));
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    process.env.GITHUB_ENTERPRISE = "test-ent";
    const result = isBillingSubEnabled("meteredUsage");
    expect(result).toBe(true);
    delete process.env.GITHUB_ENTERPRISE;
  });

  it("deep merge preserves autoSync override", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      autoSync: { enabled: true, utcTime: "05:00" },
    }));
    vi.setSystemTime(Date.now() + 40 * 60 * 1000);
    const config = getDashboardConfig();
    expect(config.autoSync?.enabled).toBe(true);
    expect(config.autoSync?.utcTime).toBe("05:00");
  });
});
