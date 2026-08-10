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
import { fetchAicConsumptionForUsers } from "./aic-consumption-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

function okResponse(data: unknown) {
  return { data, status: 200, headers: {} };
}

describe("fetchAicConsumptionForUsers — happy path", () => {
  it("fetches consumption for each user from the enterprise endpoint", async () => {
    mockFetchWithMeta.mockImplementation(() => {
      return Promise.resolve(
        okResponse({ credits: 100, gross_amount_usd: 1.23, net_amount_usd: 1.1, organization: "acme-org" }),
      );
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob"],
    });

    expect(result.source).toBe("enterprise_api");
    expect(result.fellBackToOrg).toBe(false);
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.status).toBe("ok");
      if (r.status === "ok") {
        expect(r.record.credits).toBe(100);
        expect(r.record.grossUsd).toBe(1.23);
        expect(r.record.netUsd).toBe(1.1);
        expect(r.record.orgLogin).toBe("acme-org");
        expect(r.record.source).toBe("enterprise_api");
        expect(r.record.billingPeriod).toBe("2026-01");
      }
    }

    // Verify the correct enterprise endpoint shape was requested.
    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    expect(calledPaths.some((p) => p.includes("/enterprises/acme/settings/billing/ai_credit/usage"))).toBe(true);
    expect(calledPaths.every((p) => p.includes("year=2026") && p.includes("month=1"))).toBe(true);
  });

  it("falls back to credits*creditToUsd when gross USD is missing from the response", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse({ credits: 200 }));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 2,
      users: ["alice"],
      creditToUsd: 0.02,
    });

    const [r] = result.results;
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.record.grossUsd).toBe(4); // 200 * 0.02
      expect(r.record.netUsd).toBeNull();
    }
  });

  it("uses the org endpoint directly when no enterpriseSlug is given", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse({ credits: 10 }));

    const result = await fetchAicConsumptionForUsers({
      orgLogin: "my-org",
      year: 2026,
      month: 3,
      users: ["alice"],
    });

    expect(result.source).toBe("org_api");
    expect(result.fellBackToOrg).toBe(false);
    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    expect(calledPaths[0]).toContain("/organizations/my-org/settings/billing/ai_credit/usage");
  });
});

describe("fetchAicConsumptionForUsers — isolated 404 (no fallback)", () => {
  it("treats a single user's 404 as a not_found result and continues processing other users on the enterprise endpoint", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("user=bob")) {
        return Promise.reject(new GitHubApiError(404, p, "Not Found", false));
      }
      return Promise.resolve(okResponse({ credits: 50 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org", // fallback destination configured but should NOT be used
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    expect(result.source).toBe("enterprise_api");
    expect(result.fellBackToOrg).toBe(false);

    const byUser = new Map(result.results.map((r) => [r.userLogin, r]));
    expect(byUser.get("alice")?.status).toBe("ok");
    expect(byUser.get("bob")?.status).toBe("not_found");
    expect(byUser.get("carol")?.status).toBe("ok");

    // All calls should have hit the enterprise endpoint — none fell back to org.
    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    expect(calledPaths.every((p) => p.includes("/enterprises/acme/"))).toBe(true);
  });

  it("does not trigger fallback even when the very first (preflight) user is a 404", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("user=alice")) {
        return Promise.reject(new GitHubApiError(404, p, "Not Found", false));
      }
      return Promise.resolve(okResponse({ credits: 5 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice", "bob"],
    });

    expect(result.fellBackToOrg).toBe(false);
    expect(result.source).toBe("enterprise_api");
    const byUser = new Map(result.results.map((r) => [r.userLogin, r]));
    expect(byUser.get("alice")?.status).toBe("not_found");
    expect(byUser.get("bob")?.status).toBe("ok");
  });
});

