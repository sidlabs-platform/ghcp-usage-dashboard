import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

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

type AppAuthModule = typeof import("./app-auth");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app-auth (no env)", () => {
  let appAuth: AppAuthModule;

  beforeAll(async () => {
    vi.resetModules();
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    appAuth = await import("./app-auth");
  });

  it("isAppAuthConfigured returns false without env vars", async () => {
    expect(appAuth.isAppAuthConfigured()).toBe(false);
  });

  it("logAuthMode logs PAT mode when no app auth configured", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    appAuth.logAuthMode();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PAT auth for all endpoints")
    );
  });

  it("getInstallationToken throws when no config", async () => {
    await expect(appAuth.getInstallationToken()).rejects.toThrow("not configured");
  });
});

describe("app-auth (with env + mocked jose)", () => {
  let appAuth: AppAuthModule;

  beforeEach(async () => {
    vi.resetModules();
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----";
    process.env.GITHUB_APP_INSTALLATION_ID = "456";
    appAuth = await import("./app-auth");
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
  });

  it("isAppAuthConfigured returns true when env vars set", async () => {
    expect(appAuth.isAppAuthConfigured()).toBe(true);
  });

  it("logAuthMode logs app mode when configured", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    appAuth.logAuthMode();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("App auth active"));
  });

  it("getInstallationToken mints and returns token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_minted123", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }));
    const token = await appAuth.getInstallationToken();
    expect(token).toBe("ghs_minted123");
  });

  it("getInstallationToken returns cached token on second call", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_cached", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    await appAuth.getInstallationToken();
    const token2 = await appAuth.getInstallationToken();
    expect(token2).toBe("ghs_cached");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getInstallationToken throws when mint fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => "Unauthorized",
    }));
    await expect(appAuth.getInstallationToken()).rejects.toThrow("Failed to create installation token");
  });

  it("getInstallationToken throws on missing token in response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ expires_at: new Date().toISOString() }),
    }));
    await expect(appAuth.getInstallationToken()).rejects.toThrow("missing token or expires_at");
  });

  it("getInstallationToken throws on unparseable expires_at", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_test", expires_at: "not-a-date" }),
    }));
    await expect(appAuth.getInstallationToken()).rejects.toThrow("unparseable expires_at");
  });

  it("validateAppAuth succeeds after successful mint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_valid", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(appAuth.validateAppAuth()).resolves.toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("validated"));
  });

  it("validateAppAuth throws with wrapped error when mint fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, text: async () => "Server Error",
    }));
    await expect(appAuth.validateAppAuth()).rejects.toThrow("validation failed");
  });

  it("validateAppAuth wraps non-Error throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("string-error"));
    await expect(appAuth.validateAppAuth()).rejects.toThrow("string-error");
  });

  it("getInstallationToken deduplicates concurrent mints via refreshPromise", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_dedup", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const [t1, t2] = await Promise.all([
      appAuth.getInstallationToken(),
      appAuth.getInstallationToken(),
    ]);
    expect(t1).toBe("ghs_dedup");
    expect(t2).toBe("ghs_dedup");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("app-auth enterprise functions", () => {
  let appAuth: AppAuthModule;

  beforeEach(async () => {
    vi.resetModules();
    appAuth = await import("./app-auth");
  });

  afterEach(() => {
    appAuth._setEnterpriseAuthFn(undefined);
  });

  it("loadAppConfigForEnterprise returns config when enterprise has app auth", async () => {
    appAuth._setEnterpriseAuthFn(() => ({
      appConfig: { appId: "app-1", privateKey: "pk-1", installationId: "inst-1" },
    }));
    const cfg = appAuth.loadAppConfigForEnterprise("ent-a");
    expect(cfg).toEqual({ appId: "app-1", privateKey: "pk-1", installationId: "inst-1" });
  });

  it("loadAppConfigForEnterprise returns null when no appConfig", async () => {
    appAuth._setEnterpriseAuthFn(() => ({}));
    expect(appAuth.loadAppConfigForEnterprise("ent-b")).toBeNull();
  });

  it("loadAppConfigForEnterprise returns null when auth fn throws", async () => {
    appAuth._setEnterpriseAuthFn(() => { throw new Error("no config"); });
    expect(appAuth.loadAppConfigForEnterprise("ent-c")).toBeNull();
  });

  it("isAppAuthConfiguredForEnterprise returns true/false based on enterprise config", async () => {
    appAuth._setEnterpriseAuthFn((slug: string) =>
      slug === "has-app" ? { appConfig: { appId: "1", privateKey: "k", installationId: "2" } } : {},
    );
    expect(appAuth.isAppAuthConfiguredForEnterprise("has-app")).toBe(true);
    expect(appAuth.isAppAuthConfiguredForEnterprise("no-app")).toBe(false);
  });

  it("getInstallationTokenForEnterprise throws when no config for enterprise", async () => {
    appAuth._setEnterpriseAuthFn(() => ({})); // no appConfig
    await expect(appAuth.getInstallationTokenForEnterprise("missing-ent")).rejects.toThrow(
      'not configured for enterprise "missing-ent"',
    );
  });

  it("getInstallationTokenForEnterprise mints and caches token per enterprise", async () => {
    appAuth._setEnterpriseAuthFn(() => ({
      appConfig: { appId: "ea", privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----", installationId: "ei" },
    }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_ent_tok", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const t1 = await appAuth.getInstallationTokenForEnterprise("ent-x");
    expect(t1).toBe("ghs_ent_tok");
    // Second call should use cache, not mint again
    const t2 = await appAuth.getInstallationTokenForEnterprise("ent-x");
    expect(t2).toBe("ghs_ent_tok");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getInstallationTokenForEnterprise deduplicates concurrent mints", async () => {
    appAuth._setEnterpriseAuthFn(() => ({
      appConfig: { appId: "ea", privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----", installationId: "ei" },
    }));
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token: "ghs_dedup", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    vi.stubGlobal("fetch", mockFetch);
    const [r1, r2] = await Promise.all([
      appAuth.getInstallationTokenForEnterprise("ent-y"),
      appAuth.getInstallationTokenForEnterprise("ent-y"),
    ]);
    expect(r1).toBe("ghs_dedup");
    expect(r2).toBe("ghs_dedup");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
