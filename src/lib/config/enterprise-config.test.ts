import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getConfiguredEnterprises,
  getEnterpriseConfig,
  getClientEnterpriseList,
  getEnterpriseAuth,
  isMultiEnterprise,
  getEnterpriseSlugs,
  getResolvedOrgsForEnterprise,
  resetEnterpriseConfigCache,
  resolveDefaultScope,
  isMetricEnabledForEnterprise,
  isCopilotSubEnabledForEnterprise,
  isBillingEnabledForEnterprise,
  isBillingSubEnabledForEnterprise,
  isCodeScanningAutofixEnabledForEnterprise,
  isMetricEnabledForAnyEnterprise,
  isCopilotSubEnabledForAnyEnterprise,
  isBillingSubEnabledForAnyEnterprise,
  isLicensingHistoryEnabledForEnterprise,
  isLicensingHistoryEnabledForAnyEnterprise,
  getClientEnterpriseMetrics,
  isOrgOnlyEnterprise,
} from "./enterprise-config";
import { getDashboardConfig, getResolvedOrgs, getLicensingConfig, DashboardConfig, ResolvedLicensingConfig } from "./dashboard-config";

// Mock the dashboard-config module
vi.mock("./dashboard-config", () => ({
  getDashboardConfig: vi.fn(() => ({
    enterprises: [
      {
        slug: "acme-corp",
        displayName: "Acme Corp",
        tokenEnvVar: "ACME_TOKEN",
        appIdEnvVar: "ACME_APP_ID",
        appPrivateKeyEnvVar: "ACME_APP_KEY",
        appInstallationIdEnvVar: "ACME_APP_INSTALL",
        organizations: { include: ["org-a", "org-b"], exclude: ["org-b"] },
      },
      {
        slug: "beta-inc",
        displayName: "Beta Inc",
        tokenEnvVar: "BETA_TOKEN",
        organizations: { include: ["org-x"] },
      },
    ],
  })),
  getResolvedOrgs: vi.fn(() => []),
  // Default: licensing history disabled, matching the real DEFAULT_LICENSING
  // fallback used when no `metrics.billing.licensing` block is configured.
  // Individual tests override this via `mockGetLicensingConfig.mockReturnValue(...)`.
  getLicensingConfig: vi.fn(() => ({
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 0, enterprise: 0, unknown: 0 },
    perUserBudgetUsd: {},
    datedAllowances: [],
    history: {
      enabled: false,
      reportMonths: [],
      auditRetentionDays: 400,
      emitSnapshots: false,
      snapshotDirectory: "data/licensing-snapshots",
      auditArchivePath: "data/licensing-audit",
      identityMapPath: "data/identity-map.json",
    },
    identity: { fetchMembership: false, fetchEnterpriseIdentities: false, fetchOrgIdentities: false },
    aicConsumption: { mode: "auto", concurrency: 4 },
    validation: { enabled: true, aicTolerancePct: 5 },
  })),
}));

const mockGetLicensingConfig = vi.mocked(getLicensingConfig);

/** Builds a full ResolvedLicensingConfig fixture, deep-overriding only `history` for readability (the field every test in this file cares about). */
function makeResolvedLicensingConfig(
  overrides: { history?: Partial<ResolvedLicensingConfig["history"]> } = {},
): ResolvedLicensingConfig {
  return {
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 0, enterprise: 0, unknown: 0 },
    perUserBudgetUsd: {},
    datedAllowances: [],
    history: {
      enabled: false,
      reportMonths: [],
      auditRetentionDays: 400,
      emitSnapshots: false,
      snapshotDirectory: "data/licensing-snapshots",
      auditArchivePath: "data/licensing-audit",
      identityMapPath: "data/identity-map.json",
      ...overrides.history,
    },
    identity: { fetchMembership: false, fetchEnterpriseIdentities: false, fetchOrgIdentities: false },
    aicConsumption: { mode: "auto", concurrency: 4 },
    validation: { enabled: true, aicTolerancePct: 5 },
  };
}

vi.mock("./orgs-resolver", () => ({
  getDiscoveredOrgsFromDb: vi.fn((slug: string) => [`mocked-${slug}`]),
}));

const mockGetDashboardConfig = vi.mocked(getDashboardConfig);

