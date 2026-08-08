import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", () => {
  class GitHubApiError extends Error {
    status: number;
    retryable: boolean;
    constructor(status: number, path: string, body: string, retryable = false) {
      super(`GitHub API error ${status} on ${path}: ${body}`);
      this.name = "GitHubApiError";
      this.status = status;
      this.retryable = retryable;
    }
  }
  return {
    githubFetchWithMeta: vi.fn(),
    GitHubApiError,
  };
});

import { githubFetchWithMeta, GitHubApiError } from "./api-base";
import { preflightEnterpriseAuth, ALL_CAPABILITIES } from "./auth-preflight";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

function statusOf(result: Awaited<ReturnType<typeof preflightEnterpriseAuth>>, capability: string) {
  return result.capabilities.find((c) => c.capability === capability);
}

describe("preflightEnterpriseAuth — classic PAT scopes", () => {
  it("reads selected X-OAuth-Scopes from /rate_limit without ever seeing Authorization", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      headers: { "x-oauth-scopes": "read:org, manage_billing:copilot, read:audit_log" },
    });

    await preflightEnterpriseAuth("acme-corp");

    expect(mockFetchWithMeta).toHaveBeenCalledWith(
      "/rate_limit",
      expect.objectContaining({ enterpriseSlug: "acme-corp" }),
    );
    // The primitive never returns an authorization header, so the preflight
    // logic has no way to reference request credentials — assert none of
    // the call arguments carry one.
    for (const call of mockFetchWithMeta.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/authorization/i);
    }
  });

  it("maps alternative accepted scopes for each capability", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      headers: { "x-oauth-scopes": "read:enterprise, manage_billing:copilot, read:audit_log" },
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("supported");
    expect(statusOf(result, "billing_usage")?.status).toBe("supported"); // via manage_billing:copilot alt
    expect(statusOf(result, "audit_log")?.status).toBe("supported");
    expect(statusOf(result, "membership")?.status).toBe("supported"); // via read:enterprise
    expect(result.ok).toBe(true);
  });

  it("reports the required copilot_seats capability as missing when its scope is absent", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      headers: { "x-oauth-scopes": "repo" },
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    const seats = statusOf(result, "copilot_seats");
    expect(seats?.status).toBe("unsupported");
    expect(seats?.required).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("reports optional capabilities as missing without failing the overall result", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      headers: { "x-oauth-scopes": "manage_billing:copilot" },
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    const auditLog = statusOf(result, "audit_log");
    expect(auditLog?.status).toBe("unsupported");
    expect(auditLog?.required).toBe(false);
    // Required capability (copilot_seats) is still satisfied via manage_billing:copilot.
    expect(result.ok).toBe(true);
  });

  describe("enterprise-valid scope mapping (no org-only false positives)", () => {
    it.each([
      ["manage_billing:copilot"],
      ["read:enterprise"],
      ["admin:enterprise"],
      ["manage_billing:enterprise"],
    ])("copilot_seats is supported with the enterprise scope %s", async (scope) => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": scope },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "copilot_seats")?.status).toBe("supported");
    });

    it.each([
      ["read:org"],
      ["admin:org"],
      ["repo"],
    ])("copilot_seats is NOT supported by the org-only/unrelated scope %s (false-positive guard)", async (scope) => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": scope },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "copilot_seats")?.status).toBe("unsupported");
    });

    it.each([
      ["read:enterprise"],
      ["admin:enterprise"],
    ])("membership is supported with the enterprise scope %s", async (scope) => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": scope },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "membership")?.status).toBe("supported");
    });

    it.each([
      ["read:org"],
      ["admin:org"],
    ])("membership is NOT supported by the org-only scope %s (false-positive guard)", async (scope) => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": scope },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "membership")?.status).toBe("unsupported");
    });

    it("audit_log is NOT supported by the org-only admin:org scope (false-positive guard)", async () => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": "admin:org" },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "audit_log")?.status).toBe("unsupported");
    });

    it("audit_log is supported by the enterprise admin:enterprise scope", async () => {
      mockFetchWithMeta.mockResolvedValue({
        data: {},
        status: 200,
        headers: { "x-oauth-scopes": "admin:enterprise" },
      });
      const result = await preflightEnterpriseAuth("acme-corp");
      expect(statusOf(result, "audit_log")?.status).toBe("supported");
    });
  });
});

