import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isAppAuthConfigured, logAuthMode } from "./app-auth";

describe("isAppAuthConfigured", () => {
  it("returns a boolean indicating app auth state", () => {
    // In test env, GITHUB_APP_ID etc. are not set → returns false
    expect(isAppAuthConfigured()).toBe(false);
  });
});

describe("logAuthMode", () => {
  it("logs PAT mode when no app auth configured", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAuthMode();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("PAT auth for all endpoints")
    );
    spy.mockRestore();
  });
});
