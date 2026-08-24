import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  upsertTeamMembers,
  upsertAllTeams,
  getAllTeams,
  getTeamMembers,
  getTeamsByUser,
  getTeamMembersMulti,
  getMembersForOrgs,
  getDistinctOrgs,
  getAllTeamsWithMembers,
  resolveFilteredUsers,
  resolveFilteredUserScopes,
} from "./teams-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));

  // Seed test data
  upsertAllTeams("acme", [
    { slug: "frontend", name: "Frontend Team", source: "org", orgSlug: "org-a", members: ["alice", "bob"], description: null },
    { slug: "backend", name: "Backend Team", source: "org", orgSlug: "org-a", members: ["bob", "charlie"], description: null },
    { slug: "devops", name: "DevOps Team", source: "org", orgSlug: "org-b", members: ["dave"], description: null },
  ]);
});

afterAll(() => {
  db.close();
});

describe("teams-repo", () => {
  describe("getAllTeams", () => {
    it("returns all teams with member counts", () => {
      const teams = getAllTeams();
      expect(teams.length).toBe(3);
      const fe = teams.find((t) => t.team_slug === "frontend");
      expect(fe?.member_count).toBe(2);
    });

    it("filters by enterprise slug", () => {
      const teams = getAllTeams(["acme"]);
      expect(teams.length).toBe(3);
      const empty = getAllTeams(["nonexistent"]);
      expect(empty.length).toBe(0);
    });

    it("counts login casing variants as one member", () => {
      try {
        upsertAllTeams("acme", [
          { slug: "case-team", name: "Case Team", source: "org", orgSlug: "org-a", members: ["Alice", "alice"], description: null },
        ]);

        const team = getAllTeams(["acme"]).find((row) => row.team_slug === "case-team");
        expect(team?.member_count).toBe(1);
        expect(getTeamMembers("case-team", ["acme"])).toHaveLength(1);
      } finally {
        db.prepare("DELETE FROM team_memberships WHERE team_slug = ?").run("case-team");
      }
    });
  });

  describe("getTeamMembers", () => {
    it("returns members of a team", () => {
      const members = getTeamMembers("frontend");
      expect(members.sort()).toEqual(["alice", "bob"]);
    });

    it("returns empty for unknown team", () => {
      expect(getTeamMembers("unknown")).toEqual([]);
    });
  });

  describe("getTeamsByUser", () => {
    it("returns teams a user belongs to", () => {
      const teams = getTeamsByUser("bob");
      expect(teams.map((t) => t.team_slug).sort()).toEqual(["backend", "frontend"]);
    });

    it("returns empty for unknown user", () => {
      expect(getTeamsByUser("nobody")).toEqual([]);
    });
  });

  describe("getTeamMembersMulti", () => {
    it("returns unique logins across multiple teams", () => {
      const logins = getTeamMembersMulti(["frontend", "backend"]);
      expect(logins.sort()).toEqual(["alice", "bob", "charlie"]);
    });

    it("returns empty for empty input", () => {
      expect(getTeamMembersMulti([])).toEqual([]);
    });
  });

  describe("getMembersForOrgs", () => {
    it("returns unique members for org", () => {
      const logins = getMembersForOrgs(["org-a"]);
      expect(logins.sort()).toEqual(["alice", "bob", "charlie"]);
    });

    it("returns empty for empty input", () => {
      expect(getMembersForOrgs([])).toEqual([]);
    });
  });

  describe("getDistinctOrgs", () => {
    it("returns distinct org slugs", () => {
      const orgs = getDistinctOrgs();
      expect(orgs.map((o) => o.slug).sort()).toEqual(["org-a", "org-b"]);
    });
  });

  describe("getAllTeamsWithMembers", () => {
    it("returns teams with their member arrays", () => {
      const teams = getAllTeamsWithMembers();
      expect(teams.length).toBe(3);
      const fe = teams.find((t) => t.team_slug === "frontend");
      expect(fe?.members.sort()).toEqual(["alice", "bob"]);
    });

    it("separates same-slug teams from different enterprises", () => {
      try {
        upsertAllTeams("globex", [
          { slug: "frontend", name: "Frontend Team", source: "org", orgSlug: "org-g", members: ["eve", "frank"], description: null },
        ]);
        const teams = getAllTeamsWithMembers();
        const frontends = teams.filter((t) => t.team_slug === "frontend");
        expect(frontends).toHaveLength(2);
        const acmeFe = frontends.find((t) => t.enterprise_slug === "acme");
        const globexFe = frontends.find((t) => t.enterprise_slug === "globex");
        expect(acmeFe?.members.sort()).toEqual(["alice", "bob"]);
        expect(globexFe?.members.sort()).toEqual(["eve", "frank"]);
      } finally {
        db.prepare("DELETE FROM team_memberships WHERE enterprise_slug = ?").run("globex");
      }
    });

    it("filters by enterprise slugs", () => {
      try {
        upsertAllTeams("globex", [
          { slug: "ops", name: "Ops", source: "org", orgSlug: "org-g", members: ["xena"], description: null },
        ]);
        const teams = getAllTeamsWithMembers(["acme"]);
        expect(teams.every((t) => t.enterprise_slug === "acme")).toBe(true);
        expect(teams.find((t) => t.team_slug === "ops")).toBeUndefined();
      } finally {
        db.prepare("DELETE FROM team_memberships WHERE enterprise_slug = ?").run("globex");
      }
    });

    it("handles team with no orgSlug", () => {
      try {
        upsertAllTeams("acme", [
          { slug: "global-team", name: "Global Team", source: "enterprise", orgSlug: "", members: ["zara"], description: null },
        ]);
        const teams = getAllTeamsWithMembers(["acme"]);
        const global = teams.find((t) => t.team_slug === "global-team");
        expect(global).toBeDefined();
        expect(global!.members).toEqual(["zara"]);
      } finally {
        db.prepare("DELETE FROM team_memberships WHERE team_slug = ?").run("global-team");
      }
    });
  });

  describe("resolveFilteredUsers", () => {
    it("resolves team filters to unique logins", () => {
      const logins = resolveFilteredUsers(["frontend"], []);
      expect(logins.sort()).toEqual(["alice", "bob"]);
    });

    it("resolves org filters to unique logins", () => {
      const logins = resolveFilteredUsers([], ["org-b"]);
      expect(logins).toEqual(["dave"]);
    });

    it("combines team and org filters", () => {
      const logins = resolveFilteredUsers(["frontend"], ["org-b"]);
      expect(logins.sort()).toEqual(["alice", "bob", "dave"]);
    });

    describe("resolveFilteredUserScopes", () => {
      it("intersects team and organization membership within one enterprise", () => {
        try {
          upsertAllTeams("globex", [
            { slug: "frontend", name: "Frontend", source: "org", orgSlug: "org-g", members: ["alice"], description: null },
            { slug: "other", name: "Other", source: "org", orgSlug: "org-a", members: ["zoe"], description: null },
          ]);

          expect(resolveFilteredUserScopes(["frontend"], ["org-a"])).toEqual([
            { enterpriseSlug: "acme", userLogin: "alice" },
            { enterpriseSlug: "acme", userLogin: "bob" },
          ]);
        } finally {
          db.prepare("DELETE FROM team_memberships WHERE enterprise_slug = ?").run("globex");
        }
      });

      it("intersects membership login casing variants", () => {
        try {
          upsertAllTeams("acme", [
            { slug: "case-scope-team", name: "Case Scope", source: "org", orgSlug: "org-team", members: ["OctoCat"], description: null },
            { slug: "case-scope-org", name: "Case Org", source: "org", orgSlug: "org-case", members: ["octocat"], description: null },
          ]);

          expect(resolveFilteredUserScopes(["case-scope-team"], ["org-case"], ["acme"])).toEqual([
            { enterpriseSlug: "acme", userLogin: "OctoCat" },
          ]);
        } finally {
          db.prepare("DELETE FROM team_memberships WHERE team_slug IN (?, ?)").run("case-scope-team", "case-scope-org");
        }
      });
    });
  });
});
