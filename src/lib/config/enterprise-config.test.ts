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
} from "./enterprise-config";
import { getDashboardConfig } from "./dashboard-config";

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

    it("returns empty array when organizations config is undefined", () => {
      (getDashboardConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        enterprises: [{ slug: "no-orgs", displayName: "No Orgs", tokenEnvVar: "T" }],
      });
      resetEnterpriseConfigCache();
      const orgs = getResolvedOrgsForEnterprise("no-orgs");
      expect(orgs).toEqual([]);
      resetEnterpriseConfigCache();
    });
  });

  describe("legacy env var synthesis", () => {
    it("synthesizes config from env vars when no enterprises in config", () => {
      resetEnterpriseConfigCache();
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as any);
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
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as any);
      delete process.env.GITHUB_ENTERPRISE;
      const enterprises = getConfiguredEnterprises();
      expect(enterprises).toEqual([]);
    });

    it("includes app env vars in synthesis when all are set", () => {
      resetEnterpriseConfigCache();
      mockGetDashboardConfig.mockReturnValue({ enterprises: [] } as any);
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
});
