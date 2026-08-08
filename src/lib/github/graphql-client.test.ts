import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", () => ({
  githubFetchWithMeta: vi.fn(),
}));

import { githubFetchWithMeta } from "./api-base";
import { githubGraphQL, githubGraphQLPaginated } from "./graphql-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

describe("githubGraphQL", () => {
  it("POSTs to /graphql with the query and typed variables in the body", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: { data: { viewer: { login: "octocat" } } },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL<{ viewer: { login: string } }>(
      "query($login: String!) { viewer { login } }",
      { variables: { login: "octocat" } },
    );
    expect(mockFetchWithMeta).toHaveBeenCalledWith(
      "/graphql",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          query: "query($login: String!) { viewer { login } }",
          variables: { login: "octocat" },
        }),
      }),
    );
    expect(result.data?.viewer.login).toBe("octocat");
    expect(result.warnings).toEqual([]);
  });

  it("forces enterprise PAT auth context when forceEnterprisePAT is set", async () => {
    mockFetchWithMeta.mockResolvedValue({ data: { data: {} }, status: 200, headers: {} });
    await githubGraphQL("query { viewer { login } }", {
      forceEnterprisePAT: true,
      enterpriseSlug: "acme-corp",
    });
    expect(mockFetchWithMeta).toHaveBeenCalledWith(
      "/graphql",
      expect.objectContaining({ authMode: "pat", enterpriseSlug: "acme-corp" }),
    );
  });

  it("does not force an auth mode when forceEnterprisePAT is not set", async () => {
    mockFetchWithMeta.mockResolvedValue({ data: { data: {} }, status: 200, headers: {} });
    await githubGraphQL("query { viewer { login } }", { enterpriseSlug: "acme-corp" });
    const [, options] = mockFetchWithMeta.mock.calls[0];
    expect(options.authMode).toBeUndefined();
    expect(options.enterpriseSlug).toBe("acme-corp");
  });

  it("preserves partial data and surfaces errors as sanitized warnings", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {
        data: { viewer: { login: "octocat" }, repository: null },
        errors: [{ message: "Could not resolve to a Repository", path: ["repository"] }],
      },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL<{ viewer: { login: string }; repository: null }>(
      "query { viewer { login } repository(name: \"x\") { id } }",
    );
    expect(result.data?.viewer.login).toBe("octocat");
    expect(result.data?.repository).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Could not resolve to a Repository");
  });

  it("sanitizes error messages so no token-like content is echoed", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {
        data: null,
        errors: [{ message: "Bad credentials: token ghp_abcdef1234567890 rejected" }],
      },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL("query { viewer { login } }");
    expect(result.warnings[0]).not.toContain("ghp_abcdef1234567890");
  });

  it("sanitizes fine-grained github_pat_ tokens", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {
        data: null,
        errors: [{ message: "Bad credentials: token github_pat_11ABCDEFG0123456789_abcdefghijklmnop rejected" }],
      },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL("query { viewer { login } }");
    expect(result.warnings[0]).not.toContain("github_pat_11ABCDEFG0123456789_abcdefghijklmnop");
    expect(result.warnings[0]).toContain("[redacted]");
  });

  it("sanitizes all classic gh_ token variants (ghp_, gho_, ghu_, ghs_, ghr_)", async () => {
    const variants = ["ghp_abcdefghij1234567890", "gho_abcdefghij1234567890", "ghu_abcdefghij1234567890", "ghs_abcdefghij1234567890", "ghr_abcdefghij1234567890"];
    for (const token of variants) {
      mockFetchWithMeta.mockResolvedValue({
        data: { data: null, errors: [{ message: `Bad credentials: token ${token} rejected` }] },
        status: 200,
        headers: {},
      });
      const result = await githubGraphQL("query { viewer { login } }");
      expect(result.warnings[0]).not.toContain(token);
    }
  });

  it("sanitizes Bearer-prefixed token values", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {
        data: null,
        errors: [{ message: "Authorization failed for header: Bearer abcdef0123456789ghijkl" }],
      },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL("query { viewer { login } }");
    expect(result.warnings[0]).not.toContain("abcdef0123456789ghijkl");
  });

  it("returns null data when the response has no data field", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: { errors: [{ message: "Something failed" }] },
      status: 200,
      headers: {},
    });
    const result = await githubGraphQL("query { viewer { login } }");
    expect(result.data).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });

  it("propagates retries option through to the underlying fetch primitive", async () => {
    mockFetchWithMeta.mockResolvedValue({ data: { data: {} }, status: 200, headers: {} });
    await githubGraphQL("query { viewer { login } }", { retries: 5 });
    const [, options] = mockFetchWithMeta.mock.calls[0];
    expect(options.retries).toBe(5);
  });
});