describe("fetchAicConsumptionForUsers — endpoint-wide fallback", () => {
  it("falls back to the org endpoint for the whole batch when the enterprise endpoint is forbidden", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) {
        return Promise.reject(new GitHubApiError(403, p, "Forbidden", false));
      }
      return Promise.resolve(okResponse({ credits: 42 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    expect(result.fellBackToOrg).toBe(true);
    expect(result.source).toBe("org_api");
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.status).toBe("ok");
    }
    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    // The org endpoint should have been called for every user, including alice
    // (the preflight probe user), not just the remaining ones.
    expect(calledPaths.filter((p) => p.includes("/organizations/my-org/"))).toHaveLength(3);
  });

  it("falls back when the enterprise endpoint is unavailable (e.g. HTTP 501)", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) {
        return Promise.reject(new GitHubApiError(501, p, "Not Implemented", false));
      }
      return Promise.resolve(okResponse({ credits: 7 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.fellBackToOrg).toBe(true);
    expect(result.source).toBe("org_api");
  });

  it("falls back to the org endpoint for the whole batch when the enterprise preflight response is malformed", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) {
        // A 2xx response whose body doesn't match the expected shape —
        // classified "malformed", which (like forbidden/unavailable) is a
        // capability/run-level signal, distinct from an isolated 404.
        return Promise.resolve(okResponse("not-an-object"));
      }
      return Promise.resolve(okResponse({ credits: 11 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice", "bob"],
    });

    expect(result.fellBackToOrg).toBe(true);
    expect(result.source).toBe("org_api");
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r.status).toBe("ok");
    }
    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    expect(calledPaths.filter((p) => p.includes("/organizations/my-org/"))).toHaveLength(2);
  });

  it("falls back to the org endpoint for the whole batch when the enterprise preflight fails with a transport error", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) {
        return Promise.reject(new GitHubApiError(0, p, "ECONNRESET", true));
      }
      return Promise.resolve(okResponse({ credits: 3 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.fellBackToOrg).toBe(true);
    expect(result.source).toBe("org_api");
    expect(result.results[0].status).toBe("ok");
  });

  it("keeps not_found and malformed statuses distinct rather than collapsing them: a single user's 404 never falls back, but a malformed preflight always does", async () => {
    // Case A: isolated 404 on the (only) preflight user — no fallback.
    mockFetchWithMeta.mockReset();
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(404, "/x", "Not Found", false));
    const notFoundResult = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice"],
    });
    expect(notFoundResult.fellBackToOrg).toBe(false);
    expect(notFoundResult.source).toBe("enterprise_api");
    expect(notFoundResult.results[0].status).toBe("not_found");

    // Case B: malformed preflight — always falls back when orgLogin is configured.
    mockFetchWithMeta.mockReset();
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) return Promise.resolve(okResponse("garbage"));
      return Promise.resolve(okResponse({ credits: 1 }));
    });
    const malformedResult = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["alice"],
    });
    expect(malformedResult.fellBackToOrg).toBe(true);
    expect(malformedResult.source).toBe("org_api");
  });

  it("reports every user with the same failure classification when no org fallback destination is configured, using a per-user message (not the preflight user's)", async () => {
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(403, "/x", "Forbidden", false));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob"],
    });

    expect(result.fellBackToOrg).toBe(false);
    expect(result.source).toBe("enterprise_api");
    for (const r of result.results) {
      expect(r.status).toBe("forbidden");
    }

    // Regression: every user's safe display message must name *that* user,
    // not the preflight probe user (alice) copied verbatim onto everyone.
    const alice = result.results.find((r) => r.userLogin === "alice");
    const bob = result.results.find((r) => r.userLogin === "bob");
    expect(alice?.status).toBe("forbidden");
    expect(bob?.status).toBe("forbidden");
    if (alice && "message" in alice) expect(alice.message).toContain("alice");
    if (bob && "message" in bob) expect(bob.message).toContain("bob");
    if (bob && "message" in bob) expect(bob.message).not.toContain("alice");
    if (alice && "message" in alice) expect(alice.message).not.toContain("bob");
    expect((alice as { message?: string })?.message).not.toBe((bob as { message?: string })?.message);
  });

  it("reports every user with its own per-user message when the capability failure is 'unavailable' (non-403/404/malformed HTTP status)", async () => {
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(501, "/x", "Not Implemented", false));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.status).toBe("unavailable");
      if ("message" in r) expect(r.message).toContain(r.userLogin);
    }
    const messages = result.results.map((r) => ("message" in r ? r.message : ""));
    expect(new Set(messages).size).toBe(3); // all distinct — none copied verbatim from another user
  });

  it("never leaks the preflight user's login into another user's message when a malformed preflight failure is copied across the batch (no org fallback configured)", async () => {
    // The preflight probe always fetches the first user ("alice") first;
    // every user gets a malformed (non-object) response body.
    mockFetchWithMeta.mockResolvedValue(okResponse("garbage"));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    expect(result.fellBackToOrg).toBe(false);
    expect(result.results).toHaveLength(3);

    const allLogins = ["alice", "bob", "carol"];
    for (const r of result.results) {
      expect(r.status).toBe("malformed");
      if (!("message" in r)) continue;
      expect(r.message).toContain(r.userLogin);
      for (const otherLogin of allLogins) {
        if (otherLogin === r.userLogin) continue;
        // Regression: bob's (or carol's) message must never contain the
        // preflight user's ("alice") login, or any other user's login.
        expect(r.message.toLowerCase()).not.toContain(otherLogin.toLowerCase());
      }
    }
  });
});

