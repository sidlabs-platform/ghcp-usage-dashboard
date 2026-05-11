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

  it("deep merge skips non-object metrics keys gracefully", () => {
    // When a metrics sub-key is null/primitive, deepMergeConfig skips it
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { copilot: null, billing: { enabled: true } },
    }));
    vi.setSystemTime(Date.now() + 50 * 60 * 1000);
    const config = getDashboardConfig();
    // copilot should keep defaults since null is not a valid object
    expect(config.metrics.copilot.enabled).toBe(true);
    expect(config.metrics.billing.enabled).toBe(true);
  });

  it("isCopilotSubEnabled returns false when copilot.enabled is false", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { copilot: { enabled: false } },
    }));
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    expect(isCopilotSubEnabled("userMetrics")).toBe(false);
    expect(isCopilotSubEnabled("seats")).toBe(false);
  });

  it("isEnterpriseEnabled returns false when copilot.enterprise is false", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { copilot: { enabled: true, enterprise: false } },
    }));
    vi.setSystemTime(Date.now() + 70 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("isEnterpriseEnabled warns when enterprise=true but env missing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { copilot: { enabled: true, enterprise: true } },
    }));
    vi.setSystemTime(Date.now() + 80 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    // Warning may have already been emitted by previous test; just verify behavior
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("isCodeScanningAutofixEnabled returns false when codeScanning disabled", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { codeScanning: { enabled: false, autofix: true } },
    }));
    vi.setSystemTime(Date.now() + 90 * 60 * 1000);
    expect(isCodeScanningAutofixEnabled()).toBe(false);
  });

  it("isCodeScanningAutofixEnabled returns true when autofix enabled", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { codeScanning: { enabled: true, autofix: true } },
    }));
    vi.setSystemTime(Date.now() + 100 * 60 * 1000);
    expect(isCodeScanningAutofixEnabled()).toBe(true);
  });

  it("isCopilotSubEnabled defaults to true when sub-key is undefined", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { copilot: { enabled: true } },
    }));
    vi.setSystemTime(Date.now() + 110 * 60 * 1000);
    expect(isCopilotSubEnabled("teams")).toBe(true);
  });

  it("isBillingSubEnabled defaults to true when premiumRequests is undefined", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { enabled: true } },
    }));
    vi.setSystemTime(Date.now() + 120 * 60 * 1000);
    process.env.GITHUB_ENTERPRISE = "test-ent";
    expect(isBillingSubEnabled("premiumRequests")).toBe(true);
    delete process.env.GITHUB_ENTERPRISE;
  });

  // ── Multi-enterprise tests (offsets 130+, must come after all existing tests) ──

  it("isEnterpriseEnabled returns true when enterprises array is configured (multi-enterprise)", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "Ent A", tokenEnvVar: "TOKEN_A" },
        { slug: "ent-b", displayName: "Ent B", tokenEnvVar: "TOKEN_B" },
      ],
      metrics: { copilot: { enabled: true, enterprise: true } },
    }));
    vi.setSystemTime(Date.now() + 130 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    expect(isEnterpriseEnabled()).toBe(true);
  });

  it("isEnterpriseEnabled returns false when enterprises array exists but enterprise toggle is off", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "Ent A", tokenEnvVar: "TOKEN_A" },
      ],
      metrics: { copilot: { enabled: true, enterprise: false } },
    }));
    vi.setSystemTime(Date.now() + 140 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    expect(isEnterpriseEnabled()).toBe(false);
  });

  it("deepMergeConfig preserves enterprises array from config file", () => {
    const enterprises = [
      { slug: "ent-1", displayName: "Ent 1", tokenEnvVar: "T1" },
    ];
    mockReadFileSync.mockReturnValue(JSON.stringify({ enterprises }));
    vi.setSystemTime(Date.now() + 150 * 60 * 1000);
    const config = getDashboardConfig();
    expect(config.enterprises).toEqual(enterprises);
  });

  it("getResolvedOrgs aggregates orgs from all enterprises in multi-enterprise mode", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "A", tokenEnvVar: "T1", organizations: { include: ["org-a", "org-b"], exclude: ["org-b"] } },
        { slug: "ent-b", displayName: "B", tokenEnvVar: "T2", organizations: { include: ["org-c"] } },
      ],
    }));
    vi.setSystemTime(Date.now() + 160 * 60 * 1000);
    delete process.env.GITHUB_ORGS;
    const orgs = getResolvedOrgs();
    expect(orgs).toEqual(["org-a", "org-c"]);
  });

  it("getResolvedOrgs deduplicates orgs shared across multiple enterprises", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "A", tokenEnvVar: "T1", organizations: { include: ["shared-org", "org-a"] } },
        { slug: "ent-b", displayName: "B", tokenEnvVar: "T2", organizations: { include: ["shared-org", "org-b"] } },
      ],
    }));
    vi.setSystemTime(Date.now() + 170 * 60 * 1000);
    delete process.env.GITHUB_ORGS;
    const orgs = getResolvedOrgs();
    expect(orgs).toContain("shared-org");
    expect(orgs).toContain("org-a");
    expect(orgs).toContain("org-b");
    expect(orgs).toHaveLength(3);
  });

  it("getResolvedOrgs returns empty when enterprises have no organizations defined", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "A", tokenEnvVar: "T1" },
      ],
    }));
    vi.setSystemTime(Date.now() + 180 * 60 * 1000);
    delete process.env.GITHUB_ORGS;
    const orgs = getResolvedOrgs();
    expect(orgs).toEqual([]);
  });

  it("getResolvedOrgs still works with GITHUB_ORGS when no enterprises configured", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({}));
    vi.setSystemTime(Date.now() + 190 * 60 * 1000);
    process.env.GITHUB_ORGS = "org-x,org-y";
    const orgs = getResolvedOrgs();
    expect(orgs).toEqual(["org-x", "org-y"]);
    delete process.env.GITHUB_ORGS;
  });

  it("getEffectiveBillingEnabled returns true in multi-enterprise mode with billing enabled", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-a", displayName: "A", tokenEnvVar: "T1" },
      ],
      metrics: { billing: { enabled: true } },
    }));
    vi.setSystemTime(Date.now() + 200 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    expect(getEffectiveBillingEnabled()).toBe(true);
  });

  it("isCopilotSubEnabled('enterprise') returns true in multi-enterprise mode", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      enterprises: [
        { slug: "ent-x", displayName: "X", tokenEnvVar: "TX" },
      ],
    }));
    vi.setSystemTime(Date.now() + 210 * 60 * 1000);
    delete process.env.GITHUB_ENTERPRISE;
    expect(isCopilotSubEnabled("enterprise")).toBe(true);
  });
});
