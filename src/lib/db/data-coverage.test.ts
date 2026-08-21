import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "./sqlite-database";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import { getDataCoverage } from "./data-coverage";

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE user_daily_metrics (day TEXT, user_login TEXT)`);
  db.prepare(`INSERT INTO user_daily_metrics (day, user_login) VALUES (?, ?)`).run("2026-05-23", "a");
  db.prepare(`INSERT INTO user_daily_metrics (day, user_login) VALUES (?, ?)`).run("2026-08-19", "a");
});

afterAll(() => {
  db.close();
});

describe("getDataCoverage", () => {
  it("reports full coverage for a window inside the synced range", () => {
    const c = getDataCoverage("user_daily_metrics", "day", "2026-06-01", "2026-06-30");

    expect(c.earliest).toBe("2026-05-23");
    expect(c.latest).toBe("2026-08-19");
    expect(c.daysCovered).toBe(30);
    expect(c.daysRequested).toBe(30);
    expect(c.isEmpty).toBe(false);
    expect(c.isPartial).toBe(false);
  });

  it("flags a window that predates every synced day as empty", () => {
    // Without this the page renders a full set of confident zeros that are
    // indistinguishable from a month in which nobody used Copilot.
    const c = getDataCoverage("user_daily_metrics", "day", "2026-01-01", "2026-01-31");

    expect(c.isEmpty).toBe(true);
    expect(c.daysCovered).toBe(0);
  });

  it("flags a partially-synced window", () => {
    // May 2026 has only 9 synced days but is labelled a whole month, so its
    // totals are understated rather than low.
    const c = getDataCoverage("user_daily_metrics", "day", "2026-05-01", "2026-05-31");

    expect(c.isPartial).toBe(true);
    expect(c.daysCovered).toBe(9); // 23rd–31st
    expect(c.daysRequested).toBe(31);
  });

  it("flags a window running past the last synced day", () => {
    const c = getDataCoverage("user_daily_metrics", "day", "2026-08-01", "2026-08-31");

    expect(c.isPartial).toBe(true);
    expect(c.daysCovered).toBe(19); // 1st–19th
  });

  it("degrades to an empty result when the table does not exist", () => {
    // A database synced before a feature existed must not 500 the page.
    const c = getDataCoverage("no_such_table", "day", "2026-06-01", "2026-06-30");

    expect(c.isEmpty).toBe(true);
    expect(c.earliest).toBeNull();
    expect(c.daysRequested).toBe(30);
  });
});
