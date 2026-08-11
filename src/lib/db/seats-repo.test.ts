import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

// Mock getDb to return our in-memory database
vi.mock("./database", () => ({
  getDb: () => db,
}));

import { getAllSeats, getSeatStats, getSeatsByOrg, getSeatsPaginated, replaceEnterpriseSeats, upsertSeat, upsertSeats } from "./seats-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));

  // Insert test data
  upsertSeats("acme", "org-a", [
    makeSeat("alice", 1, "active_user", "2024-06-10T12:00:00Z", "vscode"),
    makeSeat("bob", 2, "active_user", "2024-05-01T12:00:00Z", "jetbrains"),
    makeSeat("charlie", 3, "pending_cancellation", null, null),
  ]);
  upsertSeats("acme", "org-b", [
    makeSeat("dave", 4, "active_user", "2024-06-15T12:00:00Z", "vscode"),
  ]);
});

afterAll(() => {
  db.close();
});

describe("seats-repo", () => {
  describe("upsertSeat", () => {
    it("inserts a new seat", () => {
      upsertSeat("beta", "org-x", makeSeat("eve", 5, "active_user", "2024-06-12T00:00:00Z", "xcode"));
      const row = db.prepare("SELECT * FROM copilot_seats WHERE user_login = ?").get("eve") as { user_login: string };
      expect(row.user_login).toBe("eve");
    });

    it("updates on conflict (same enterprise+user)", () => {
      upsertSeat("beta", "org-x", makeSeat("eve", 5, "inactive_user", "2024-06-14T00:00:00Z", "neovim"));
      const row = db.prepare("SELECT plan_type, last_activity_editor FROM copilot_seats WHERE user_login = ?").get("eve") as { plan_type: string; last_activity_editor: string };
      expect(row.plan_type).toBe("inactive_user");
      expect(row.last_activity_editor).toBe("neovim");
    });
  });

  describe("getAllSeats", () => {
    it("returns all seats across all enterprises", () => {
      const seats = getAllSeats();
      expect(seats.length).toBeGreaterThanOrEqual(4);
    });

    it("filters by enterprise slug", () => {
      const seats = getAllSeats(["acme"]);
      expect(seats.every((s) => s.org_slug === "org-a" || s.org_slug === "org-b")).toBe(true);
    });
  });

  describe("getSeatsByOrg", () => {
    it("returns seats for a specific org", () => {
      const seats = getSeatsByOrg("org-a");
      expect(seats.length).toBe(3);
      expect(seats.map((s) => s.user_login)).toContain("alice");
    });
  });

  describe("getSeatsPaginated", () => {
    it("returns paginated results", () => {
      const result = getSeatsPaginated(1, 2, "user_login", "asc", undefined, ["acme"]);
      expect(result.seats.length).toBe(2);
      expect(result.total).toBe(4);
    });

    it("respects allowedLogins filter", () => {
      const allowed = new Set(["alice", "bob"]);
      const result = getSeatsPaginated(1, 50, "user_login", "asc", allowed, ["acme"]);
      expect(result.total).toBe(2);
      expect(result.seats.map((s) => s.user_login).sort()).toEqual(["alice", "bob"]);
    });

    it("handles page offset", () => {
      const result = getSeatsPaginated(2, 2, "user_login", "asc", undefined, ["acme"]);
      expect(result.seats.length).toBe(2);
    });

    it("defaults to last_activity_at when sortField is invalid", () => {
      const result = getSeatsPaginated(1, 10, "invalid_field" as any, "desc", undefined, ["acme"]);
      expect(result.seats.length).toBeGreaterThan(0);
    });
  });

  describe("getSeatStats", () => {
    it("returns total and active counts", () => {
      const stats = getSeatStats(["acme"]);
      expect(stats.total).toBe(4);
      expect(stats.active30d + stats.inactive30d).toBe(stats.total);
    });
  });

  describe("replaceEnterpriseSeats", () => {
    it("refreshes an enterprise seat snapshot and removes stale rows", () => {
      upsertSeats("snapshot-ent", "org-old", [
        makeSeat("zoe", 90, "active_user", "2024-06-01T00:00:00Z", "vscode"),
      ]);

      const inserted = replaceEnterpriseSeats(
        "snapshot-ent",
        new Map([
          ["org-new", [
            makeSeat("zoe", 90, "active_user", "2024-06-20T00:00:00Z", "vscode"),
            makeSeat("yan", 91, "active_user", "2024-06-21T00:00:00Z", "vscode"),
          ]],
        ]),
      );

      expect(inserted).toBe(2);
      expect(getSeatsByOrg("org-old", ["snapshot-ent"])).toEqual([]);
      expect(getSeatsByOrg("org-new", ["snapshot-ent"]).map((seat) => seat.user_login).sort()).toEqual(["yan", "zoe"]);
    });
  });
});

// ── Helper ────────────────────────────────────────────────────────────

function makeSeat(login: string, id: number, planType: string, lastActivity: string | null, editor: string | null) {
  return {
    assignee: { login, id, avatar_url: `https://github.com/${login}.png` },
    plan_type: planType,
    last_activity_at: lastActivity,
    last_activity_editor: editor,
    last_authenticated_at: "2024-06-01T00:00:00Z",
    assigning_team: null,
    pending_cancellation_date: planType === "pending_cancellation" ? "2024-07-01" : null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-06-15T00:00:00Z",
  };
}

describe("null assignee handling", () => {
  it("upsertSeat skips seat with null assignee", () => {
    const before = getAllSeats();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsertSeat("acme", "org-a", { assignee: null } as any);
    expect(getAllSeats().length).toBe(before.length);
  });

  it("upsertSeats skips seats with missing assignee login", () => {
    const before = getAllSeats();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsertSeats("acme", "org-a", [{ assignee: { id: 99 } } as any]);
    expect(getAllSeats().length).toBe(before.length);
  });
});
