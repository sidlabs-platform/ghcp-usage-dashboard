import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  githubFetchPaginated: vi.fn(() => []),
}));

import { TeamsClient } from "./teams-client";
import { githubFetchPaginated } from "./api-base";

const mockPaginated = githubFetchPaginated as ReturnType<typeof vi.fn>;
const client = new TeamsClient();

describe("TeamsClient", () => {
  it("getOrgTeams calls paginated API", async () => {
    mockPaginated.mockResolvedValue([{ slug: "team-a", name: "Team A" }]);
    const teams = await client.getOrgTeams("my-org");
    expect(teams).toHaveLength(1);
    expect(mockPaginated).toHaveBeenCalledWith("/orgs/my-org/teams", 100, undefined, undefined);
  });

  it("getOrgTeamMembers calls paginated API", async () => {
    mockPaginated.mockResolvedValue([{ login: "alice" }]);
    const members = await client.getOrgTeamMembers("my-org", "team-a");
    expect(members).toHaveLength(1);
    expect(members[0].login).toBe("alice");
  });

  it("getOrgTeamsWithMembers combines teams and members", async () => {
    mockPaginated
      .mockResolvedValueOnce([{ slug: "team-a", name: "Team A", description: "desc" }])
      .mockResolvedValueOnce([{ login: "alice" }, { login: "bob" }]);
    const results = await client.getOrgTeamsWithMembers("my-org");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("team-a");
    expect(results[0].members).toEqual(["alice", "bob"]);
  });

  it("getEnterpriseTeams handles API failure gracefully", async () => {
    mockPaginated.mockRejectedValue(new Error("Not available"));
    const teams = await client.getEnterpriseTeams("my-ent");
    expect(teams).toEqual([]);
  });

  it("getEnterpriseTeamsWithMembers combines teams and members", async () => {
    mockPaginated
      .mockResolvedValueOnce([{ slug: "ent-team", name: "Ent Team" }])
      .mockResolvedValueOnce([{ login: "charlie" }]);
    const results = await client.getEnterpriseTeamsWithMembers("my-ent");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("ent-team");
    expect(results[0].members).toEqual(["charlie"]);
  });
});
