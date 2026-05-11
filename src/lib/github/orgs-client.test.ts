import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", () => ({
  githubFetchPaginated: vi.fn(),
}));

import { OrgsClient } from "./orgs-client";
import { githubFetchPaginated } from "./api-base";

const mockFetchPaginated = githubFetchPaginated as ReturnType<typeof vi.fn>;
const client = new OrgsClient();

describe("OrgsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listEnterpriseOrgs", () => {
    it("returns list of orgs from the API", async () => {
      mockFetchPaginated.mockResolvedValue([
        { login: "org-alpha", id: 1 },
        { login: "org-beta", id: 2 },
      ]);
      const result = await client.listEnterpriseOrgs("my-ent");
      expect(result).toEqual([
        { login: "org-alpha", id: 1 },
        { login: "org-beta", id: 2 },
      ]);
    });

    it("calls correct API path /enterprises/{enterprise}/organizations", async () => {
      mockFetchPaginated.mockResolvedValue([]);
      await client.listEnterpriseOrgs("acme-corp");
      expect(mockFetchPaginated).toHaveBeenCalledWith(
        "/enterprises/acme-corp/organizations",
        100,
        "pat",
        undefined,
      );
    });

    it("passes enterpriseSlug for auth when provided", async () => {
      mockFetchPaginated.mockResolvedValue([]);
      await client.listEnterpriseOrgs("acme-corp", "acme-slug");
      expect(mockFetchPaginated).toHaveBeenCalledWith(
        "/enterprises/acme-corp/organizations",
        100,
        "pat",
        "acme-slug",
      );
    });

    it("uses 'pat' auth mode", async () => {
      mockFetchPaginated.mockResolvedValue([]);
      await client.listEnterpriseOrgs("my-ent", "my-ent");
      const call = mockFetchPaginated.mock.calls[0];
      expect(call[2]).toBe("pat");
    });

    it("returns empty array when no orgs exist", async () => {
      mockFetchPaginated.mockResolvedValue([]);
      const result = await client.listEnterpriseOrgs("empty-ent");
      expect(result).toEqual([]);
    });
  });
});
