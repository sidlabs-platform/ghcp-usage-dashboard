import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
} from "./dashboard-config";

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
});
