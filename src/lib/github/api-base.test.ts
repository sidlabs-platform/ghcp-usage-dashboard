import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./app-auth", () => ({
  isAppAuthConfigured: vi.fn(() => false),
  getInstallationToken: vi.fn(),
  validateAppAuth: vi.fn(),
  logAuthMode: vi.fn(),
  isAppAuthConfiguredForEnterprise: vi.fn(() => false),
  getInstallationTokenForEnterprise: vi.fn(),
}));

import { resolveAuthMode } from "./api-base";
import { isAppAuthConfigured, isAppAuthConfiguredForEnterprise } from "./app-auth";

const mockIsApp = isAppAuthConfigured as ReturnType<typeof vi.fn>;
const mockIsAppEnt = isAppAuthConfiguredForEnterprise as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockIsApp.mockReset().mockReturnValue(false);
  mockIsAppEnt.mockReset().mockReturnValue(false);
});

describe("resolveAuthMode", () => {
  it("returns 'none' for non-GitHub absolute URLs", () => {
    expect(resolveAuthMode("https://storage.azure.com/some-presigned-url")).toBe("none");
    expect(resolveAuthMode("https://s3.amazonaws.com/bucket/key")).toBe("none");
  });

  it("returns 'pat' for enterprise endpoints", () => {
    expect(resolveAuthMode("/enterprises/my-ent/copilot/usage")).toBe("pat");
    expect(resolveAuthMode("/enterprises/acme/copilot/metrics")).toBe("pat");
  });

  it("returns 'pat' for org endpoints when no App auth is configured", () => {
    expect(resolveAuthMode("/orgs/my-org/copilot/usage")).toBe("pat");
  });

  it("returns 'app' for org endpoints when App auth is configured", () => {
    mockIsApp.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/copilot/usage")).toBe("app");
  });

  it("returns 'app' when enterprise slug has app configured", () => {
    mockIsAppEnt.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/metrics", "ent1")).toBe("app");
  });

  it("returns 'pat' when enterprise slug has no app configured", () => {
    mockIsAppEnt.mockReturnValue(false);
    expect(resolveAuthMode("/orgs/my-org/metrics", "ent1")).toBe("pat");
  });

  it("returns 'pat' for absolute GitHub API enterprise URLs", () => {
    expect(resolveAuthMode("https://api.github.com/enterprises/my-ent/copilot/usage")).toBe("pat");
  });

  it("returns 'none' for non-GitHub absolute URLs regardless of path content", () => {
    expect(resolveAuthMode("https://example.com/enterprises/foo")).toBe("none");
  });
});