describe("preflightEnterpriseAuth — fine-grained/App token probing", () => {
  it("probes minimal read endpoints when the scope header is unavailable", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") {
        return { data: {}, status: 200, headers: {} }; // no x-oauth-scopes header at all
      }
      if (path.includes("/copilot/billing/seats")) {
        return { data: {}, status: 200, headers: {} };
      }
      const err = new GitHubApiError(403, path, "Forbidden");
      throw err;
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("supported");
    expect(statusOf(result, "billing_usage")?.status).toBe("unsupported");
    expect(result.ok).toBe(true);
  });

  it("probes billing_usage and aic_consumption against the real billing reports endpoint", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      return { data: {}, status: 200, headers: {} };
    });

    await preflightEnterpriseAuth("acme-corp");

    const calledPaths = mockFetchWithMeta.mock.calls.map((call) => call[0]);
    // billing_usage must probe the real reports endpoint (not a nonexistent /usage path).
    expect(calledPaths).toContain("/enterprises/acme-corp/settings/billing/reports");
    // aic_consumption must NOT probe a nonexistent premium_requests path.
    expect(calledPaths).not.toEqual(
      expect.arrayContaining([expect.stringContaining("premium_requests")]),
    );
  });

  it("marks identity as supported via the probe path without issuing a separate /user probe", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      if (path.includes("/copilot/billing/seats")) return { data: {}, status: 200, headers: {} };
      throw new GitHubApiError(403, path, "Forbidden");
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "identity")?.status).toBe("supported");
    const calledPaths = mockFetchWithMeta.mock.calls.map((call) => call[0]);
    expect(calledPaths).not.toContain("/user");
  });

  it("reports unknown when a probe fails with a non-auth, non-scope error", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") {
        return { data: {}, status: 200, headers: {} };
      }
      if (path.includes("/copilot/billing/seats")) {
        return { data: {}, status: 200, headers: {} };
      }
      throw new GitHubApiError(500, path, "Internal Server Error");
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    const auditLog = statusOf(result, "audit_log");
    expect(auditLog?.status).toBe("unknown");
    // Unknown optional capabilities do not fail the overall result.
    expect(result.ok).toBe(true);
  });

  it("reports unknown (not unsupported) when a probe hits a rate-limited 403, distinguishing it from a real permission denial", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      // A rate-limited 403 is marked `retryable: true` by the real
      // githubFetchWithMeta primitive — the preflight must not misread
      // throttling as "you don't have this capability".
      throw new GitHubApiError(403, path, "API rate limit exceeded for installation ID 123.", true);
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("unknown");
    expect(statusOf(result, "billing_usage")?.status).toBe("unknown");
  });

  it("still reports unsupported for a genuine (non-rate-limited) permission-denied 403", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      // retryable: false — a real permission denial, not throttling.
      throw new GitHubApiError(403, path, "Resource not accessible by integration", false);
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("unsupported");
  });

  it("rethrows a 401 from an individual capability probe instead of reporting it as unsupported", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      if (path.includes("/copilot/billing/seats")) return { data: {}, status: 200, headers: {} };
      throw new GitHubApiError(401, path, "Bad credentials");
    });

    await expect(preflightEnterpriseAuth("acme-corp")).rejects.toThrow(GitHubApiError);
  });

  it("never includes raw response headers or tokens in probe capability messages", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      if (path.includes("/copilot/billing/seats")) return { data: {}, status: 200, headers: {} };
      throw new GitHubApiError(403, path, "Forbidden");
    });

    const result = await preflightEnterpriseAuth("acme-corp");
    for (const capability of result.capabilities) {
      expect(capability.message).not.toMatch(/bearer|token|x-oauth-scopes/i);
    }
  });
});

