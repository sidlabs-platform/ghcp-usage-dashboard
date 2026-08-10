import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";

// Mock fs before importing the module under test
vi.mock("fs", () => ({
  default: {
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  },
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
}));

// Mock enterprise-config (not directly used, but may be required by other modules)
vi.mock("@/lib/config/enterprise-config", () => ({
  getResolvedOrgsForEnterprise: vi.fn(() => []),
}));

// Mock orgs-repo (used by getResolvedOrgs for DB fallback when include is empty)
vi.mock("@/lib/db/orgs-repo", () => ({
  getEnterpriseOrgs: vi.fn(() => []),
}));

// Mock orgs-resolver (used by legacy mode fallback)
vi.mock("./orgs-resolver", () => ({
  getDiscoveredOrgsFromDb: vi.fn(() => []),
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
  getLicensingConfig,
  LicensingConfigError,
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

    it("falls back to DB-discovered orgs when GITHUB_ORGS is empty and GITHUB_ENTERPRISE is set", async () => {
      delete process.env.GITHUB_ORGS;
      process.env.GITHUB_ENTERPRISE = "my-ent";
      const { getDiscoveredOrgsFromDb } = await import("./orgs-resolver");
      const mockFn = getDiscoveredOrgsFromDb as ReturnType<typeof vi.fn>;
      mockFn.mockReturnValue(["discovered-org"]);
      const result = getResolvedOrgs();
      expect(result).toEqual(["discovered-org"]);
      delete process.env.GITHUB_ENTERPRISE;
      mockFn.mockReturnValue([]);
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
  describe("getLicensingConfig", () => {
    it("returns static defaults, including business allowance 1900, when unconfigured", () => {
      const config = getLicensingConfig();
      expect(config.aicAllowance.business).toBe(1900);
      expect(config.aicAllowance.enterprise).toBe(3900);
      expect(config.licenseCost.business).toBe(19);
      expect(config.currency).toBe("USD");
    });

    it("resolves history/identity/aicConsumption/validation to safe defaults when unconfigured", () => {
      const config = getLicensingConfig();
      const now = new Date();
      const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      expect(config.history).toEqual({
        enabled: false,
        reportMonths: [currentMonth],
        auditRetentionDays: 400,
        emitSnapshots: false,
        snapshotDirectory: "data/licensing-snapshots",
        auditArchivePath: "data/licensing-audit",
        identityMapPath: "data/identity-map.json",
      });
      expect(config.identity).toEqual({
        fetchMembership: false,
        fetchEnterpriseIdentities: false,
        fetchOrgIdentities: false,
      });
      expect(config.aicConsumption).toEqual({ mode: "auto", csvPath: undefined, concurrency: 4 });
      expect(config.validation).toEqual({ enabled: true, aicTolerancePct: 5 });
      expect(config.datedAllowances).toEqual([]);
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

  it("isBillingSubEnabled defaults to true when aiCredits is undefined", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { enabled: true } },
    }));
    vi.setSystemTime(Date.now() + 125 * 60 * 1000);
    process.env.GITHUB_ENTERPRISE = "test-ent";
    expect(isBillingSubEnabled("aiCredits")).toBe(true);
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

  // ── Historical licensing config tests (offsets 220+) ──────────────────

  it("getLicensingConfig resolves configured history/identity/aicConsumption/validation settings", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            history: {
              enabled: true,
              reportMonths: "2026-01..2026-03",
              auditRetentionDays: 90,
              emitSnapshots: true,
              snapshotDirectory: "custom/snapshots",
              auditArchivePath: "custom/audit",
              identityMapPath: "custom/identity-map.json",
            },
            identity: { fetchMembership: true, fetchEnterpriseIdentities: true },
            aicConsumption: { mode: "billing_report", csvPath: "custom.csv", concurrency: 8 },
            validation: { enabled: false, aicTolerancePct: 12 },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 220 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.history).toEqual({
      enabled: true,
      reportMonths: ["2026-01", "2026-02", "2026-03"],
      auditRetentionDays: 90,
      emitSnapshots: true,
      snapshotDirectory: "custom/snapshots",
      auditArchivePath: "custom/audit",
      identityMapPath: "custom/identity-map.json",
    });
    expect(config.identity).toEqual({
      fetchMembership: true,
      fetchEnterpriseIdentities: true,
      fetchOrgIdentities: false,
    });
    expect(config.aicConsumption).toEqual({ mode: "billing_report", csvPath: "custom.csv", concurrency: 8 });
    expect(config.validation).toEqual({ enabled: false, aicTolerancePct: 12 });
  });

  it("getLicensingConfig resolves an array of reportMonths tokens to a sorted, de-duplicated string[]", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            history: { reportMonths: ["2026-03", "2026-01..2026-02", "2026-01"] },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 230 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.history.reportMonths).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("getLicensingConfig throws LicensingConfigError on malformed reportMonths syntax", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { reportMonths: "not-a-month" } } } },
    }));
    vi.setSystemTime(Date.now() + 240 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("reportMonths"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a malformed reportMonths range", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { reportMonths: "2026-03..2026-01" } } } },
    }));
    vi.setSystemTime(Date.now() + 250 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);
  });

  it("getLicensingConfig throws LicensingConfigError when auditRetentionDays is outside documented bounds", () => {
    const base = Date.now();

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { auditRetentionDays: 0 } } } },
    }));
    vi.setSystemTime(base + 260 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { auditRetentionDays: 5000 } } } },
    }));
    vi.setSystemTime(base + 270 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    // In-bounds values do not throw.
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { auditRetentionDays: 3650 } } } },
    }));
    vi.setSystemTime(base + 280 * 60 * 1000);
    expect(getLicensingConfig().history.auditRetentionDays).toBe(3650);
  });

  it("getLicensingConfig throws LicensingConfigError when aicConsumption.concurrency is outside documented bounds", () => {
    const base = Date.now();

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { aicConsumption: { concurrency: 0 } } } },
    }));
    vi.setSystemTime(base + 290 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { aicConsumption: { concurrency: 21 } } } },
    }));
    vi.setSystemTime(base + 300 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    // In-bounds values do not throw.
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { aicConsumption: { concurrency: 20 } } } },
    }));
    vi.setSystemTime(base + 310 * 60 * 1000);
    expect(getLicensingConfig().aicConsumption.concurrency).toBe(20);
  });

  it("getLicensingConfig throws LicensingConfigError on an invalid aicConsumption.mode", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { aicConsumption: { mode: "bogus" } } } },
    }));
    vi.setSystemTime(Date.now() + 320 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("aicConsumption.mode"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError when aicTolerancePct is outside 0..100", () => {
    const base = Date.now();

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { validation: { aicTolerancePct: -1 } } } },
    }));
    vi.setSystemTime(base + 330 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { validation: { aicTolerancePct: 101 } } } },
    }));
    vi.setSystemTime(base + 340 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);

    // In-bounds boundary value does not throw.
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { validation: { aicTolerancePct: 0 } } } },
    }));
    vi.setSystemTime(base + 350 * 60 * 1000);
    expect(getLicensingConfig().validation.aicTolerancePct).toBe(0);
  });

  it("getLicensingConfig throws LicensingConfigError on negative licenseCost/aicAllowance values", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            licenseCost: { business: -5 },
            aicAllowance: { enterprise: -100 },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 360 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("licenseCost.business"))).toBe(true);
      expect(details.some((d) => d.includes("aicAllowance.enterprise"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on an unknown plan key in licenseCost/aicAllowance", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            licenseCost: { bogusPlan: 25 },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 370 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("unknown plan key"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a negative/invalid perUserBudgetUsd value", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            perUserBudgetUsd: { "some-user": -10 },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 380 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("perUserBudgetUsd"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a negative/invalid creditToUsd value", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { creditToUsd: -0.01 } } },
    }));
    vi.setSystemTime(Date.now() + 390 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("creditToUsd"))).toBe(true);
    }
  });

  it("getLicensingConfig accepts open-ended dated allowances and boundary dates", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", end: "2026-01-31", credits: { business: 1000 } },
              { start: "2026-02-01", credits: { business: 2000 } }, // open-ended
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 400 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.datedAllowances).toEqual([
      { start: "2026-01-01", end: "2026-01-31", credits: { business: 1000 } },
      { start: "2026-02-01", end: undefined, credits: { business: 2000 } },
    ]);
  });

  it("getLicensingConfig throws LicensingConfigError on overlapping dated allowance windows for the same plan", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", end: "2026-03-31", credits: { business: 1000 } },
              { start: "2026-02-01", end: "2026-04-30", credits: { business: 1500 } }, // overlaps prior window
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 410 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("overlapping windows"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a dated allowance that overlaps an open-ended prior window", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", credits: { business: 1000 } }, // open-ended
              { start: "2026-06-01", end: "2026-07-31", credits: { business: 1500 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 420 * 60 * 1000);
    expect(() => getLicensingConfig()).toThrow(LicensingConfigError);
  });

  it("getLicensingConfig allows adjacent (non-overlapping) dated allowance windows", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", end: "2026-01-31", credits: { business: 1000 } },
              { start: "2026-02-01", end: "2026-02-28", credits: { business: 1500 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 430 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.datedAllowances).toHaveLength(2);
  });

  it("getLicensingConfig throws LicensingConfigError on a dated allowance with an invalid date range (end before start)", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-03-01", end: "2026-01-31", credits: { business: 1000 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 440 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("end") && d.includes("before start"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a dated allowance with a malformed date and with negative credits", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "not-a-date", credits: { business: 1000 } },
              { start: "2026-05-01", credits: { business: -50 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 450 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("malformed start date"))).toBe(true);
      // Error context includes the raw entry index so operators can find the
      // exact offending array element, and it references the value-specific
      // credits error directly (not a redundant "no valid credit values").
      expect(details.some((d) => d.includes("datedAllowances[0]") && d.includes("malformed start date"))).toBe(true);
      expect(details.some((d) => d.includes("datedAllowances[1].business"))).toBe(true);
      expect(details.some((d) => d.includes("no valid credit values"))).toBe(false);
    }
  });

  it("getLicensingConfig throws LicensingConfigError on a dated allowance with an unknown plan key", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", credits: { bogusPlan: 1000 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 460 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("unknown plan key"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError with an entry-index-specific 'no valid credit values' error when an entry has no credits at all", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", credits: {} },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 465 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("datedAllowances[0]") && d.includes("no valid credit values"))).toBe(true);
    }
  });

  it("getLicensingConfig allows overlapping dated allowance windows across different plans", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", end: "2026-03-31", credits: { business: 1000 } },
              // Same time window, different plan — must NOT be treated as an overlap.
              { start: "2026-02-01", end: "2026-04-30", credits: { enterprise: 2000 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 470 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.datedAllowances).toHaveLength(2);
  });

  it("getLicensingConfig rejects a multi-plan entry overlap without partially dropping any entries", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              // Multi-plan entry covering both business and enterprise.
              { start: "2026-01-01", end: "2026-03-31", credits: { business: 1000, enterprise: 2000 } },
              // Only overlaps the business side of the entry above.
              { start: "2026-02-01", end: "2026-04-30", credits: { business: 1500 } },
              // A later, otherwise-valid entry that must still surface in the
              // error set rather than being silently dropped/ignored.
              { start: "2026-05-01", end: "2026-06-30", credits: { business: 1700 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 480 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("overlapping windows") && d.includes('"business"'))).toBe(true);
      // The enterprise plan in the multi-plan entry never actually overlaps
      // with anything else, so it must not be falsely flagged.
      expect(details.some((d) => d.includes("overlapping windows") && d.includes('"enterprise"'))).toBe(false);
    }
  });

  it("getLicensingConfig keeps an open-ended dated allowance window sticky across multiple later overlapping entries", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            datedAllowances: [
              { start: "2026-01-01", credits: { business: 1000 } }, // open-ended
              { start: "2026-02-01", end: "2026-02-28", credits: { business: 1200 } }, // overlaps
              // Starts after the second entry's own end (2026-02-28), so a
              // buggy implementation that replaces the sticky open-ended
              // marker with the second entry's bounded end would wrongly
              // treat this as non-overlapping. The original open-ended
              // window must still cover it.
              { start: "2026-04-01", end: "2026-04-30", credits: { business: 1300 } },
            ],
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 490 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const overlapErrors = (err as LicensingConfigError).details.filter(
        (d) => d.includes("overlapping windows") && d.includes('"business"')
      );
      expect(overlapErrors.length).toBeGreaterThanOrEqual(2);
    }
  });

  // ── Runtime type validation for explicitly-configured nonnumeric fields ──

  it("getLicensingConfig throws LicensingConfigError when history.enabled/emitSnapshots are configured with the wrong type", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            history: { enabled: "yes", emitSnapshots: 1 },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 500 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("history.enabled") && d.includes("boolean"))).toBe(true);
      expect(details.some((d) => d.includes("history.emitSnapshots") && d.includes("boolean"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError when identity toggles are configured with the wrong type", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            identity: { fetchMembership: "true", fetchEnterpriseIdentities: 0, fetchOrgIdentities: null },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 510 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("identity.fetchMembership"))).toBe(true);
      expect(details.some((d) => d.includes("identity.fetchEnterpriseIdentities"))).toBe(true);
      // `null` is treated as "not configured" — documented default absence
      // semantics — so it should not raise a type error.
      expect(details.some((d) => d.includes("identity.fetchOrgIdentities"))).toBe(false);
    }
  });

  it("getLicensingConfig throws LicensingConfigError when validation.enabled is configured with the wrong type", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { validation: { enabled: "false" } } } },
    }));
    vi.setSystemTime(Date.now() + 520 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("validation.enabled"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError when snapshotDirectory/auditArchivePath/identityMapPath are configured with the wrong type or empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            history: { snapshotDirectory: "", auditArchivePath: 123, identityMapPath: "   " },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 530 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("history.snapshotDirectory"))).toBe(true);
      expect(details.some((d) => d.includes("history.auditArchivePath"))).toBe(true);
      expect(details.some((d) => d.includes("history.identityMapPath"))).toBe(true);
    }
  });

  it("getLicensingConfig throws LicensingConfigError when aicConsumption.csvPath is configured empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { aicConsumption: { csvPath: "" } } } },
    }));
    vi.setSystemTime(Date.now() + 540 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("aicConsumption.csvPath"))).toBe(true);
    }
  });

  it("getLicensingConfig leaves aicConsumption.csvPath undefined by default (optional-absence semantics preserved)", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: {} } },
    }));
    vi.setSystemTime(Date.now() + 545 * 60 * 1000);
    expect(getLicensingConfig().aicConsumption.csvPath).toBeUndefined();
  });

  it("getLicensingConfig throws LicensingConfigError when currency is configured with the wrong type or empty", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { currency: 456 } } },
    }));
    vi.setSystemTime(Date.now() + 550 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect((err as LicensingConfigError).details.some((d) => d.includes("currency"))).toBe(true);
    }
  });

  it("getLicensingConfig accepts correctly-typed boolean/string fields without throwing", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: {
        billing: {
          licensing: {
            currency: "EUR",
            history: {
              enabled: true,
              emitSnapshots: true,
              snapshotDirectory: "custom/snap",
              auditArchivePath: "custom/audit",
              identityMapPath: "custom/id.json",
            },
            identity: { fetchMembership: true, fetchEnterpriseIdentities: false, fetchOrgIdentities: true },
            aicConsumption: { csvPath: "consumption.csv" },
            validation: { enabled: false },
          },
        },
      },
    }));
    vi.setSystemTime(Date.now() + 560 * 60 * 1000);
    const config = getLicensingConfig();
    expect(config.currency).toBe("EUR");
    expect(config.history.enabled).toBe(true);
    expect(config.history.snapshotDirectory).toBe("custom/snap");
    expect(config.identity.fetchOrgIdentities).toBe(true);
    expect(config.aicConsumption.csvPath).toBe("consumption.csv");
    expect(config.validation.enabled).toBe(false);
  });

  it("getLicensingConfig throws a LicensingConfigError (not a TypeError) when datedAllowances is a plain object instead of an array", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { datedAllowances: { business: 1000 } } } },
    }));
    vi.setSystemTime(Date.now() + 570 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect(err).not.toBeInstanceOf(TypeError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("datedAllowances") && d.includes("must be an array"))).toBe(true);
    }
  });

  it("getLicensingConfig throws a LicensingConfigError (not a TypeError) when datedAllowances is a string instead of an array", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { datedAllowances: "not-an-array" } } },
    }));
    vi.setSystemTime(Date.now() + 580 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      expect(err).not.toBeInstanceOf(TypeError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("datedAllowances") && d.includes("must be an array"))).toBe(true);
    }
  });

  it("getLicensingConfig treats datedAllowances: null the same as unconfigured (empty array, no error)", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { datedAllowances: null } } },
    }));
    vi.setSystemTime(Date.now() + 590 * 60 * 1000);
    expect(getLicensingConfig().datedAllowances).toEqual([]);
  });

  it("getLicensingConfig treats history.reportMonths: null the same as unconfigured, resolving to the current month", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { reportMonths: null } } } },
    }));
    vi.setSystemTime(Date.now() + 600 * 60 * 1000);
    const config = getLicensingConfig();
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(config.history.reportMonths).toEqual([currentMonth]);
  });

  it("getLicensingConfig throws LicensingConfigError when history.reportMonths contains a non-string array entry", () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      metrics: { billing: { licensing: { history: { reportMonths: ["2026-01", 2026] } } } },
    }));
    vi.setSystemTime(Date.now() + 610 * 60 * 1000);
    try {
      getLicensingConfig();
      expect.unreachable("expected getLicensingConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LicensingConfigError);
      const details = (err as LicensingConfigError).details;
      expect(details.some((d) => d.includes("reportMonths") && d.includes("expected a string"))).toBe(true);
    }
  });
});
