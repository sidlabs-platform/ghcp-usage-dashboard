import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  countActiveUsersWithoutSeat,
  getSeatStats,
  getSeatStatsForWindow,
  upsertSeats,
} from "./seats-repo";
import type { CopilotSeat } from "@/lib/types/seats";

/**
 * A seat's `last_activity_at` is the latest-ever activity for that seat, and the
 * whole `copilot_seats` table is replaced on every sync. These fixtures encode
 * the situation that produced the original bug: everybody who is still active
 * carries a recent stamp, so a query for an older month finds almost nobody.
 */
function makeSeat(login: string, id: number, lastActivity: string | null): CopilotSeat {
  return {
    assignee: { login, id, avatar_url: null },
    plan_type: "business",
    last_activity_at: lastActivity,
    last_activity_editor: lastActivity ? "vscode" : null,
    last_authenticated_at: lastActivity,
    assigning_team: null,
    pending_cancellation_date: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
  } as unknown as CopilotSeat;
}

let userIdSeq = 100;
function addUsage(login: string, day: string, enterprise = "acme") {
  db.prepare(
    `INSERT OR REPLACE INTO user_daily_metrics (day, user_login, user_id, enterprise_id, enterprise_slug)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(day, login, `u-${login}-${userIdSeq++}`, 1, enterprise);
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "schema.sql"), "utf-8"));

  // alice and bob are still active today; their seats carry an August stamp
  // even though both also worked through June.
  upsertSeats("acme", "org-a", [
    makeSeat("alice", 1, "2026-08-20T12:00:00Z"),
    makeSeat("bob", 2, "2026-08-19T12:00:00Z"),
    makeSeat("carol", 3, "2026-06-10T12:00:00Z"),
    makeSeat("dan", 4, null),
  ]);
  // The same person can hold a seat in more than one org.
  upsertSeats("acme", "org-b", [makeSeat("alice", 1, "2026-08-20T12:00:00Z")]);

  addUsage("alice", "2026-06-05");
  addUsage("bob", "2026-06-11");
  addUsage("carol", "2026-06-10");
  addUsage("alice", "2026-08-19");
  // Usage from someone who holds no seat at all.
  addUsage("erin", "2026-06-12");
});

afterAll(() => {
  db.close();
});

describe("getSeatStats", () => {
  it("counts distinct people, not seat rows", () => {
    // alice holds two seats (org-a and org-b) but is one licensed person.
    // Counting rows inflated the total and every ratio derived from it.
    expect(getSeatStats().total).toBe(4);
  });
});

describe("getSeatStatsForWindow", () => {
  it("derives the active split from usage for a historical window", () => {
    const stats = getSeatStatsForWindow("2026-06-01", "2026-06-30", false);

    // alice, bob and carol all used Copilot in June. dan did not.
    expect(stats.active30d).toBe(3);
    expect(stats.inactive30d).toBe(1);
    expect(stats.total).toBe(4);
    expect(stats.activityBasis).toBe("usage");
  });

  it("does not mark a seat inactive merely because its snapshot stamp is newer", () => {
    // This is the original bug: alice and bob were active in June, but their
    // last_activity_at is in August, so a last_activity_at BETWEEN query put
    // them outside the window and counted them as inactive.
    const usageBased = getSeatStatsForWindow("2026-06-01", "2026-06-30", false);
    const stampBased = getSeatStats(
      undefined,
      "2026-06-01T00:00:00.000Z",
      "2026-06-30T23:59:59.999Z",
    );

    expect(stampBased.active30d).toBe(1); // only carol's stamp falls in June
    expect(usageBased.active30d).toBeGreaterThan(stampBased.active30d);
    expect(usageBased.inactive30d).toBeLessThan(usageBased.total);
  });

  it("keeps active + inactive equal to the total", () => {
    const stats = getSeatStatsForWindow("2026-06-01", "2026-06-30", false);
    expect(stats.active30d + stats.inactive30d).toBe(stats.total);
  });

  it("uses the live snapshot for a current window", () => {
    const stats = getSeatStatsForWindow("2026-08-01", "2026-08-21", true, undefined, "2026-08-01T00:00:00.000Z", null);
    expect(stats.activityBasis).toBe("last_activity");
    expect(stats.active30d).toBe(2); // alice and bob
  });
});

describe("countActiveUsersWithoutSeat", () => {
  it("counts users with usage who hold no seat", () => {
    expect(countActiveUsersWithoutSeat("2026-06-01", "2026-06-30")).toBe(1); // erin
  });

  it("returns zero when every active user holds a seat", () => {
    expect(countActiveUsersWithoutSeat("2026-08-01", "2026-08-31")).toBe(0);
  });
});
