import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import { upsertEnterpriseOrgs, getEnterpriseOrgs, clearEnterpriseOrgs } from "./orgs-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

describe("orgs-repo", () => {
  describe("upsertEnterpriseOrgs", () => {
    it("inserts org rows for an enterprise", () => {
      upsertEnterpriseOrgs("ent-a", ["org-1", "org-2", "org-3"], "discovered");
      const rows = db
        .prepare("SELECT org_slug, source FROM enterprise_orgs WHERE enterprise_slug = ? ORDER BY org_slug")
        .all("ent-a") as { org_slug: string; source: string }[];
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.org_slug)).toEqual(["org-1", "org-2", "org-3"]);
      expect(rows[0].source).toBe("discovered");
    });

    it("updates source on conflict", () => {
      upsertEnterpriseOrgs("ent-a", ["org-1"], "configured");
      const row = db
        .prepare("SELECT source FROM enterprise_orgs WHERE enterprise_slug = ? AND org_slug = ?")
        .get("ent-a", "org-1") as { source: string };
      expect(row.source).toBe("configured");
    });

    it("handles empty org list without error", () => {
      expect(() => upsertEnterpriseOrgs("ent-empty", [], "discovered")).not.toThrow();
      const rows = getEnterpriseOrgs("ent-empty");
      expect(rows).toEqual([]);
    });
  });

  describe("getEnterpriseOrgs", () => {
    it("returns cached orgs in alphabetical order", () => {
      upsertEnterpriseOrgs("ent-b", ["zulu", "alpha", "mike"], "discovered");
      const result = getEnterpriseOrgs("ent-b");
      expect(result).toEqual(["alpha", "mike", "zulu"]);
    });

    it("returns empty array for unknown enterprise", () => {
      const result = getEnterpriseOrgs("no-such-ent");
      expect(result).toEqual([]);
    });
  });

  describe("clearEnterpriseOrgs", () => {
    it("deletes all orgs for an enterprise when no source filter", () => {
      upsertEnterpriseOrgs("ent-c", ["org-x", "org-y"], "discovered");
      upsertEnterpriseOrgs("ent-c", ["org-z"], "configured");
      clearEnterpriseOrgs("ent-c");
      expect(getEnterpriseOrgs("ent-c")).toEqual([]);
    });

    it("deletes only orgs matching source filter", () => {
      upsertEnterpriseOrgs("ent-d", ["org-disc"], "discovered");
      upsertEnterpriseOrgs("ent-d", ["org-conf"], "configured");
      clearEnterpriseOrgs("ent-d", "discovered");
      const remaining = getEnterpriseOrgs("ent-d");
      expect(remaining).toEqual(["org-conf"]);
    });

    it("does not affect other enterprises", () => {
      upsertEnterpriseOrgs("ent-e", ["org-e1"], "discovered");
      upsertEnterpriseOrgs("ent-f", ["org-f1"], "discovered");
      clearEnterpriseOrgs("ent-e");
      expect(getEnterpriseOrgs("ent-f")).toEqual(["org-f1"]);
    });
  });
});
