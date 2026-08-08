import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./graphql-client", async () => {
  const actual = await vi.importActual<typeof import("./graphql-client")>("./graphql-client");
  return {
    ...actual,
    githubGraphQLPaginated: vi.fn(),
  };
});

import { githubGraphQLPaginated } from "./graphql-client";
import { CopilotIdentityClient } from "./copilot-identity-client";

const mockPaginated = githubGraphQLPaginated as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotIdentityClient();

beforeEach(() => {
  mockPaginated.mockReset();
});

describe("CopilotIdentityClient", () => {
  describe("getEnterpriseIdentities", () => {
    it("normalizes github user id/login/external identity/source/observed timestamp", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [
          {
            guid: "guid-1",
            samlIdentity: { nameId: "octocat@example.com", username: null },
            scimIdentity: { username: "octocat-scim" },
            user: { login: "octocat", databaseId: 42 },
          },
        ],
        warnings: [],
      });

      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities).toHaveLength(1);
      const identity = result.identities[0];
      expect(identity.identityKey).toBe("guid:guid-1");
      expect(identity.githubUserId).toBe(42);
      expect(identity.resolvedLogin).toBe("octocat");
      expect(identity.externalIdentity).toBe("octocat@example.com");
      expect(identity.source).toBe("enterprise_identity");
      expect(() => new Date(identity.observedAt).toISOString()).not.toThrow();
      expect(new Date(identity.observedAt).toISOString()).toBe(identity.observedAt);
    });

    it("falls back to scimIdentity.username when samlIdentity.nameId is absent", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ guid: "g2", samlIdentity: null, scimIdentity: { username: "scim-only" }, user: { login: "u", databaseId: 1 } }],
        warnings: [],
      });
      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities[0].externalIdentity).toBe("scim-only");
    });

    it("forces enterprise PAT auth context", async () => {
      mockPaginated.mockResolvedValueOnce({ nodes: [], warnings: [] });
      await client.getEnterpriseIdentities("my-ent", { enterpriseSlug: "my-ent" });
      expect(mockPaginated).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({ forceEnterprisePAT: true, enterpriseSlug: "my-ent", variables: { slug: "my-ent" } }),
      );
    });

    it("tolerates partial GraphQL data and surfaces warnings", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ guid: "g1", user: { login: "a", databaseId: 1 } }],
        warnings: ["Could not resolve to an ExternalIdentity (at enterprise.ownerInfo)"],
      });
      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities).toHaveLength(1);
      expect(result.warnings).toEqual(["Could not resolve to an ExternalIdentity (at enterprise.ownerInfo)"]);
    });

    it("tolerates null nodes (extractConnection callback deals with GraphQL null-node skipping upstream)", async () => {
      // githubGraphQLPaginated itself is responsible for skipping null nodes;
      // this client must not choke if given an empty result because of that.
      mockPaginated.mockResolvedValueOnce({ nodes: [], warnings: ["a parent field was null"] });
      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities).toEqual([]);
      expect(result.warnings).toEqual(["a parent field was null"]);
    });

    it("falls back to a login-based identityKey when guid is absent", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ user: { login: "NoGuidUser", databaseId: 5 } }],
        warnings: [],
      });
      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities[0].identityKey).toBe("login:noguiduser");
    });

    it("falls back to an external-identity-based identityKey when both guid and login are absent", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ samlIdentity: { nameId: "orphan@example.com" } }],
        warnings: [],
      });
      const result = await client.getEnterpriseIdentities("my-ent");
      expect(result.identities[0].identityKey).toBe("external:orphan@example.com");
      expect(result.identities[0].resolvedLogin).toBeNull();
    });

    it("extracts the connection through the enterprise/ownerInfo/samlIdentityProvider chain", async () => {
      mockPaginated.mockResolvedValueOnce({ nodes: [], warnings: [] });
      await client.getEnterpriseIdentities("my-ent");
      const [, extractConnection] = mockPaginated.mock.calls[0];
      const connection = { nodes: [{ guid: "x" }], pageInfo: { hasNextPage: false, endCursor: null } };
      expect(
        extractConnection({ enterprise: { ownerInfo: { samlIdentityProvider: { externalIdentities: connection } } } }),
      ).toBe(connection);
      expect(extractConnection({ enterprise: null })).toBeUndefined();
    });
  });

  describe("getOrgIdentities", () => {
    it("does not force enterprise PAT auth", async () => {
      mockPaginated.mockResolvedValueOnce({ nodes: [], warnings: [] });
      await client.getOrgIdentities("acme-org");
      const [, , options] = mockPaginated.mock.calls[0];
      expect(options.forceEnterprisePAT).toBeUndefined();
      expect(options.variables).toEqual({ org: "acme-org" });
    });

    it("normalizes org identities with source org_identity", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ guid: "g", user: { login: "u", databaseId: 1 }, samlIdentity: { nameId: "u@example.com" } }],
        warnings: [],
      });
      const result = await client.getOrgIdentities("acme-org");
      expect(result.identities[0].source).toBe("org_identity");
    });

    it("extracts the connection through the organization/samlIdentityProvider chain", async () => {
      mockPaginated.mockResolvedValueOnce({ nodes: [], warnings: [] });
      await client.getOrgIdentities("acme-org");
      const [, extractConnection] = mockPaginated.mock.calls[0];
      const connection = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      expect(extractConnection({ organization: { samlIdentityProvider: { externalIdentities: connection } } })).toBe(connection);
      expect(extractConnection({ organization: null })).toBeUndefined();
    });
  });

  describe("resolveIdentities", () => {
    it("prefers enterprise identities and does not query org fallbacks when none are configured", async () => {
      mockPaginated.mockResolvedValueOnce({
        nodes: [{ guid: "g1", user: { login: "a", databaseId: 1 } }],
        warnings: [],
      });
      const result = await client.resolveIdentities("my-ent", []);
      expect(result.identities).toHaveLength(1);
      expect(mockPaginated).toHaveBeenCalledTimes(1);
    });

    it("merges org fallback identities not already covered by an enterprise identity's login", async () => {
      mockPaginated
        .mockResolvedValueOnce({
          nodes: [{ guid: "g1", user: { login: "covered", databaseId: 1 } }],
          warnings: [],
        })
        .mockResolvedValueOnce({
          nodes: [
            { guid: "g2", user: { login: "COVERED", databaseId: 1 } }, // same login, different case — should be skipped
            { guid: "g3", user: { login: "org-only", databaseId: 2 } },
          ],
          warnings: [],
        });

      const result = await client.resolveIdentities("my-ent", ["acme-org"]);
      expect(result.identities.map((i) => i.resolvedLogin)).toEqual(["covered", "org-only"]);
      expect(result.identities[1].source).toBe("org_identity");
    });

    it("aggregates warnings across enterprise and org fallback fetches", async () => {
      mockPaginated
        .mockResolvedValueOnce({ nodes: [], warnings: ["enterprise warning"] })
        .mockResolvedValueOnce({ nodes: [], warnings: ["org warning"] });
      const result = await client.resolveIdentities("my-ent", ["acme-org"]);
      expect(result.warnings).toEqual(["enterprise warning", "org warning"]);
    });

    it("queries multiple org fallbacks in order", async () => {
      mockPaginated
        .mockResolvedValueOnce({ nodes: [], warnings: [] })
        .mockResolvedValueOnce({ nodes: [{ guid: "a", user: { login: "one", databaseId: 1 } }], warnings: [] })
        .mockResolvedValueOnce({ nodes: [{ guid: "b", user: { login: "two", databaseId: 2 } }], warnings: [] });
      const result = await client.resolveIdentities("my-ent", ["org-a", "org-b"]);
      expect(result.identities.map((i) => i.resolvedLogin)).toEqual(["one", "two"]);
    });
  });
});
