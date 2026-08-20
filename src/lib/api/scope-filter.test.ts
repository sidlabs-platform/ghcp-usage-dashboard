import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/teams-repo", () => ({
  resolveFilteredUsers: vi.fn(() => []),
  resolveFilteredUserScopes: vi.fn(() => []),
}));

import { filterByScope, parseScopeFilter } from "./scope-filter";
import { resolveFilteredUsers, resolveFilteredUserScopes } from "@/lib/db/teams-repo";

const mockResolve = resolveFilteredUsers as ReturnType<typeof vi.fn>;
const mockResolveScopes = resolveFilteredUserScopes as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockResolve.mockReset();
  mockResolve.mockReturnValue([]);
  mockResolveScopes.mockReset();
  mockResolveScopes.mockReturnValue([]);
});

describe("parseScopeFilter", () => {
  it("returns no filter when params are empty", () => {
    const result = parseScopeFilter(new URLSearchParams());
    expect(result.hasFilter).toBe(false);
    expect(result.allowedLogins).toBeUndefined();
    expect(result.enterpriseSlugs).toBeUndefined();
    expect(result.selectedTeams).toEqual([]);
    expect(result.selectedOrgs).toEqual([]);
  });

  it("parses enterprise filter only", () => {
    const result = parseScopeFilter(new URLSearchParams("enterprises=ent1,ent2"));
    expect(result.hasFilter).toBe(true);
    expect(result.selectedEnterprises).toEqual(["ent1", "ent2"]);
    expect(result.enterpriseSlugs).toEqual(["ent1", "ent2"]);
    expect(result.allowedLogins).toBeUndefined();
  });

  it("parses plain teams and resolves logins", () => {
    mockResolve.mockReturnValue(["alice", "bob"]);
    const result = parseScopeFilter(new URLSearchParams("teams=team-a,team-b"));
    expect(result.selectedTeams).toEqual(["team-a", "team-b"]);
    expect(result.hasFilter).toBe(true);
    expect(result.allowedLogins).toEqual(new Set(["alice", "bob"]));
    expect(mockResolve).toHaveBeenCalledWith(["team-a", "team-b"], [], undefined);
  });

  it("parses composite teams (enterprise:team)", () => {
    mockResolve.mockReturnValue(["charlie"]);
    const result = parseScopeFilter(new URLSearchParams("teams=ent1:team-x"));
    expect(result.selectedTeams).toEqual(["team-x"]);
    expect(result.allowedLogins).toEqual(new Set(["charlie"]));
    expect(result.enterpriseSlugs).toEqual(["ent1"]);
    expect(mockResolve).toHaveBeenCalledWith(["team-x"], [], ["ent1"]);
  });

  it("parses orgs and resolves logins", () => {
    mockResolve.mockReturnValue(["dave"]);
    const result = parseScopeFilter(new URLSearchParams("orgs=org1"));
    expect(result.selectedOrgs).toEqual(["org1"]);
    expect(result.allowedLogins).toEqual(new Set(["dave"]));
    expect(mockResolve).toHaveBeenCalledWith([], ["org1"], undefined);
  });

  it("handles composite + plain teams together", () => {
    mockResolve.mockReturnValueOnce(["user1"]).mockReturnValueOnce(["user2"]);
    const result = parseScopeFilter(new URLSearchParams("teams=ent1:team-a,plain-team"));
    expect(result.selectedTeams).toEqual(["plain-team", "team-a"]);
    expect(result.allowedLogins).toEqual(new Set(["user1", "user2"]));
  });

  it("groups multiple composite teams from same enterprise", () => {
    mockResolve.mockReturnValue(["user1", "user2"]);
    const result = parseScopeFilter(new URLSearchParams("teams=ent1:team-a,ent1:team-b"));
    expect(result.selectedTeams).toEqual(["team-a", "team-b"]);
    expect(mockResolve).toHaveBeenCalledWith(["team-a", "team-b"], [], ["ent1"]);
  });

  it("intersects composite team members with organization members", () => {
    mockResolveScopes.mockReturnValue([
      { enterpriseSlug: "ent1", userLogin: "shared" },
    ]);
    const result = parseScopeFilter(new URLSearchParams("teams=ent1:team-a&orgs=org1"));
    expect(result.allowedLogins).toEqual(new Set(["shared"]));
    expect(result.allowedUserScopes).toEqual([
      { enterpriseSlug: "ent1", userLogin: "shared" },
    ]);
  });

  it("intersects plain team members with organization members", () => {
    mockResolveScopes.mockReturnValue([
      { enterpriseSlug: "ent1", userLogin: "shared" },
    ]);
    const result = parseScopeFilter(new URLSearchParams("teams=team-a&orgs=octodemo"));
    expect(result.allowedLogins).toEqual(new Set(["shared"]));
    expect(mockResolveScopes).toHaveBeenCalledWith(["team-a"], ["octodemo"], undefined);
  });

  it("preserves enterprise identity for same-login intersections", () => {
    mockResolveScopes.mockReturnValue([]);
    const result = parseScopeFilter(
      new URLSearchParams("teams=ent1:team-a&orgs=octodemo"),
    );

    expect(result.enterpriseSlugs).toEqual(["ent1"]);
    expect(result.allowedLogins).toEqual(new Set());
    expect(result.allowedUserScopes).toEqual([]);
    expect(mockResolveScopes).toHaveBeenCalledWith(["team-a"], ["octodemo"], ["ent1"]);
  });
});

describe("filterByScope", () => {
  const records = [
    { user_login: "alice", count: 10 },
    { user_login: "bob", count: 20 },
    { user_login: "charlie", count: 30 },
  ];

  it("returns all records when no filter is active", () => {
    const filter = {
      selectedTeams: [],
      selectedOrgs: [],
      selectedEnterprises: [],
      hasFilter: false,
      allowedLogins: undefined,
    };
    const result = filterByScope(records, filter);
    expect(result).toEqual(records);
  });

  it("returns all records when hasFilter is true but allowedLogins is undefined", () => {
    const filter = {
      selectedTeams: ["team-a"],
      selectedOrgs: [],
      selectedEnterprises: [],
      hasFilter: true,
      allowedLogins: undefined,
    };
    const result = filterByScope(records, filter);
    expect(result).toEqual(records);
  });

  it("filters records by allowedLogins set", () => {
    const filter = {
      selectedTeams: ["team-a"],
      selectedOrgs: [],
      selectedEnterprises: [],
      hasFilter: true,
      allowedLogins: new Set(["alice", "charlie"]),
    };
    const result = filterByScope(records, filter);
    expect(result).toEqual([
      { user_login: "alice", count: 10 },
      { user_login: "charlie", count: 30 },
    ]);
  });

  it("returns empty array when no logins match", () => {
    const filter = {
      selectedTeams: ["team-x"],
      selectedOrgs: [],
      selectedEnterprises: [],
      hasFilter: true,
      allowedLogins: new Set(["nobody"]),
    };
    const result = filterByScope(records, filter);
    expect(result).toEqual([]);
  });

  it("handles empty records array", () => {
    const filter = {
      selectedTeams: [],
      selectedOrgs: [],
      selectedEnterprises: [],
      hasFilter: true,
      allowedLogins: new Set(["alice"]),
    };
    const result = filterByScope([], filter);
    expect(result).toEqual([]);
  });
});
