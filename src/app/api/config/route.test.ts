import { afterEach, describe, expect, it, vi } from "vitest";

const loadRoute = () => import("./route");

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("config route", { timeout: 15000 }, () => {
  it("uses dashboard-config gating in single-enterprise mode", async () => {
    const isCopilotSubEnabled = vi.fn((key: string) =>
      ({
        userMetrics: true,
        pullRequests: false,
        teams: true,
        seats: true,
      })[key] ?? true,
    );
    const isBillingSubEnabled = vi.fn(() => false);

    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        metrics: {
          copilot: { enabled: true },
          billing: { enabled: false },
          codeScanning: { enabled: true },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      isEnterpriseEnabled: () => false,
      getEffectiveBillingEnabled: () => false,
      isBillingSubEnabled,
      isCopilotSubEnabled,
      getResolvedOrgs: () => [{ slug: "platform", name: "Platform" }],
    }));

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [],
      getClientEnterpriseMetrics: () => ({}),
      isMultiEnterprise: () => false,
      isMetricEnabledForAnyEnterprise: vi.fn(),
      isCopilotSubEnabledForAnyEnterprise: vi.fn(),
      isBillingSubEnabledForAnyEnterprise: vi.fn(),
      isLicensingHistoryEnabledForAnyEnterprise: () => false,
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.enterpriseMode).toBe(false);
    expect(payload.multiEnterprise).toBe(false);
    expect(payload.resolvedOrgs).toEqual([{ slug: "platform", name: "Platform" }]);
    expect(payload.licensingHistoryEnabled).toBe(false);
    expect(payload.pageVisibility).toMatchObject({
      overview: true,
      codeGeneration: true,
      chatModes: true,
      teams: true,
      pullRequests: false,
      seats: true,
      security: true,
      billing: false,
      billingUsage: false,
      billingPremium: false,
      // Neither aiCredits nor premiumRequests is enabled (isBillingSubEnabled
      // always returns false in this test), so the License & Credits page
      // must stay hidden — same OR-of-both-sources rule as billingPremium.
      licenseReconciliation: false,
      aiCreditsUsers: true,
    });
    expect(isCopilotSubEnabled).toHaveBeenCalledWith("userMetrics");
    expect(isCopilotSubEnabled).toHaveBeenCalledWith("pullRequests");
    expect(isBillingSubEnabled).not.toHaveBeenCalled();
  });

  it("shows License & Credits when only aiCredits (not premiumRequests) is enabled in single-enterprise mode", async () => {
    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        metrics: {
          copilot: { enabled: true },
          billing: { enabled: true },
          codeScanning: { enabled: false },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      isEnterpriseEnabled: () => true,
      getEffectiveBillingEnabled: () => true,
      isBillingSubEnabled: (key: string) => key === "aiCredits",
      isCopilotSubEnabled: () => true,
      getResolvedOrgs: () => [],
    }));

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [],
      getClientEnterpriseMetrics: () => ({}),
      isMultiEnterprise: () => false,
      isMetricEnabledForAnyEnterprise: vi.fn(),
      isCopilotSubEnabledForAnyEnterprise: vi.fn(),
      isBillingSubEnabledForAnyEnterprise: vi.fn(),
      isLicensingHistoryEnabledForAnyEnterprise: () => true,
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.licensingHistoryEnabled).toBe(true);
    expect(payload.pageVisibility.licenseReconciliation).toBe(true);
    expect(payload.pageVisibility.billingPremium).toBe(true);
  });

  it("never exposes server-side licensing paths, CSV paths, or log output paths even when configured", async () => {
    const SENSITIVE_AUDIT_ARCHIVE_PATH = "/var/secrets/licensing-audit-archive";
    const SENSITIVE_IDENTITY_MAP_PATH = "/var/secrets/identity-map.json";
    const SENSITIVE_SNAPSHOT_DIRECTORY = "/var/secrets/licensing-snapshots";
    const SENSITIVE_CSV_PATH = "/var/secrets/aic-consumption-export.csv";

    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        metrics: {
          copilot: { enabled: true },
          billing: {
            enabled: true,
            meteredUsage: true,
            premiumRequests: true,
            aiCredits: true,
            // A fully-configured licensing block, exactly as an operator
            // would set it in dashboard-config.json — every field here is
            // server-filesystem-only and must never reach the browser.
            licensing: {
              history: {
                enabled: true,
                reportMonths: ["2026-01", "2026-02"],
                auditArchivePath: SENSITIVE_AUDIT_ARCHIVE_PATH,
                identityMapPath: SENSITIVE_IDENTITY_MAP_PATH,
                snapshotDirectory: SENSITIVE_SNAPSHOT_DIRECTORY,
                emitSnapshots: true,
              },
              aicConsumption: { mode: "auto", csvPath: SENSITIVE_CSV_PATH },
            },
          },
          codeScanning: { enabled: false },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      isEnterpriseEnabled: () => true,
      getEffectiveBillingEnabled: () => true,
      isBillingSubEnabled: () => true,
      isCopilotSubEnabled: () => true,
      getResolvedOrgs: () => [],
    }));

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [],
      getClientEnterpriseMetrics: () => ({}),
      isMultiEnterprise: () => false,
      isMetricEnabledForAnyEnterprise: vi.fn(),
      isCopilotSubEnabledForAnyEnterprise: vi.fn(),
      isBillingSubEnabledForAnyEnterprise: vi.fn(),
      isLicensingHistoryEnabledForAnyEnterprise: () => true,
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(SENSITIVE_AUDIT_ARCHIVE_PATH);
    expect(serialized).not.toContain(SENSITIVE_IDENTITY_MAP_PATH);
    expect(serialized).not.toContain(SENSITIVE_SNAPSHOT_DIRECTORY);
    expect(serialized).not.toContain(SENSITIVE_CSV_PATH);
    // The whole raw licensing config block must be stripped, not just the
    // path fields individually — this proves the route never forwards it
    // as-is instead of relying on an incomplete per-field denylist.
    expect(payload.metrics?.billing?.licensing).toBeUndefined();
    // Non-sensitive billing sub-toggles must remain intact (backward compat).
    expect(payload.metrics?.billing?.enabled).toBe(true);
    expect(payload.metrics?.billing?.meteredUsage).toBe(true);
    expect(payload.metrics?.billing?.premiumRequests).toBe(true);
    expect(payload.metrics?.billing?.aiCredits).toBe(true);
    // The safe, computed summary boolean is still surfaced for navigation/UI.
    expect(payload.licensingHistoryEnabled).toBe(true);
  });

  it("fails licensing history visibility closed when licensing config is invalid", async () => {
    delete process.env.GITHUB_ENTERPRISE;
    delete process.env.GITHUB_ORGS;

    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        enterprises: [],
        metrics: {
          copilot: { enabled: true },
          billing: { enabled: true, aiCredits: true },
          codeScanning: { enabled: false },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      getLicensingConfig: () => {
        throw new Error("invalid licensing config");
      },
      isEnterpriseEnabled: () => false,
      getEffectiveBillingEnabled: () => true,
      isBillingSubEnabled: (key: string) => key === "aiCredits",
      isCopilotSubEnabled: () => true,
      getResolvedOrgs: () => [],
    }));
    vi.doUnmock("@/lib/config/enterprise-config");

    const { GET } = await loadRoute();
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      licensingHistoryEnabled: false,
      pageVisibility: { licenseReconciliation: true },
    });
  });

  it("uses enterprise-aware visibility checks in multi-enterprise mode", async () => {
    const isMetricEnabled = vi.fn(() => {
      throw new Error("single-enterprise metric gating should not be used");
    });
    const isCopilotSubEnabled = vi.fn(() => {
      throw new Error("single-enterprise copilot gating should not be used");
    });
    const isBillingSubEnabled = vi.fn(() => {
      throw new Error("single-enterprise billing gating should not be used");
    });

    const isMetricEnabledForAnyEnterprise = vi.fn((key: string) =>
      ["copilot", "billing", "secretScanning"].includes(key),
    );
    const isCopilotSubEnabledForAnyEnterprise = vi.fn((key: string) =>
      ["userMetrics", "teams", "seats"].includes(key),
    );
    const isBillingSubEnabledForAnyEnterprise = vi.fn((key: string) =>
      key === "aiCredits",
    );

    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        metrics: {
          copilot: { enabled: false },
          billing: { enabled: false },
          codeScanning: { enabled: false },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      isEnterpriseEnabled: () => true,
      getEffectiveBillingEnabled: () => false,
      isBillingSubEnabled,
      isCopilotSubEnabled,
      getResolvedOrgs: () => [],
      isMetricEnabled,
    }));

    const isLicensingHistoryEnabledForAnyEnterprise = vi.fn(() => true);

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [{ slug: "ent-a", displayName: "Enterprise A" }],
      getClientEnterpriseMetrics: () => ({ "ent-a": { billing: true } }),
      isMultiEnterprise: () => true,
      isMetricEnabledForAnyEnterprise,
      isCopilotSubEnabledForAnyEnterprise,
      isBillingSubEnabledForAnyEnterprise,
      isLicensingHistoryEnabledForAnyEnterprise,
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.enterpriseMode).toBe(true);
    expect(payload.multiEnterprise).toBe(true);
    expect(payload.enterprises).toEqual([{ slug: "ent-a", displayName: "Enterprise A" }]);
    expect(payload.enterpriseMetrics).toEqual({ "ent-a": { billing: true } });
    expect(payload.effectiveBilling).toBe(true);
    expect(payload.licensingHistoryEnabled).toBe(true);
    expect(payload.pageVisibility).toMatchObject({
      overview: true,
      codeGeneration: true,
      teams: true,
      pullRequests: false,
      seats: true,
      security: true,
      billing: true,
      billingUsage: false,
      billingPremium: true,
      // aiCredits is enabled for "ent-a" (the mocked "any enterprise" check
      // only returns true for "aiCredits"), so the License & Credits page
      // must be visible even though premiumRequests is not — same OR rule
      // as billingPremium, applied "for any enterprise" in multi-enterprise mode.
      licenseReconciliation: true,
      aiCreditsUsers: true,
    });
    expect(isMetricEnabledForAnyEnterprise).toHaveBeenCalledWith("copilot");
    expect(isMetricEnabledForAnyEnterprise).toHaveBeenCalledWith("billing");
    expect(isMetricEnabledForAnyEnterprise).toHaveBeenCalledWith("secretScanning");
    expect(isCopilotSubEnabledForAnyEnterprise).toHaveBeenCalledWith("userMetrics");
    expect(isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("premiumRequests");
    expect(isBillingSubEnabledForAnyEnterprise).toHaveBeenCalledWith("aiCredits");
    expect(isMetricEnabled).not.toHaveBeenCalled();
    expect(isCopilotSubEnabled).not.toHaveBeenCalled();
    expect(isBillingSubEnabled).not.toHaveBeenCalled();
  });
});
