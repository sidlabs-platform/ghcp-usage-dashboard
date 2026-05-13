import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

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
  });
});
