import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("jose", () => ({
  importPKCS8: vi.fn(async () => "mock-key"),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setIssuer() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return "mock-jwt-token"; }
  },
}));

describe("app-auth (no env)", () => {
  it("isAppAuthConfigured returns false without env vars", async () => {
    const { isAppAuthConfigured } = await import("./app-auth");
    expect(isAppAuthConfigured()).toBe(false);
  });

  it("logAuthMode logs PAT mode when no app auth configured", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logAuthMode } = await import("./app-auth");
    logAuthMode();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PAT auth for all endpoints")
    );
    spy.mockRestore();
  });

  it("getInstallationToken throws when no config", async () => {
    const { getInstallationToken } = await import("./app-auth");
    await expect(getInstallationToken()).rejects.toThrow("not configured");
  });
});

describe("app-auth (with env + mocked jose)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----";
    process.env.GITHUB_APP_INSTALLATION_ID = "456";
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
  });

  it("isAppAuthConfigured returns true when env vars set", async () => {
    const { isAppAuthConfigured } = await import("./app-auth");
    expect(isAppAuthConfigured()).toBe(true);
  });

  it("logAuthMode logs app mode when configured", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { logAuthMode } = await import("./app-auth");
    logAuthMode();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("App auth active"));
    spy.mockRestore();
  });

  it("getInstallationToken mints and returns token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_minted123", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }));
    const { getInstallationToken } = await import("./app-auth");
    const token = await getInstallationToken();
    expect(token).toBe("ghs_minted123");
  });

  it("getInstallationToken returns cached token on second call", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_cached", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const { getInstallationToken } = await import("./app-auth");
    await getInstallationToken();
    const token2 = await getInstallationToken();
    expect(token2).toBe("ghs_cached");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getInstallationToken throws when mint fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "Unauthorized",
    }));
    const { getInstallationToken } = await import("./app-auth");
    await expect(getInstallationToken()).rejects.toThrow("Failed to create installation token");
  });

  it("getInstallationToken throws on missing token in response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_at: new Date().toISOString() }),
    }));
    const { getInstallationToken } = await import("./app-auth");
    await expect(getInstallationToken()).rejects.toThrow("missing token or expires_at");
  });

  it("getInstallationToken throws on unparseable expires_at", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_test", expires_at: "not-a-date" }),
    }));
    const { getInstallationToken } = await import("./app-auth");
    await expect(getInstallationToken()).rejects.toThrow("unparseable expires_at");
  });

  it("validateAppAuth succeeds after successful mint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_valid", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { validateAppAuth } = await import("./app-auth");
    await expect(validateAppAuth()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("validated"));
    logSpy.mockRestore();
  });
});

describe("app-auth enterprise functions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(undefined);
  });

  it("loadAppConfigForEnterprise returns config when enterprise has app auth", async () => {
    const { loadAppConfigForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => ({
      appConfig: { appId: "app-1", privateKey: "pk-1", installationId: "inst-1" },
    }));
    const cfg = loadAppConfigForEnterprise("ent-a");
    expect(cfg).toEqual({ appId: "app-1", privateKey: "pk-1", installationId: "inst-1" });
  });

  it("loadAppConfigForEnterprise returns null when no appConfig", async () => {
    const { loadAppConfigForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => ({}));
    expect(loadAppConfigForEnterprise("ent-b")).toBeNull();
  });

  it("loadAppConfigForEnterprise returns null when auth fn throws", async () => {
    const { loadAppConfigForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => { throw new Error("no config"); });
    expect(loadAppConfigForEnterprise("ent-c")).toBeNull();
  });

  it("isAppAuthConfiguredForEnterprise returns true/false based on enterprise config", async () => {
    const { isAppAuthConfiguredForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn((slug: string) =>
      slug === "has-app" ? { appConfig: { appId: "1", privateKey: "k", installationId: "2" } } : {},
    );
    expect(isAppAuthConfiguredForEnterprise("has-app")).toBe(true);
    expect(isAppAuthConfiguredForEnterprise("no-app")).toBe(false);
  });

  it("getInstallationTokenForEnterprise throws when no config for enterprise", async () => {
    const { getInstallationTokenForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => ({})); // no appConfig
    await expect(getInstallationTokenForEnterprise("missing-ent")).rejects.toThrow(
      'not configured for enterprise "missing-ent"',
    );
  });

  it("getInstallationTokenForEnterprise mints and caches token per enterprise", async () => {
    const { getInstallationTokenForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => ({
      appConfig: { appId: "ea", privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----", installationId: "ei" },
    }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_ent_tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const t1 = await getInstallationTokenForEnterprise("ent-x");
    expect(t1).toBe("ghs_ent_tok");
    // Second call should use cache, not mint again
    const t2 = await getInstallationTokenForEnterprise("ent-x");
    expect(t2).toBe("ghs_ent_tok");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getInstallationTokenForEnterprise deduplicates concurrent mints", async () => {
    const { getInstallationTokenForEnterprise, _setEnterpriseAuthFn } = await import("./app-auth");
    _setEnterpriseAuthFn(() => ({
      appConfig: { appId: "ea", privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----", installationId: "ei" },
    }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_dedup", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const [r1, r2] = await Promise.all([
      getInstallationTokenForEnterprise("ent-y"),
      getInstallationTokenForEnterprise("ent-y"),
    ]);
    expect(r1).toBe("ghs_dedup");
    expect(r2).toBe("ghs_dedup");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