describe("preflightEnterpriseAuth — identity capability", () => {
  it("is supported after a successful classic-PAT /rate_limit check even without read:user scope", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      // No read:user or user scope granted at all.
      headers: { "x-oauth-scopes": "manage_billing:copilot" },
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "identity")?.status).toBe("supported");
  });
});

describe("preflightEnterpriseAuth — empty/whitespace scope header", () => {
  it("treats an empty X-OAuth-Scopes header as unavailable scope data and falls through to probing", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: { "x-oauth-scopes": "" } };
      if (path.includes("/copilot/billing/seats")) return { data: {}, status: 200, headers: {} };
      throw new GitHubApiError(403, path, "Forbidden");
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    // Falling through to probing (rather than treating "" as zero granted
    // scopes) lets copilot_seats be confirmed supported by the probe.
    expect(statusOf(result, "copilot_seats")?.status).toBe("supported");
  });

  it("treats a whitespace-only X-OAuth-Scopes header as unavailable scope data and falls through to probing", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: { "x-oauth-scopes": "   " } };
      if (path.includes("/copilot/billing/seats")) return { data: {}, status: 200, headers: {} };
      throw new GitHubApiError(403, path, "Forbidden");
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("supported");
  });
});

describe("preflightEnterpriseAuth — fail-fast auth errors", () => {
  it("propagates a 401 from the initial identity check instead of returning a success-shaped result", async () => {
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(401, "/rate_limit", "Bad credentials"));

    await expect(preflightEnterpriseAuth("acme-corp")).rejects.toThrow(GitHubApiError);
  });

  it("propagates a 403 from the initial identity check instead of returning a success-shaped result", async () => {
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(403, "/rate_limit", "Resource not accessible"));

    await expect(preflightEnterpriseAuth("acme-corp")).rejects.toThrow(GitHubApiError);
  });

  it("does not swallow a genuinely unexpected non-GitHubApiError failure (e.g. a programmer/caller bug)", async () => {
    // Real network/transport failures are always converted into a typed
    // GitHubApiError(0, ...) by githubFetchWithMeta (see the test below) —
    // they never surface as a bare Error. A bare Error thrown here instead
    // represents a genuine unexpected failure (a bug in calling code, an
    // unrelated exception, etc.) and must never be misclassified or
    // swallowed as if it were a capability signal.
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      throw new Error("unexpected internal error (not a GitHubApiError)");
    });

    await expect(preflightEnterpriseAuth("acme-corp")).rejects.toThrow("unexpected internal error (not a GitHubApiError)");
  });

  it("reports unknown (not a thrown error) when a probe hits a transport-level failure represented as a typed GitHubApiError(0)", async () => {
    mockFetchWithMeta.mockImplementation(async (path: string) => {
      if (path === "/rate_limit") return { data: {}, status: 200, headers: {} };
      // githubFetchWithMeta represents an exhausted transport-level failure
      // (connection refused, DNS failure, etc.) as a typed GitHubApiError
      // using the `0` sentinel status with `retryable: true` — never as a
      // bare network Error.
      throw new GitHubApiError(0, path, "fetch failed: ECONNREFUSED", true);
    });

    const result = await preflightEnterpriseAuth("acme-corp");

    expect(statusOf(result, "copilot_seats")?.status).toBe("unknown");
  });
});

describe("preflightEnterpriseAuth — structural guarantees", () => {
  it("returns a result entry for every declared capability", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {},
      status: 200,
      headers: { "x-oauth-scopes": "manage_billing:copilot" },
    });

    const result = await preflightEnterpriseAuth("acme-corp");
    const seen = result.capabilities.map((c) => c.capability).sort();
    expect(seen).toEqual([...ALL_CAPABILITIES].sort());
    expect(result.enterpriseSlug).toBe("acme-corp");
  });
});
