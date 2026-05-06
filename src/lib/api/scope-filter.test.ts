import { describe, it, expect } from "vitest";
import { filterByScope } from "./scope-filter";

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
