import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", () => ({
  githubFetchWithMeta: vi.fn(),
  githubFetchPaginated: vi.fn(),
}));

import { githubFetchWithMeta, githubFetchPaginated } from "./api-base";
import { CopilotMembershipClient } from "./copilot-membership-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;
const mockFetchPaginated = githubFetchPaginated as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotMembershipClient();

const GITHUB_EXT = "urn:ietf:params:scim:schemas:extension:GitHub:2.0:User";

beforeEach(() => {
  mockFetchWithMeta.mockReset();
  mockFetchPaginated.mockReset();
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

      const [record] = await client.getEnterpriseScimUsers("my-ent");
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
      const [record] = await client.getEnterpriseScimUsers("my-ent");
      expect(record.accountState).toBe("suspended");
      expect(record.observedLogin).toBe("stillLinked");
    });

    it("normalizes an inactive SCIM user with no linked GitHub account as deprovisioned", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: { totalResults: 1, Resources: [{ id: "scim-3", userName: "u@example.com", active: false }] },
        status: 200,
        headers: {},
      });
      const [record] = await client.getEnterpriseScimUsers("my-ent");
      expect(record.accountState).toBe("deprovisioned");
      expect(record.observedLogin).toBeNull();
    });

    it("normalizes a SCIM user with no active field as unknown", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: { totalResults: 1, Resources: [{ id: "scim-4", userName: "u@example.com" }] },
        status: 200,
        headers: {},
      });
      const [record] = await client.getEnterpriseScimUsers("my-ent");
      expect(record.accountState).toBe("unknown");
    });

    it("paginates using startIndex/count/totalResults", async () => {
      const page1 = Array.from({ length: 2 }, (_, i) => ({ id: `s${i}`, active: true, [GITHUB_EXT]: { githubUsername: `u${i}` } }));
      const page2 = [{ id: "s2", active: true, [GITHUB_EXT]: { githubUsername: "u2" } }];
      mockFetchWithMeta
        .mockResolvedValueOnce({ data: { totalResults: 3, Resources: page1 }, status: 200, headers: {} })
        .mockResolvedValueOnce({ data: { totalResults: 3, Resources: page2 }, status: 200, headers: {} });

      const records = await client.getEnterpriseScimUsers("my-ent", { count: 2 });
      expect(records).toHaveLength(3);
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
      const records = await client.getEnterpriseScimUsers("my-ent");
      expect(records).toEqual([]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("respects the maxPages safety guard", async () => {
      mockFetchWithMeta.mockImplementation(async () => ({
        data: { totalResults: 999999, Resources: [{ id: `s-${Math.random()}`, active: true }] },
        status: 200,
        headers: {},
      }));
      const records = await client.getEnterpriseScimUsers("my-ent", { maxPages: 3, count: 1 });
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
      expect(records).toHaveLength(3);
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
  });

  describe("getOrgMembers", () => {
    it("normalizes org members as member state with a verified login and no external identity", async () => {
      mockFetchPaginated.mockResolvedValueOnce([{ login: "octocat", id: 1 }, { login: "hubot", id: 2 }]);
      const records = await client.getOrgMembers("acme");
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({ observedLogin: "octocat", githubUserId: 1, accountState: "member", source: "org_membership", externalIdentity: null });
    });

    it("delegates pagination to githubFetchPaginated against /orgs/{org}/members", async () => {
      mockFetchPaginated.mockResolvedValueOnce([]);
      await client.getOrgMembers("acme", "my-ent");
      expect(mockFetchPaginated).toHaveBeenCalledWith("/orgs/acme/members", 100, undefined, "my-ent");
    });
  });
});
