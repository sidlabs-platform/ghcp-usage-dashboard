import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  batchUpsertUserTeams,
  getCopilotTeams,
  getCopilotTeamMembers,
  getCopilotTeamsByUser,
} from "./user-teams-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));

  batchUpsertUserTeams("acme", "2025-01-01", [
    { day: "2025-01-01", organization_id: "org-a", team_slug: "frontend", user_id: 1, user_login: "alice" },
    { day: "2025-01-01", organization_id: "org-a", team_slug: "frontend", user_id: 2, user_login: "bob" },
    { day: "2025-01-01", organization_id: "org-a", team_slug: "backend", user_id: 2, user_login: "bob" },
    { day: "2025-01-01", organization_id: "org-b", team_slug: "ops", user_id: 3, user_login: "carol" },
  ]);

  batchUpsertUserTeams("globex", "2025-01-01", [
    { day: "2025-01-01", organization_id: "org-g", team_slug: "frontend", user_id: 4, user_login: "dave" },
  ]);

  batchUpsertUserTeams("acme", "2025-01-02", [
    { day: "2025-01-02", organization_id: "org-a", team_slug: "frontend", user_id: 1, user_login: "alice" },
    { day: "2025-01-02", organization_id: "org-a", team_slug: "frontend", user_id: 5, user_login: "erin" },
  ]);
});

afterAll(() => {
  db.close();
});

describe("user-teams-repo", () => {
  it("batchUpsertUserTeams stores records that can be queried back", () => {
    const members = getCopilotTeamMembers("frontend", "2025-01-01", "2025-01-02", ["acme"]);
    expect(members).toEqual(["alice", "bob", "erin"]);
  });

  it("getCopilotTeams returns correct team counts", () => {
    const teams = getCopilotTeams("2025-01-01", "2025-01-02", ["acme"]);
    expect(teams).toEqual([
      { team_slug: "backend", enterprise_slug: "acme", org_slug: "org-a", member_count: 1 },
      { team_slug: "frontend", enterprise_slug: "acme", org_slug: "org-a", member_count: 3 },
      { team_slug: "ops", enterprise_slug: "acme", org_slug: "org-b", member_count: 1 },
    ]);
  });

  it("getCopilotTeamMembers returns distinct logins for a team", () => {
    const members = getCopilotTeamMembers("frontend", "2025-01-01", "2025-01-02", ["acme"]);
    expect(members).toEqual(["alice", "bob", "erin"]);
  });

  it("getCopilotTeamsByUser returns teams for a user", () => {
    const teams = getCopilotTeamsByUser("bob", "2025-01-01", "2025-01-02", ["acme"]);
    expect(teams).toEqual([{ team_slug: "backend" }, { team_slug: "frontend" }]);
  });

  it("filters results by enterprise slug", () => {
    const teams = getCopilotTeams("2025-01-01", "2025-01-02", ["globex"]);
    expect(teams).toEqual([
      { team_slug: "frontend", enterprise_slug: "globex", org_slug: "org-g", member_count: 1 },
    ]);
  });
});
