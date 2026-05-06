import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
});

describe("app-auth (with env)", () => {
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

  it("getInstallationToken throws when token mint fails (no jose key)", async () => {
    const { getInstallationToken } = await import("./app-auth");
    // Will fail because the PEM key is invalid
    await expect(getInstallationToken()).rejects.toThrow();
  });

  it("validateAppAuth throws on mint failure", async () => {
    const { validateAppAuth } = await import("./app-auth");
    await expect(validateAppAuth()).rejects.toThrow();
  });
});
