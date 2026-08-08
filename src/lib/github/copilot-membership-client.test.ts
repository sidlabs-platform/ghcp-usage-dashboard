import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", async () => {
  const actual = await vi.importActual<typeof import("./api-base")>("./api-base");
  return {
    ...actual,
    githubFetchWithMeta: vi.fn(),
  };
});

import { githubFetchWithMeta, GitHubApiError } from "./api-base";
import { CopilotMembershipClient, type ScimFetchResult } from "./copilot-membership-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotMembershipClient();

const GITHUB_EXT = "urn:ietf:params:scim:schemas:extension:GitHub:2.0:User";

function expectOk(result: ScimFetchResult): asserts result is ScimFetchResult & { status: "ok" } {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
}

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

describe("CopilotMembershipClient", () => {
  describe("getEnterpriseScimUsers", () => {
    it("normalizes an active SCIM user as member state, using only the verified GitHub login", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: {
          totalResults: 1,
          Resources: [
            {
              id: "scim-1",
              externalId: "idp-external-1",
              userName: "octocat@example.com",
              active: true,
              [GITHUB_EXT]: { githubUsername: "octocat", githubUserId: 42 },
            },
          ],
        },
        status: 200,
        headers: {},
      });

      const result = await client.getEnterpriseScimUsers("my-ent");
      expectOk(result);
      const [record] = result.records;
      expect(record.accountState).toBe("member");
      expect(record.observedLogin).toBe("octocat");
      expect(record.githubUserId).toBe(42);
      expect(record.externalIdentity).toBe("idp-external-1");
      expect(record.source).toBe("scim_enterprise");
      // externalId/userName must never leak into observedLogin.
      expect(record.observedLogin).not.toBe("idp-external-1");
      expect(record.observedLogin).not.toBe("octocat@example.com");
    });

    it("normalizes an inactive SCIM user with a linked GitHub account as suspended", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: {
          totalResults: 1,
          Resources: [{ id: "scim-2", userName: "u@example.com", active: false, [GITHUB_EXT]: { githubUsername: "stillLinked" } }],
        },
        status: 200,
        headers: {},
      });
      const result = await client.getEnterpriseScimUsers("my-ent");
      expectOk(result);
      expect(result.records[0].accountState).toBe("suspended");
      expect(result.records[0].observedLogin).toBe("stillLinked");
    });

    it("normalizes an inactive SCIM user with no linked GitHub account as deprovisioned", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: { totalResults: 1, Resources: [{ id: "scim-3", userName: "u@example.com", active: false }] },
        status: 200,
        headers: {},
      });
      const result = await client.getEnterpriseScimUsers("my-ent");
      expectOk(result);
      expect(result.records[0].accountState).toBe("deprovisioned");
      expect(result.records[0].observedLogin).toBeNull();
    });

    it("normalizes a SCIM user with no active field as unknown", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: { totalResults: 1, Resources: [{ id: "scim-4", userName: "u@example.com" }] },
        status: 200,
        headers: {},
      });
      const result = await client.getEnterpriseScimUsers("my-ent");
      expectOk(result);
      expect(result.records[0].accountState).toBe("unknown");
    });

    it("paginates using startIndex/count/totalResults", async () => {
      const page1 = Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, active: true, [GITHUB_EXT]: { githubUsername: `u${i}` } }));
      const page2 = [{ id: "s2", active: true, [GITHUB_EXT]: { githubUsername: "u2" } }];
      mockFetchWithMeta
        .mockResolvedValueOnce({ data: { totalResults: 3, Resources: page1 }, status: 200, headers: {} })
        .mockResolvedValueOnce({ data: { totalResults: 3, Resources: page2 }, status: 200, headers: {} });

      const result = await client.getEnterpriseScimUsers("my-ent", { count: 2 });
      expectOk(result);
      expect(result.records).toHaveLength(3);
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("startIndex=1&count=2"),
        expect.anything(),
      );
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("startIndex=3&count=2"),
        expect.anything(),
      );
    });

    it("stops paginating when a page returns no resources", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: { totalResults: 5, Resources: [] }, status: 200, headers: {} });
      const result = await client.getEnterpriseScimUsers("my-ent");
      expectOk(result);
      expect(result.records).toEqual([]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("respects the maxPages safety guard", async () => {
      mockFetchWithMeta.mockImplementation(async () => ({
        data: { totalResults: 999999, Resources: [{ id: `s-${Math.random()}`, active: true }] },
        status: 200,
        headers: {},
      }));
      const result = await client.getEnterpriseScimUsers("my-ent", { maxPages: 3, count: 1 });
      expectOk(result);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
      expect(result.records).toHaveLength(3);
    });

    it("throws when maxPages is not a positive integer", async () => {
      await expect(client.getEnterpriseScimUsers("my-ent", { maxPages: -1 })).rejects.toThrow(/maxPages/);
    });

    it("uses PAT auth mode for the enterprise SCIM endpoint", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: { totalResults: 0, Resources: [] }, status: 200, headers: {} });
      await client.getEnterpriseScimUsers("my-ent", { enterpriseSlug: "my-ent" });
      expect(mockFetchWithMeta).toHaveBeenCalledWith(
        expect.stringContaining("/scim/v2/enterprises/my-ent/Users"),
        expect.objectContaining({ authMode: "pat", enterpriseSlug: "my-ent" }),
      );
    });

    describe("optional-source outcomes (missing/forbidden must not throw or look success-shaped)", () => {
      it("returns a typed unavailable/not_found result on 404, not an empty success", async () => {
        mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(404, "/scim/v2/enterprises/my-ent/Users", "Not Found", false));
        const result = await client.getEnterpriseScimUsers("my-ent");
        expect(result).toEqual({ status: "unavailable", reason: "not_found", enterprise: "my-ent" });
      });

      it("returns a typed unavailable/forbidden result on 403, not an empty success", async () => {
        mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/scim/v2/enterprises/my-ent/Users", "Forbidden", false));
        const result = await client.getEnterpriseScimUsers("my-ent");
        expect(result).toEqual({ status: "unavailable", reason: "forbidden", enterprise: "my-ent" });
      });

      it("returns a typed unknown result for a rate-limited/retryable GitHubApiError rather than treating it as unavailable", async () => {
        mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(429, "/scim/v2/enterprises/my-ent/Users", "rate limited", true));
        const result = await client.getEnterpriseScimUsers("my-ent");
        expect(result.status).toBe("unknown");
        if (result.status !== "unknown") throw new Error("expected unknown");
        expect(result.enterprise).toBe("my-ent");
        expect(result.message).toContain("429");
      });

      it("returns a typed unknown result for other GitHubApiError statuses (e.g. 500)", async () => {
        mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(500, "/scim/v2/enterprises/my-ent/Users", "boom", true));
        const result = await client.getEnterpriseScimUsers("my-ent");
        expect(result.status).toBe("unknown");
      });

      it("rethrows non-GitHubApiError failures instead of swallowing them (no broad catch)", async () => {
        mockFetchWithMeta.mockRejectedValueOnce(new Error("network exploded"));
        await expect(client.getEnterpriseScimUsers("my-ent")).rejects.toThrow("network exploded");
      });

      it("does not throw mid-pagination on a 404/403 that appears after a successful first page", async () => {
        mockFetchWithMeta
          .mockResolvedValueOnce({ data: { totalResults: 999, Resources: [{ id: "s1", active: true }] }, status: 200, headers: {} })
          .mockRejectedValueOnce(new GitHubApiError(403, "/scim/v2/enterprises/my-ent/Users", "Forbidden", false));
        const result = await client.getEnterpriseScimUsers("my-ent", { count: 1 });
        expect(result).toEqual({ status: "unavailable", reason: "forbidden", enterprise: "my-ent" });
      });
    });
  });

  describe("getOrgMembers", () => {
    it("normalizes org members as member state with a verified login and no external identity", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: [{ login: "octocat", id: 1 }, { login: "hubot", id: 2 }],
        status: 200,
        headers: {},
      });
      const records = await client.getOrgMembers("acme");
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ observedLogin: "octocat", githubUserId: 1, accountState: "member", source: "org_membership", externalIdentity: null });
    });

    it("paginates against /orgs/{org}/members using page/per_page", async () => {
      mockFetchWithMeta
        .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({ login: `u${i}`, id: i })), status: 200, headers: {} })
        .mockResolvedValueOnce({ data: [{ login: "last", id: 999 }], status: 200, headers: {} });
      const records = await client.getOrgMembers("acme", { enterpriseSlug: "my-ent" });
      expect(records).toHaveLength(101);
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("/orgs/acme/members"),
        expect.objectContaining({ enterpriseSlug: "my-ent" }),
      );
      expect(mockFetchWithMeta.mock.calls[0][0]).toContain("per_page=100");
      expect(mockFetchWithMeta.mock.calls[0][0]).toContain("page=1");
      expect(mockFetchWithMeta.mock.calls[1][0]).toContain("page=2");
    });

    it("stops paginating once a page returns fewer than per_page members", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: [{ login: "solo", id: 1 }], status: 200, headers: {} });
      const records = await client.getOrgMembers("acme");
      expect(records).toHaveLength(1);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("stops paginating when a page returns no members", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: [], status: 200, headers: {} });
      const records = await client.getOrgMembers("acme");
      expect(records).toEqual([]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("regression: terminates at a bounded maxPages instead of looping unboundedly against a page that never runs out", async () => {
      mockFetchWithMeta.mockImplementation(async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({ login: `u${i}`, id: i })),
        status: 200,
        headers: {},
      }));
      const records = await client.getOrgMembers("acme", { maxPages: 3 });
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
      expect(records).toHaveLength(300);
    });

    it("throws when maxPages is not a positive integer", async () => {
      await expect(client.getOrgMembers("acme", { maxPages: 0 })).rejects.toThrow(/maxPages/);
    });
  });
});