describe("fetchAicConsumptionForUsers — error classification", () => {
  it("classifies a transport-level failure distinctly from forbidden/not_found", async () => {
    mockFetchWithMeta.mockRejectedValue(new GitHubApiError(0, "/x", "ECONNRESET", true));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.results[0].status).toBe("transport_error");
  });

  it("classifies a malformed (non-object) response body distinctly", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse("not-an-object"));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.results[0].status).toBe("malformed");
  });

  it("classifies a response missing a numeric credits/quantity field as malformed", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse({ organization: "acme-org" }));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.results[0].status).toBe("malformed");
  });

  it("continues processing other users after one user's response is malformed", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("user=bob")) {
        return Promise.resolve(okResponse("garbage"));
      }
      return Promise.resolve(okResponse({ credits: 1 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    const byUser = new Map(result.results.map((r) => [r.userLogin, r]));
    expect(byUser.get("alice")?.status).toBe("ok");
    expect(byUser.get("bob")?.status).toBe("malformed");
    expect(byUser.get("carol")?.status).toBe("ok");
  });

  it("classifies an unexpected programmer error (e.g. TypeError) as internal_error — never mislabeled as malformed or ok", async () => {
    const rawDetail = "Cannot read properties of undefined (reading 'sensitiveValue')";
    mockFetchWithMeta.mockRejectedValue(new TypeError(rawDetail));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice"],
    });

    expect(result.results[0].status).not.toBe("malformed");
    expect(result.results[0].status).not.toBe("ok");
    expect(result.results[0].status).toBe("internal_error");
    if ("message" in result.results[0]) {
      expect(result.results[0].message).toContain("alice");
      expect(result.results[0].message).not.toContain(rawDetail);
      expect(result.results[0].detail).toBeUndefined();
    }
  });

  it("isolates a TypeError to the single affected user without aborting the rest of the batch", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("user=bob")) return Promise.reject(new TypeError("boom"));
      return Promise.resolve(okResponse({ credits: 1 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["alice", "bob", "carol"],
    });

    const byUser = new Map(result.results.map((r) => [r.userLogin, r]));
    expect(byUser.get("alice")?.status).toBe("ok");
    expect(byUser.get("bob")?.status).toBe("internal_error");
    expect(byUser.get("carol")?.status).toBe("ok");
  });
});