interface Node {
  id: string;
  name: string;
}

interface ConnectionData {
  organization: {
    members: {
      nodes: (Node | null)[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

function extractMembers(data: ConnectionData) {
  return data.organization.members;
}

describe("githubGraphQLPaginated", () => {
  it("follows cursors across pages and aggregates nodes", async () => {
    mockFetchWithMeta
      .mockResolvedValueOnce({
        data: {
          data: {
            organization: {
              members: {
                nodes: [{ id: "1", name: "Alice" }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        },
        status: 200,
        headers: {},
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            organization: {
              members: {
                nodes: [{ id: "2", name: "Bob" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
        status: 200,
        headers: {},
      });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query($after: String) { organization { members(first: 1, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.id)).toEqual(["1", "2"]);
    expect(mockFetchWithMeta).toHaveBeenCalledTimes(2);

    const [, secondCallOptions] = mockFetchWithMeta.mock.calls[1];
    expect(secondCallOptions.body.variables.after).toBe("cursor-1");
  });

  it("skips null nodes in a connection", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: {
        data: {
          organization: {
            members: {
              nodes: [{ id: "1", name: "Alice" }, null, { id: "2", name: "Bob" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 3) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.map((n) => n.id)).toEqual(["1", "2"]);
  });

  it("stops after the configured max-page guard even if hasNextPage stays true", async () => {
    mockFetchWithMeta.mockResolvedValue({
      data: {
        data: {
          organization: {
            members: {
              nodes: [{ id: "x", name: "Loop" }],
              pageInfo: { hasNextPage: true, endCursor: "always-next" },
            },
          },
        },
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query($after: String) { organization { members(first: 1, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
      { maxPages: 3 },
    );

    expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
    expect(result.nodes).toHaveLength(3);
    // hasNextPage was still true when the max-page guard kicked in — that
    // must surface as a warning so callers know results are incomplete.
    expect(result.warnings.some((w) => /max.?page|truncat/i.test(w))).toBe(true);
  });

  it("does not warn about truncation when pagination ends naturally before the max-page guard", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: {
        data: {
          organization: {
            members: {
              nodes: [{ id: "1", name: "Alice" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 1) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
      { maxPages: 10 },
    );

    expect(result.warnings.some((w) => /max.?page|truncat/i.test(w))).toBe(false);
  });

  it("tolerates a connection with missing nodes without throwing", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: {
        data: {
          organization: {
            // `nodes` omitted entirely — some GraphQL responses drop it
            // rather than returning an empty array.
            members: { pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 1) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("tolerates a connection with missing pageInfo without throwing, preserving warnings", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: {
        data: {
          organization: {
            // `pageInfo` omitted entirely.
            members: { nodes: [{ id: "1", name: "Alice" }] },
          },
        },
        errors: [{ message: "pageInfo could not be resolved" }],
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 1) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("pageInfo could not be resolved");
  });

  it("tolerates individual null entries mixed with a missing nodes array across pages", async () => {
    mockFetchWithMeta
      .mockResolvedValueOnce({
        data: {
          data: {
            organization: {
              members: {
                nodes: [null, { id: "1", name: "Alice" }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        },
        status: 200,
        headers: {},
      })
      .mockResolvedValueOnce({
        data: {
          data: {
            organization: {
              // Second page has no nodes at all and no pageInfo.
              members: {},
            },
          },
        },
        status: 200,
        headers: {},
      });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query($after: String) { organization { members(first: 1, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe("1");
    expect(mockFetchWithMeta).toHaveBeenCalledTimes(2);
  });

  it("collects warnings from partial errors across pages without throwing", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: {
        data: {
          organization: {
            members: {
              nodes: [{ id: "1", name: "Alice" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        errors: [{ message: "partial failure on some field" }],
      },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 1) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("stops early when data or the connection is missing", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({
      data: { data: null, errors: [{ message: "top-level failure" }] },
      status: 200,
      headers: {},
    });

    const result = await githubGraphQLPaginated<Node, ConnectionData>(
      "query { organization { members(first: 1) { nodes { id name } pageInfo { hasNextPage endCursor } } } }",
      extractMembers,
    );

    expect(result.nodes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
  });
});
