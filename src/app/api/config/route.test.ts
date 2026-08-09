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
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.enterpriseMode).toBe(false);
    expect(payload.multiEnterprise).toBe(false);
    expect(payload.resolvedOrgs).toEqual([{ slug: "platform", name: "Platform" }]);
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
      aiCreditsUsers: true,
      copilotApp: true,
    });
    expect(isCopilotSubEnabled).toHaveBeenCalledWith("userMetrics");
    expect(isCopilotSubEnabled).toHaveBeenCalledWith("pullRequests");
    expect(isBillingSubEnabled).not.toHaveBeenCalled();
  });

  it("keeps Copilot App visible when base copilot metric is enabled but user metrics are disabled", async () => {
    // The Copilot App page falls back to an enterprise/org aggregate (KPIs and
    // trends only, no adopters) when per-user metrics are unavailable, so its
    // visibility must track the base copilot metric rather than `userMetrics`.
    const isCopilotSubEnabled = vi.fn((key: string) =>
      ({
        userMetrics: false,
        pullRequests: false,
        teams: false,
        seats: false,
      })[key] ?? false,
    );
    const isBillingSubEnabled = vi.fn(() => false);

    vi.doMock("@/lib/config/dashboard-config", () => ({
      getDashboardConfig: () => ({
        metrics: {
          copilot: { enabled: true },
          billing: { enabled: false },
          codeScanning: { enabled: false },
          dependabot: { enabled: false },
          secretScanning: { enabled: false },
        },
      }),
      isEnterpriseEnabled: () => false,
      getEffectiveBillingEnabled: () => false,
      isBillingSubEnabled,
      isCopilotSubEnabled,
      getResolvedOrgs: () => [],
    }));

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [],
      getClientEnterpriseMetrics: () => ({}),
      isMultiEnterprise: () => false,
      isMetricEnabledForAnyEnterprise: vi.fn(),
      isCopilotSubEnabledForAnyEnterprise: vi.fn(),
      isBillingSubEnabledForAnyEnterprise: vi.fn(),
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.pageVisibility).toMatchObject({
      overview: true,
      codeGeneration: false,
      models: false,
      copilotApp: true,
    });
  });

  it("hides Copilot App when the base copilot metric is disabled", async () => {
    const isCopilotSubEnabled = vi.fn(() => false);
    const isBillingSubEnabled = vi.fn(() => false);

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
      isEnterpriseEnabled: () => false,
      getEffectiveBillingEnabled: () => false,
      isBillingSubEnabled,
      isCopilotSubEnabled,
      getResolvedOrgs: () => [],
    }));

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [],
      getClientEnterpriseMetrics: () => ({}),
      isMultiEnterprise: () => false,
      isMetricEnabledForAnyEnterprise: vi.fn(),
      isCopilotSubEnabledForAnyEnterprise: vi.fn(),
      isBillingSubEnabledForAnyEnterprise: vi.fn(),
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.pageVisibility).toMatchObject({
      overview: false,
      copilotApp: false,
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

    vi.doMock("@/lib/config/enterprise-config", () => ({
      getClientEnterpriseList: () => [{ slug: "ent-a", displayName: "Enterprise A" }],
      getClientEnterpriseMetrics: () => ({ "ent-a": { billing: true } }),
      isMultiEnterprise: () => true,
      isMetricEnabledForAnyEnterprise,
      isCopilotSubEnabledForAnyEnterprise,
      isBillingSubEnabledForAnyEnterprise,
    }));

    const { GET } = await loadRoute();
    const response = await GET();
    const payload = await response.json();

    expect(payload.enterpriseMode).toBe(true);
    expect(payload.multiEnterprise).toBe(true);
    expect(payload.enterprises).toEqual([{ slug: "ent-a", displayName: "Enterprise A" }]);
    expect(payload.enterpriseMetrics).toEqual({ "ent-a": { billing: true } });
    expect(payload.effectiveBilling).toBe(true);
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
      aiCreditsUsers: true,
      copilotApp: true,
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