describe("fetchAicConsumptionForUsers — bounded concurrency", () => {
  it("never runs more than `concurrency` requests concurrently", async () => {
    const users = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];
    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;
    const resolvers: Array<() => void> = [];

    mockFetchWithMeta.mockImplementation(() => {
      inFlight++;
      totalCalls++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        resolvers.push(() => {
          inFlight--;
          resolve(okResponse({ credits: 1 }));
        });
      });
    });

    const promise = fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users,
      concurrency: 3,
    });

    // Drain resolvers one at a time (in whatever order they arrive),
    // asserting the in-flight count never exceeds the configured limit,
    // until every user has been dispatched and every in-flight call has
    // settled. A hard iteration cap turns a scheduling bug into a clear
    // assertion failure instead of a real test-runner timeout.
    for (let guard = 0; guard < 500 && (totalCalls < users.length || resolvers.length > 0); guard++) {
      if (resolvers.length > 0) {
        const next = resolvers.shift()!;
        next();
      }
      // Yield a tick so pLimit can schedule the next queued call.
      await new Promise((r) => setImmediate(r));
      expect(inFlight).toBeLessThanOrEqual(3);
    }

    expect(totalCalls).toBe(users.length);
    const result = await promise;
    expect(result.results).toHaveLength(8);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe("fetchAicConsumptionForUsers — one call per distinct holder (case-insensitive dedupe)", () => {
  it("issues exactly one enterprise-endpoint call per distinct login, case-insensitively, preserving first-seen casing and order", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse({ credits: 1 }));

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      year: 2026,
      month: 1,
      users: ["Alice", "alice", "ALICE", "Bob", "bob", "Alice"],
    });

    // Only two distinct holders — exactly one call each, not six.
    expect(mockFetchWithMeta).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
    // First-seen casing/order preserved: "Alice" before "Bob".
    expect(result.results.map((r) => r.userLogin)).toEqual(["Alice", "Bob"]);

    const calledPaths = mockFetchWithMeta.mock.calls.map((c) => c[0] as string);
    expect(calledPaths.some((p) => p.includes("user=Alice"))).toBe(true);
    expect(calledPaths.some((p) => p.includes("user=Bob"))).toBe(true);
    // Only the first-seen casing was ever requested — no separate calls for
    // the "alice"/"ALICE"/"bob" duplicate-casing variants.
    expect(calledPaths.some((p) => p.includes("user=alice"))).toBe(false);
    expect(calledPaths.some((p) => p.includes("user=ALICE"))).toBe(false);
    expect(calledPaths.some((p) => p.includes("user=bob"))).toBe(false);
  });

  it("dedupes case-insensitively in org-only mode (no enterpriseSlug) before issuing any calls", async () => {
    mockFetchWithMeta.mockResolvedValue(okResponse({ credits: 1 }));

    const result = await fetchAicConsumptionForUsers({
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["Carol", "carol", "CAROL"],
    });

    expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].userLogin).toBe("Carol");
  });

  it("dedupes before falling back to the org endpoint, so the fallback batch also issues one call per distinct holder", async () => {
    mockFetchWithMeta.mockImplementation((p: string) => {
      if (p.includes("/enterprises/")) return Promise.reject(new GitHubApiError(403, p, "Forbidden", false));
      return Promise.resolve(okResponse({ credits: 1 }));
    });

    const result = await fetchAicConsumptionForUsers({
      enterpriseSlug: "acme",
      orgLogin: "my-org",
      year: 2026,
      month: 1,
      users: ["Dave", "dave", "DAVE"],
    });

    expect(result.fellBackToOrg).toBe(true);
    expect(result.results).toHaveLength(1);
    // One preflight call (enterprise, 403) + one org-endpoint call for the single distinct holder.
    expect(mockFetchWithMeta).toHaveBeenCalledTimes(2);
  });
});