describe("enterprise-config", () => {
  beforeEach(() => {
    resetEnterpriseConfigCache();
    process.env.ACME_TOKEN = "ghp_acme123";
    process.env.ACME_APP_ID = "12345";
    process.env.ACME_APP_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----";
    process.env.ACME_APP_INSTALL = "67890";
    process.env.BETA_TOKEN = "ghp_beta456";
  });

  afterEach(() => {
    delete process.env.ACME_TOKEN;
    delete process.env.ACME_APP_ID;
    delete process.env.ACME_APP_KEY;
    delete process.env.ACME_APP_INSTALL;
    delete process.env.BETA_TOKEN;
    delete process.env.GITHUB_ENTERPRISE;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_ORGS;
    mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig());
  });

  describe("getConfiguredEnterprises", () => {
    it("returns the configured enterprises from config", () => {
      const enterprises = getConfiguredEnterprises();
      expect(enterprises).toHaveLength(2);
      expect(enterprises[0].slug).toBe("acme-corp");
      expect(enterprises[1].slug).toBe("beta-inc");
    });
  });

  describe("getEnterpriseConfig", () => {
    it("returns config for a valid slug", () => {
      const config = getEnterpriseConfig("acme-corp");
      expect(config.displayName).toBe("Acme Corp");
      expect(config.tokenEnvVar).toBe("ACME_TOKEN");
    });

    it("throws for unknown slug", () => {
      expect(() => getEnterpriseConfig("unknown")).toThrow('Enterprise "unknown" not found');
    });

    it("throws with (none) when enterprises list is empty", () => {
      (getDashboardConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({ enterprises: [] });
      resetEnterpriseConfigCache();
      expect(() => getEnterpriseConfig("anything")).toThrow("(none)");
      resetEnterpriseConfigCache();
    });
  });

  describe("getClientEnterpriseList", () => {
    it("returns only slug and displayName", () => {
      const list = getClientEnterpriseList();
      expect(list).toEqual([
        { slug: "acme-corp", displayName: "Acme Corp" },
        { slug: "beta-inc", displayName: "Beta Inc" },
      ]);
    });
  });

  describe("getEnterpriseAuth", () => {
    it("resolves token from env var", () => {
      const auth = getEnterpriseAuth("acme-corp");
      expect(auth.token).toBe("ghp_acme123");
    });

    it("resolves app config when all env vars are set", () => {
      const auth = getEnterpriseAuth("acme-corp");
      expect(auth.appConfig).toBeDefined();
      expect(auth.appConfig!.appId).toBe("12345");
      expect(auth.appConfig!.installationId).toBe("67890");
    });

    it("returns undefined appConfig when no app env vars configured", () => {
      const auth = getEnterpriseAuth("beta-inc");
      expect(auth.appConfig).toBeUndefined();
    });

    it("throws when token env var is not set", () => {
      delete process.env.BETA_TOKEN;
      expect(() => getEnterpriseAuth("beta-inc")).toThrow("BETA_TOKEN");
    });

    it("returns undefined appConfig when app env vars exist but are empty", () => {
      delete process.env.ACME_APP_ID;
      resetEnterpriseConfigCache();
      const auth = getEnterpriseAuth("acme-corp");
      expect(auth.token).toBe("ghp_acme123");
      expect(auth.appConfig).toBeUndefined();
    });
  });

  describe("isMultiEnterprise", () => {
    it("returns true when multiple enterprises configured", () => {
      expect(isMultiEnterprise()).toBe(true);
    });
  });

  describe("getEnterpriseSlugs", () => {
    it("returns all slugs", () => {
      expect(getEnterpriseSlugs()).toEqual(["acme-corp", "beta-inc"]);
    });
  });

  describe("getResolvedOrgsForEnterprise", () => {
    it("applies exclude filter to included orgs", () => {
      const orgs = getResolvedOrgsForEnterprise("acme-corp");
      expect(orgs).toEqual(["org-a"]);
    });

    it("returns all included orgs when no excludes", () => {
      const orgs = getResolvedOrgsForEnterprise("beta-inc");
      expect(orgs).toEqual(["org-x"]);
    });

    it("falls back to DB-discovered orgs when organizations config is undefined", () => {
      mockGetDashboardConfig.mockReturnValue({
        enterprises: [{ slug: "no-orgs", displayName: "No Orgs", tokenEnvVar: "T", organizations: {} }],
      } as unknown as DashboardConfig);
      resetEnterpriseConfigCache();
      const orgs = getResolvedOrgsForEnterprise("no-orgs");
      expect(orgs).toEqual(["mocked-no-orgs"]);
      resetEnterpriseConfigCache();
      // the global before/after reset will handle restoring the mock
    });
  });

  describe("legacy env var synthesis", () => {
    it("synthesizes config from env vars when no enterprises in config", () => {
      resetEnterpriseConfigCache();
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as unknown as DashboardConfig);
      process.env.GITHUB_ENTERPRISE = "legacy-ent";
      process.env.GITHUB_TOKEN = "ghp_legacy";
      process.env.GITHUB_ORGS = "org1, org2";
      const enterprises = getConfiguredEnterprises();
      expect(enterprises).toHaveLength(1);
      expect(enterprises[0].slug).toBe("legacy-ent");
      expect(enterprises[0].organizations?.include).toEqual(["org1", "org2"]);
      delete process.env.GITHUB_ENTERPRISE;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_ORGS;
    });

    it("returns empty when no config and no env vars", () => {
      resetEnterpriseConfigCache();
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as unknown as DashboardConfig);
      delete process.env.GITHUB_ENTERPRISE;
      const enterprises = getConfiguredEnterprises();
      expect(enterprises).toEqual([]);
    });

    it("includes app env vars in synthesis when all are set", () => {
      resetEnterpriseConfigCache();
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as unknown as DashboardConfig);
      process.env.GITHUB_ENTERPRISE = "legacy-ent";
      process.env.GITHUB_TOKEN = "ghp_legacy";
      process.env.GITHUB_APP_ID = "app1";
      process.env.GITHUB_APP_PRIVATE_KEY = "key1";
      process.env.GITHUB_APP_INSTALLATION_ID = "inst1";
      const enterprises = getConfiguredEnterprises();
      expect(enterprises[0].appIdEnvVar).toBe("GITHUB_APP_ID");
      delete process.env.GITHUB_ENTERPRISE;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_APP_INSTALLATION_ID;
    });
  });

  describe("caching", () => {
    it("returns cached result on second call within TTL", () => {
      const first = getConfiguredEnterprises();
      const second = getConfiguredEnterprises();
      expect(second).toBe(first);
    });
  });

  // ── Per-enterprise metric resolution tests ─────────────────────────

  // Helper to build a full mock config with enterprise metric overrides
  function makeConfig(overrides: {
    globalMetrics?: Record<string, unknown>;
    enterprises?: Array<{
      slug: string;
      displayName?: string;
      tokenEnvVar?: string;
      metrics?: Record<string, unknown>;
    }>;
  }) {
    const defaultGlobalMetrics = {
      copilot: { enabled: true, enterprise: true, userMetrics: true, seats: true, teams: true },
      codeScanning: { enabled: true, autofix: false },
      dependabot: { enabled: true },
      secretScanning: { enabled: true },
      billing: { enabled: true, meteredUsage: true, premiumRequests: true },
    };

    return {
      enterprises: (overrides.enterprises ?? [
        { slug: "ent-a", displayName: "Ent A", tokenEnvVar: "T_A" },
        { slug: "ent-b", displayName: "Ent B", tokenEnvVar: "T_B" },
      ]).map((e) => ({
        displayName: e.slug,
        tokenEnvVar: `${e.slug.toUpperCase().replace(/-/g, "_")}_TOKEN`,
        ...e,
      })),
      // Shallow spread replaces entire metric category objects, which exercises
      // the production code's `?? true` / `?? false` fallbacks for missing sub-toggles.
      metrics: { ...defaultGlobalMetrics, ...overrides.globalMetrics },
    };
  }

  function setMockConfig(cfg: ReturnType<typeof makeConfig>) {
    mockGetDashboardConfig.mockReturnValue(cfg as unknown as DashboardConfig);
    resetEnterpriseConfigCache();
  }

  describe("isMetricEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns global value when enterprise has no override", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isMetricEnabledForEnterprise("ent-a", "copilot")).toBe(true);
    });

    it("enterprise override enabled:false takes precedence over global enabled:true", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true } },
        enterprises: [{ slug: "ent-a", metrics: { copilot: { enabled: false } } }],
      }));
      expect(isMetricEnabledForEnterprise("ent-a", "copilot")).toBe(false);
    });

    it("enterprise override enabled:true takes precedence over global enabled:false", () => {
      setMockConfig(makeConfig({
        globalMetrics: { dependabot: { enabled: false } },
        enterprises: [{ slug: "ent-a", metrics: { dependabot: { enabled: true } } }],
      }));
      expect(isMetricEnabledForEnterprise("ent-a", "dependabot")).toBe(true);
    });

    it("falls back to global disabled when no override", () => {
      setMockConfig(makeConfig({
        globalMetrics: { secretScanning: { enabled: false } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isMetricEnabledForEnterprise("ent-a", "secretScanning")).toBe(false);
    });

    it("works for all metric categories", () => {
      const categories = ["copilot", "codeScanning", "dependabot", "secretScanning", "billing"] as const;
      for (const cat of categories) {
        setMockConfig(makeConfig({
          globalMetrics: { [cat]: { enabled: true } },
          enterprises: [{ slug: "ent-a", metrics: { [cat]: { enabled: false } } }],
        }));
        expect(isMetricEnabledForEnterprise("ent-a", cat)).toBe(false);
      }
    });

    it("defaults to true when global config has no explicit enabled field", () => {
      setMockConfig(makeConfig({
        globalMetrics: { dependabot: {} },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isMetricEnabledForEnterprise("ent-a", "dependabot")).toBe(true);
    });
  });

  describe("isCopilotSubEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns false when copilot is disabled for the enterprise", () => {
      setMockConfig(makeConfig({
        enterprises: [{ slug: "ent-a", metrics: { copilot: { enabled: false } } }],
      }));
      expect(isCopilotSubEnabledForEnterprise("ent-a", "userMetrics")).toBe(false);
    });

    it("enterprise sub-toggle override takes precedence over global", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, seats: true } },
        enterprises: [{ slug: "ent-a", metrics: { copilot: { seats: false } } }],
      }));
      expect(isCopilotSubEnabledForEnterprise("ent-a", "seats")).toBe(false);
    });

    it("falls back to global sub-toggle when no enterprise override", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, teams: false } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isCopilotSubEnabledForEnterprise("ent-a", "teams")).toBe(false);
    });

    it("defaults sub-toggle to true when not explicitly set globally", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isCopilotSubEnabledForEnterprise("ent-a", "userMetrics")).toBe(true);
    });

    it("pullRequests sub-toggle can be overridden per enterprise", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, pullRequests: false } },
        enterprises: [{ slug: "ent-a", metrics: { copilot: { pullRequests: true } } }],
      }));
      expect(isCopilotSubEnabledForEnterprise("ent-a", "pullRequests")).toBe(true);
    });

    it("all sub-toggle keys work correctly", () => {
      const subs = ["enterprise", "userMetrics", "seats", "teams", "pullRequests"] as const;
      for (const sub of subs) {
        setMockConfig(makeConfig({
          globalMetrics: { copilot: { enabled: true, [sub]: true } },
          enterprises: [{ slug: "ent-a", metrics: { copilot: { [sub]: false } } }],
        }));
        expect(isCopilotSubEnabledForEnterprise("ent-a", sub)).toBe(false);
      }
    });
  });

  describe("isBillingEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns false when copilot enterprise sub-toggle is disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: false },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("returns false when billing category is globally disabled and no override", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("returns true when both copilot.enterprise and billing are enabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingEnabledForEnterprise("ent-a")).toBe(true);
    });

    it("enterprise billing override overrides global disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { enabled: true } } }],
      }));
      expect(isBillingEnabledForEnterprise("ent-a")).toBe(true);
    });

    it("returns false when copilot itself is disabled for enterprise", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a", metrics: { copilot: { enabled: false } } }],
      }));
      expect(isBillingEnabledForEnterprise("ent-a")).toBe(false);
    });
  });

  describe("isBillingSubEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns false when billing is disabled for enterprise", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "meteredUsage")).toBe(false);
    });

    it("enterprise override for meteredUsage takes precedence", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: true },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { meteredUsage: false } } }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "meteredUsage")).toBe(false);
    });

    it("enterprise override for premiumRequests takes precedence", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, premiumRequests: false },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { premiumRequests: true } } }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "premiumRequests")).toBe(true);
    });

    it("falls back to global billing sub-toggle", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: false },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "meteredUsage")).toBe(false);
    });

    it("defaults to true when sub not explicitly set globally", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "meteredUsage")).toBe(true);
      expect(isBillingSubEnabledForEnterprise("ent-a", "premiumRequests")).toBe(true);
      expect(isBillingSubEnabledForEnterprise("ent-a", "aiCredits")).toBe(true);
    });

    it("enterprise override for aiCredits takes precedence over global", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, aiCredits: false },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { aiCredits: true } } }],
      }));
      expect(isBillingSubEnabledForEnterprise("ent-a", "aiCredits")).toBe(true);
    });
  });

  describe("isCodeScanningAutofixEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns false when codeScanning category is disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: false, autofix: true } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isCodeScanningAutofixEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("enterprise autofix override takes precedence over global", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: true, autofix: false } },
        enterprises: [{ slug: "ent-a", metrics: { codeScanning: { autofix: true } } }],
      }));
      expect(isCodeScanningAutofixEnabledForEnterprise("ent-a")).toBe(true);
    });

    it("falls back to global autofix setting (default false)", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: true } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isCodeScanningAutofixEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("returns false when enterprise overrides codeScanning to disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: true, autofix: true } },
        enterprises: [{ slug: "ent-a", metrics: { codeScanning: { enabled: false } } }],
      }));
      expect(isCodeScanningAutofixEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("returns true when globally enabled and enterprise has no override", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: true, autofix: true } },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isCodeScanningAutofixEnabledForEnterprise("ent-a")).toBe(true);
    });
  });

  describe("isMetricEnabledForAnyEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns true when at least one enterprise has metric enabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { dependabot: { enabled: true } },
        enterprises: [
          { slug: "ent-a", metrics: { dependabot: { enabled: false } } },
          { slug: "ent-b" },
        ],
      }));
      expect(isMetricEnabledForAnyEnterprise("dependabot")).toBe(true);
    });

    it("returns false when all enterprises have metric disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { dependabot: { enabled: true } },
        enterprises: [
          { slug: "ent-a", metrics: { dependabot: { enabled: false } } },
          { slug: "ent-b", metrics: { dependabot: { enabled: false } } },
        ],
      }));
      expect(isMetricEnabledForAnyEnterprise("dependabot")).toBe(false);
    });

    it("handles mixed enabled/disabled enterprises", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: false } },
        enterprises: [
          { slug: "ent-a" },
          { slug: "ent-b", metrics: { copilot: { enabled: true } } },
        ],
      }));
      expect(isMetricEnabledForAnyEnterprise("copilot")).toBe(true);
    });

    it("legacy mode (0 enterprises) falls back to global enabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { codeScanning: { enabled: true } },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isMetricEnabledForAnyEnterprise("codeScanning")).toBe(true);
    });

    it("legacy mode (0 enterprises) falls back to global disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { billing: { enabled: false } },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isMetricEnabledForAnyEnterprise("billing")).toBe(false);
    });

    it("legacy mode defaults to true when no explicit enabled field", () => {
      setMockConfig(makeConfig({
        globalMetrics: { secretScanning: {} },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isMetricEnabledForAnyEnterprise("secretScanning")).toBe(true);
    });
  });

  describe("isCopilotSubEnabledForAnyEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns true when at least one enterprise has sub enabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, seats: true } },
        enterprises: [
          { slug: "ent-a", metrics: { copilot: { seats: false } } },
          { slug: "ent-b" },
        ],
      }));
      expect(isCopilotSubEnabledForAnyEnterprise("seats")).toBe(true);
    });

    it("returns false when all enterprises have sub disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, teams: true } },
        enterprises: [
          { slug: "ent-a", metrics: { copilot: { teams: false } } },
          { slug: "ent-b", metrics: { copilot: { teams: false } } },
        ],
      }));
      expect(isCopilotSubEnabledForAnyEnterprise("teams")).toBe(false);
    });

    it("legacy mode falls back to global copilot config", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true, userMetrics: true } },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isCopilotSubEnabledForAnyEnterprise("userMetrics")).toBe(true);
    });

    it("legacy mode returns false when copilot globally disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: false } },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isCopilotSubEnabledForAnyEnterprise("seats")).toBe(false);
    });

    it("legacy mode defaults sub to true when not explicitly set", () => {
      setMockConfig(makeConfig({
        globalMetrics: { copilot: { enabled: true } },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isCopilotSubEnabledForAnyEnterprise("pullRequests")).toBe(true);
    });
  });

  describe("isBillingSubEnabledForAnyEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns true when at least one enterprise has billing sub enabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: true },
        },
        enterprises: [
          { slug: "ent-a", metrics: { billing: { meteredUsage: false } } },
          { slug: "ent-b" },
        ],
      }));
      expect(isBillingSubEnabledForAnyEnterprise("meteredUsage")).toBe(true);
    });

    it("returns false when all enterprises have billing sub disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, premiumRequests: true },
        },
        enterprises: [
          { slug: "ent-a", metrics: { billing: { premiumRequests: false } } },
          { slug: "ent-b", metrics: { billing: { premiumRequests: false } } },
        ],
      }));
      expect(isBillingSubEnabledForAnyEnterprise("premiumRequests")).toBe(false);
    });

    it("legacy mode falls back to global billing config", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: true },
        },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      // Legacy mode with 0 enterprises: billing requires enterprise mode
      // isBillingSubEnabledForAnyEnterprise checks isBillingSubEnabledForEnterprise
      // which chains through isBillingEnabledForEnterprise -> isCopilotSubEnabledForEnterprise(enterprise)
      // With 0 enterprises, it falls back directly to global config check
      expect(isBillingSubEnabledForAnyEnterprise("meteredUsage")).toBe(true);
    });

    it("legacy mode returns false when billing globally disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(isBillingSubEnabledForAnyEnterprise("meteredUsage")).toBe(false);
    });

    it("returns false when copilot enterprise mode disabled globally", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: false },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      expect(isBillingSubEnabledForAnyEnterprise("meteredUsage")).toBe(false);
    });

    it("legacy mode defaults billing sub to true when not explicitly set", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [],
      }));
      expect(isBillingSubEnabledForAnyEnterprise("meteredUsage")).toBe(true);
      expect(isBillingSubEnabledForAnyEnterprise("premiumRequests")).toBe(true);
    });
  });

  describe("getClientEnterpriseMetrics", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns resolved metric states per enterprise", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true },
          codeScanning: { enabled: true },
          dependabot: { enabled: true },
          secretScanning: { enabled: true },
          billing: { enabled: false },
        },
        enterprises: [
          { slug: "ent-a" },
          { slug: "ent-b", metrics: { copilot: { enabled: false }, billing: { enabled: true } } },
        ],
      }));
      const result = getClientEnterpriseMetrics();
      expect(result["ent-a"]).toEqual({
        copilot: true,
        codeScanning: true,
        dependabot: true,
        secretScanning: true,
        billing: false,
      });
      expect(result["ent-b"]).toEqual({
        copilot: false,
        codeScanning: true,
        dependabot: true,
        secretScanning: true,
        billing: true,
      });
    });

    it("returns empty object when no enterprises configured", () => {
      setMockConfig(makeConfig({ enterprises: [] }));
      delete process.env.GITHUB_ENTERPRISE;
      expect(getClientEnterpriseMetrics()).toEqual({});
    });
  });

  // ── Task 12: per-enterprise historical licensing visibility ───────────
  //
  // Historical licensing configuration (`metrics.billing.licensing.history`)
  // is resolved once, globally, by `getLicensingConfig()` — these helpers
  // let an individual enterprise override just the `enabled` flag (via a
  // narrow `licensingHistoryEnabled` boolean override, never the full
  // sensitive `LicensingConfig` shape) without needing a new schema/config
  // migration, and without ever invalidating the global resolved config.

  describe("isLicensingHistoryEnabledForEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns false when billing is disabled for the enterprise", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("falls back to the resolved global history.enabled flag when no per-enterprise override is set", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));

      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(true);

      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: false } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("a per-enterprise licensingHistoryEnabled override takes precedence over the global flag", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { licensingHistoryEnabled: false } } }],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(false);
    });

    it("an override of true re-enables licensing history for one enterprise when the global flag is off", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a", metrics: { billing: { licensingHistoryEnabled: true } } }],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: false } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(true);
    });

    it("fails closed when the global licensing config is invalid and no override is set", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [{ slug: "ent-a" }],
      }));
      mockGetLicensingConfig.mockImplementation(() => {
        throw new Error("invalid licensing config");
      });

      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Config] Invalid licensing history configuration; reporting it as disabled.",
      );
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("invalid licensing config");
      warnSpy.mockRestore();
    });

    it("existing enterprise configs without any licensing override keep resolving from the global flag unchanged", () => {
      // Backward compatibility: a pre-Task-12 enterprise entry has no
      // `licensingHistoryEnabled` field at all — this must never throw and
      // must never require a config migration.
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: true, premiumRequests: true },
        },
        enterprises: [{ slug: "ent-a" }, { slug: "ent-b" }],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(true);
      expect(isLicensingHistoryEnabledForEnterprise("ent-b")).toBe(true);
    });
  });

  describe("isLicensingHistoryEnabledForAnyEnterprise", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("returns true when at least one enterprise overrides licensing history on", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [
          { slug: "ent-a", metrics: { billing: { licensingHistoryEnabled: false } } },
          { slug: "ent-b", metrics: { billing: { licensingHistoryEnabled: true } } },
        ],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: false } }));
      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(true);
    });

    it("returns false when every enterprise has licensing history disabled", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [
          { slug: "ent-a", metrics: { billing: { licensingHistoryEnabled: false } } },
          { slug: "ent-b", metrics: { billing: { licensingHistoryEnabled: false } } },
        ],
      }));
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(false);
    });

    it("preserves an explicit true override when another enterprise falls back to invalid global config", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [
          { slug: "ent-a" },
          { slug: "ent-b", metrics: { billing: { licensingHistoryEnabled: true } } },
        ],
      }));
      mockGetLicensingConfig.mockImplementation(() => {
        throw new Error("invalid licensing config");
      });

      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(true);
    });

    it("legacy single-enterprise mode falls back to the global resolved flag", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(true);
    });

    it("legacy mode fails closed when the global licensing config is invalid", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true },
        },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      mockGetLicensingConfig.mockImplementation(() => {
        throw new Error("invalid licensing config");
      });

      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(false);
    });

    it("legacy mode returns false when billing is globally disabled, without invalidating the resolved licensing config", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: false },
        },
        enterprises: [],
      }));
      delete process.env.GITHUB_ENTERPRISE;
      mockGetLicensingConfig.mockReturnValue(makeResolvedLicensingConfig({ history: { enabled: true } }));
      expect(isLicensingHistoryEnabledForAnyEnterprise()).toBe(false);
      // The global licensing config itself must still resolve intact —
      // billing being force-disabled at the visibility layer never mutates
      // or invalidates the already-resolved config object.
      expect(getLicensingConfig()).toMatchObject({ history: { enabled: true } });
    });
  });

  describe("per-enterprise licensing config isolation (backward compatibility)", () => {
    afterEach(() => resetEnterpriseConfigCache());

    it("arbitrary per-enterprise metric overrides never affect the global resolved licensing config", () => {
      setMockConfig(makeConfig({
        globalMetrics: {
          copilot: { enabled: true, enterprise: true },
          billing: { enabled: true, meteredUsage: false },
        },
        enterprises: [
          { slug: "ent-a", metrics: { billing: { licensingHistoryEnabled: false, aiCredits: false }, codeScanning: { enabled: false } } },
          { slug: "ent-b", metrics: { billing: { licensingHistoryEnabled: true } } },
        ],
      }));
      const resolved = makeResolvedLicensingConfig({ history: { enabled: true, reportMonths: ["2026-01"] } });
      mockGetLicensingConfig.mockReturnValue(resolved);

      // Exercising every per-enterprise helper must not mutate or invalidate
      // the single global resolved config object — existing config remains
      // fully backward-compatible regardless of per-enterprise overrides.
      expect(isLicensingHistoryEnabledForEnterprise("ent-a")).toBe(false);
      expect(isLicensingHistoryEnabledForEnterprise("ent-b")).toBe(true);
      expect(isBillingSubEnabledForEnterprise("ent-a", "aiCredits")).toBe(false);

      expect(getLicensingConfig()).toBe(resolved);
      expect(resolved.history.enabled).toBe(true);
      expect(resolved.history.reportMonths).toEqual(["2026-01"]);
    });
  });

  describe("resolveDefaultScope", () => {
    it("returns first enterprise slug when enterprises are configured", () => {
      // Restore default mock in case legacy tests overrode it
      mockGetDashboardConfig.mockReturnValue({
        enterprises: [
          {
            slug: "acme-corp",
            displayName: "Acme Corp",
            tokenEnvVar: "ACME_TOKEN",
            organizations: { include: ["org-a", "org-b"], exclude: ["org-b"] },
          },
          {
            slug: "beta-inc",
            displayName: "Beta Inc",
            tokenEnvVar: "BETA_TOKEN",
            organizations: { include: ["org-x"] },
          },
        ],
      } as unknown as DashboardConfig);
      resetEnterpriseConfigCache();
      const result = resolveDefaultScope();
      expect(result).toEqual({ scope: "enterprise", scopeId: "acme-corp" });
    });

    it("returns org scope with empty scopeId when no enterprises configured", () => {
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as unknown as DashboardConfig);
      resetEnterpriseConfigCache();
      delete process.env.GITHUB_ENTERPRISE;
      const result = resolveDefaultScope();
      expect(result).toEqual({ scope: "org", scopeId: "" });
      resetEnterpriseConfigCache();
    });

    it("returns single enterprise slug for single-enterprise config", () => {
      mockGetDashboardConfig.mockReturnValue({
        enterprises: [
          { slug: "solo-ent", displayName: "Solo", tokenEnvVar: "SOLO_TOKEN" },
        ],
      } as unknown as DashboardConfig);
      resetEnterpriseConfigCache();
      const result = resolveDefaultScope();
      expect(result).toEqual({ scope: "enterprise", scopeId: "solo-ent" });
    });

    it("falls back to legacy env var when no config enterprises", () => {
      mockGetDashboardConfig.mockReturnValue({} as unknown as DashboardConfig);
      resetEnterpriseConfigCache();
      process.env.GITHUB_ENTERPRISE = "legacy-ent";
      process.env.GITHUB_TOKEN = "ghp_legacy";
      const result = resolveDefaultScope();
      expect(result).toEqual({ scope: "enterprise", scopeId: "legacy-ent" });
      delete process.env.GITHUB_ENTERPRISE;
      delete process.env.GITHUB_TOKEN;
      resetEnterpriseConfigCache();
    });

    it("returns org scope for org-only config entry", () => {
      setMockConfig(makeConfig({
        enterprises: [
          {
            slug: "_org_only",
            displayName: "Organizations",
            tokenEnvVar: "GITHUB_TOKEN",
            metrics: { copilot: { enterprise: false }, billing: { enabled: false } },
          },
        ],
      }));
      process.env.GITHUB_TOKEN = "ghp_test";
      const result = resolveDefaultScope();
      expect(result).toEqual({ scope: "org", scopeId: "mocked-_org_only" });
      delete process.env.GITHUB_TOKEN;
      resetEnterpriseConfigCache();
    });
  });

  // ── Org-Only Mode ──────────────────────────────────────────────────────

  describe("org-only mode", () => {
    afterEach(() => {
      delete process.env.GITHUB_ENTERPRISE;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GITHUB_ORGS;
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      delete process.env.GITHUB_APP_INSTALLATION_ID;
      resetEnterpriseConfigCache();
    });

    describe("getConfiguredEnterprises — legacy org-only fallback", () => {
      it("synthesizes org-only entry when GITHUB_ORGS is set without GITHUB_ENTERPRISE", () => {
        mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as ReturnType<typeof getDashboardConfig>);
        resetEnterpriseConfigCache();
        delete process.env.GITHUB_ENTERPRISE;
        process.env.GITHUB_ORGS = "org-a,org-b";
        process.env.GITHUB_TOKEN = "ghp_org";

        const enterprises = getConfiguredEnterprises();
        expect(enterprises).toHaveLength(1);
        expect(enterprises[0].slug).toBe("_org_only");
        expect(enterprises[0].displayName).toBe("Organizations");
        expect(enterprises[0].tokenEnvVar).toBe("GITHUB_TOKEN");
        expect(enterprises[0].organizations?.include).toEqual(["org-a", "org-b"]);
        expect(enterprises[0].metrics?.copilot?.enterprise).toBe(false);
        expect(enterprises[0].metrics?.billing?.enabled).toBe(false);
      });

      it("returns empty when neither GITHUB_ENTERPRISE nor GITHUB_ORGS is set", () => {
        mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as ReturnType<typeof getDashboardConfig>);
        resetEnterpriseConfigCache();
        delete process.env.GITHUB_ENTERPRISE;
        delete process.env.GITHUB_ORGS;

        const enterprises = getConfiguredEnterprises();
        expect(enterprises).toHaveLength(0);
      });

      it("prefers GITHUB_ENTERPRISE over org-only mode", () => {
        mockGetDashboardConfig.mockReturnValue({} as ReturnType<typeof getDashboardConfig>);
        resetEnterpriseConfigCache();
        process.env.GITHUB_ENTERPRISE = "my-ent";
        process.env.GITHUB_ORGS = "org-a";
        process.env.GITHUB_TOKEN = "ghp_test";

        const enterprises = getConfiguredEnterprises();
        expect(enterprises).toHaveLength(1);
        expect(enterprises[0].slug).toBe("my-ent");
        expect(enterprises[0].metrics).toBeUndefined();
      });

      it("includes App auth config in org-only entry when env vars are set", () => {
        mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as ReturnType<typeof getDashboardConfig>);
        resetEnterpriseConfigCache();
        delete process.env.GITHUB_ENTERPRISE;
        process.env.GITHUB_ORGS = "org-a";
        process.env.GITHUB_APP_ID = "123";
        process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----";
        process.env.GITHUB_APP_INSTALLATION_ID = "456";

        const enterprises = getConfiguredEnterprises();
        expect(enterprises[0].appIdEnvVar).toBe("GITHUB_APP_ID");
        expect(enterprises[0].appPrivateKeyEnvVar).toBe("GITHUB_APP_PRIVATE_KEY");
        expect(enterprises[0].appInstallationIdEnvVar).toBe("GITHUB_APP_INSTALLATION_ID");
      });
    });

    describe("isOrgOnlyEnterprise", () => {
      it("returns true for org-only entries with copilot.enterprise: false", () => {
        setMockConfig(makeConfig({
          enterprises: [
            {
              slug: "org-group",
              displayName: "Orgs",
              tokenEnvVar: "GITHUB_TOKEN",
              metrics: { copilot: { enterprise: false } },
            },
          ],
        }));
        process.env.GITHUB_TOKEN = "ghp_test";

        expect(isOrgOnlyEnterprise("org-group")).toBe(true);
      });

      it("returns false for standard enterprise entries", () => {
        setMockConfig(makeConfig({
          enterprises: [
            {
              slug: "acme-corp",
              displayName: "Acme Corp",
              tokenEnvVar: "ACME_TOKEN",
            },
          ],
        }));
        expect(isOrgOnlyEnterprise("acme-corp")).toBe(false);
      });
    });

    describe("getEnterpriseAuth — org-only + app auth", () => {
      it("allows missing PAT when org-only and app auth is configured", () => {
        // Use direct mock since makeConfig doesn't support appIdEnvVar etc.
        mockGetDashboardConfig.mockReturnValue({
          metrics: {
            copilot: { enabled: true, enterprise: true },
            codeScanning: { enabled: true, autofix: false },
            dependabot: { enabled: true },
            secretScanning: { enabled: true },
            billing: { enabled: true, meteredUsage: true, premiumRequests: true },
          },
          enterprises: [
            {
              slug: "org-group",
              displayName: "Orgs",
              tokenEnvVar: "ORG_TOKEN",
              appIdEnvVar: "ORG_APP_ID",
              appPrivateKeyEnvVar: "ORG_APP_KEY",
              appInstallationIdEnvVar: "ORG_APP_INST",
              metrics: { copilot: { enterprise: false } },
            },
          ],
        } as ReturnType<typeof getDashboardConfig>);
        resetEnterpriseConfigCache();
        // No ORG_TOKEN set, but app auth env vars are present
        process.env.ORG_APP_ID = "100";
        process.env.ORG_APP_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nfake\\n-----END RSA PRIVATE KEY-----";
        process.env.ORG_APP_INST = "200";

        const auth = getEnterpriseAuth("org-group");
        expect(auth.token).toBe("");
        expect(auth.appConfig).toBeDefined();
        expect(auth.appConfig?.appId).toBe("100");

        delete process.env.ORG_APP_ID;
        delete process.env.ORG_APP_KEY;
        delete process.env.ORG_APP_INST;
      });

      it("still throws when org-only without app auth and no PAT", () => {
        setMockConfig(makeConfig({
          enterprises: [
            {
              slug: "org-group",
              displayName: "Orgs",
              tokenEnvVar: "ORG_TOKEN",
              metrics: { copilot: { enterprise: false } },
            },
          ],
        }));

        expect(() => getEnterpriseAuth("org-group")).toThrow("PAT not found");
      });

      it("works normally with PAT in org-only mode", () => {
        setMockConfig(makeConfig({
          enterprises: [
            {
              slug: "org-group",
              displayName: "Orgs",
              tokenEnvVar: "ORG_TOKEN",
              metrics: { copilot: { enterprise: false } },
            },
          ],
        }));
        process.env.ORG_TOKEN = "ghp_org123";

        const auth = getEnterpriseAuth("org-group");
        expect(auth.token).toBe("ghp_org123");

        delete process.env.ORG_TOKEN;
      });
    });

    describe("resolveDefaultScope — org-only", () => {
      it("returns org scope for org-only legacy config", () => {
        mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as ReturnType<typeof getDashboardConfig>);
        vi.mocked(getResolvedOrgs).mockReturnValueOnce(["my-org-1", "my-org-2"]);
        resetEnterpriseConfigCache();
        delete process.env.GITHUB_ENTERPRISE;
        process.env.GITHUB_ORGS = "my-org-1,my-org-2";
        process.env.GITHUB_TOKEN = "ghp_test";

        const result = resolveDefaultScope();
        expect(result.scope).toBe("org");
        expect(result.scopeId).toBe("my-org-1");
      });
    });
  });
});
