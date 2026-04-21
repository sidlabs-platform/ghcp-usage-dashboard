import { describe, it, expect } from "vitest";
import { resolveAuthMode } from "./api-base";

// resolveAuthMode is testable without mocking because its default path
// checks isAppAuthConfigured() which reads env vars (not set in test → false)

describe("resolveAuthMode", () => {
  it("returns 'none' for non-GitHub absolute URLs", () => {
    expect(resolveAuthMode("https://storage.azure.com/some-presigned-url")).toBe("none");
    expect(resolveAuthMode("https://s3.amazonaws.com/bucket/key")).toBe("none");
  });

  it("returns 'pat' for enterprise endpoints", () => {
    expect(resolveAuthMode("/enterprises/my-ent/copilot/usage")).toBe("pat");
    expect(resolveAuthMode("/enterprises/acme/copilot/metrics")).toBe("pat");
  });

  it("returns 'pat' for org endpoints when no App auth env vars are set", () => {
    // In test env, GITHUB_APP_ID etc. are not set → isAppAuthConfigured() returns false
    expect(resolveAuthMode("/orgs/my-org/copilot/usage")).toBe("pat");
  });

  it("returns 'pat' for absolute GitHub API enterprise URLs", () => {
    expect(resolveAuthMode("https://api.github.com/enterprises/my-ent/copilot/usage")).toBe("pat");
  });

  it("returns 'none' for non-GitHub absolute URLs regardless of path content", () => {
    // Even though path contains /enterprises/, the host is not GitHub
    expect(resolveAuthMode("https://example.com/enterprises/foo")).toBe("none");
  });
});
