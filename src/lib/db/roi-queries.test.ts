/**
 * Integration coverage for the ROI aggregation queries.
 *
 * These run against a real in-memory SQLite database rather than a mock, because
 * the queries use multi-CTE SQL with positional parameters — a shape that unit
 * mocks cannot validate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;

vi.mock("./database", () => ({
  getDb: () => db,
}));

const {
  getPhaseDeveloperCounts,
  getPhaseCostFromBilling,
  getPhaseCostFromCredits,
  hasBillingCostData,
} = await import("./metrics-repo");

function insertUserDay(
  day: string,
  login: string,
  phase: number,
  credits: number,
  slug = "acme",
) {
  db.prepare(`
    INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, ai_credits_used, ai_adoption_phase)
    VALUES (?, 'ent1', ?, ?, ?, ?, ?)
  `).run(day, slug, login.length, login, credits, JSON.stringify({ phase, label: `Phase ${phase}`, version: "v1" }));
}

function insertBilling(date: string, username: string, amount: number, slug = "acme") {
  db.prepare(`
    INSERT INTO billing_premium_requests (enterprise_slug, date, product, sku, username, aic_gross_amount)
    VALUES (?, ?, 'copilot', 'copilot_ai_credit', ?, ?)
  `).run(slug, date, username, amount);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE user_daily_metrics (
      day TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      enterprise_slug TEXT NOT NULL DEFAULT '',
      user_id INTEGER NOT NULL,
      user_login TEXT NOT NULL,
      ai_credits_used REAL DEFAULT 0,
      ai_adoption_phase TEXT,
      PRIMARY KEY (day, enterprise_id, user_id)
    );
    CREATE TABLE billing_premium_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enterprise_slug TEXT NOT NULL DEFAULT '',
      date TEXT NOT NULL,
      product TEXT NOT NULL,
      sku TEXT NOT NULL,
      username TEXT DEFAULT '',
      aic_gross_amount REAL NOT NULL DEFAULT 0
    );
  `);
});

afterEach(() => {
  db.close();
});

describe("getPhaseDeveloperCounts", () => {
  it("counts a user once using their most recent phase", () => {
    // alice moved from phase 1 to phase 2 during the window.
    insertUserDay("2026-06-01", "alice", 1, 5);
    insertUserDay("2026-06-20", "alice", 2, 5);
    insertUserDay("2026-06-02", "bob", 1, 5);

    const rows = getPhaseDeveloperCounts("2026-06-01", "2026-06-28");

    expect(rows).toEqual([
      { phase: 1, developers: 1 },
      { phase: 2, developers: 1 },
    ]);
  });

  it("counts users active anywhere in the window, not just the last day", () => {
    // carol was only active early in the window — she must still be counted.
    insertUserDay("2026-06-01", "carol", 1, 1);
    insertUserDay("2026-06-28", "dave", 1, 1);

    const rows = getPhaseDeveloperCounts("2026-06-01", "2026-06-28");
    expect(rows).toEqual([{ phase: 1, developers: 2 }]);
  });

  it("excludes days outside the range and rows without a phase", () => {
    insertUserDay("2026-05-01", "old", 1, 1);
    db.prepare(`
      INSERT INTO user_daily_metrics (day, enterprise_id, enterprise_slug, user_id, user_login, ai_credits_used, ai_adoption_phase)
      VALUES ('2026-06-05', 'ent1', 'acme', 99, 'nophase', 3, NULL)
    `).run();
    insertUserDay("2026-06-05", "keep", 2, 1);

    expect(getPhaseDeveloperCounts("2026-06-01", "2026-06-28")).toEqual([
      { phase: 2, developers: 1 },
    ]);
  });

  it("applies the allowed-login and enterprise filters", () => {
    insertUserDay("2026-06-05", "alice", 1, 1, "acme");
    insertUserDay("2026-06-05", "bob", 1, 1, "other");

    expect(
      getPhaseDeveloperCounts("2026-06-01", "2026-06-28", { enterpriseSlugs: ["acme"] }),
    ).toEqual([{ phase: 1, developers: 1 }]);

    expect(
      getPhaseDeveloperCounts("2026-06-01", "2026-06-28", { allowedLogins: ["bob"] }),
    ).toEqual([{ phase: 1, developers: 1 }]);

    expect(
      getPhaseDeveloperCounts("2026-06-01", "2026-06-28", { allowedLogins: [] }),
    ).toEqual([]);
  });
});

describe("hasBillingCostData", () => {
  it("is false when no costed rows exist in range", () => {
    expect(hasBillingCostData("2026-06-01", "2026-06-28")).toBe(false);

    insertBilling("2026-06-05", "alice", 0);
    expect(hasBillingCostData("2026-06-01", "2026-06-28")).toBe(false);
  });

  it("is true once a costed row with a username exists", () => {
    insertBilling("2026-06-05", "alice", 12.5);
    expect(hasBillingCostData("2026-06-01", "2026-06-28")).toBe(true);
    expect(hasBillingCostData("2026-07-01", "2026-07-28")).toBe(false);
  });
});

describe("getPhaseCostFromBilling", () => {
  it("attributes billed spend to each phase, matching logins case-insensitively", () => {
    insertUserDay("2026-06-05", "Alice", 1, 0);
    insertUserDay("2026-06-05", "bob", 2, 0);
    insertBilling("2026-06-05", "alice", 10);
    insertBilling("2026-06-06", "ALICE", 5);
    insertBilling("2026-06-07", "bob", 40);

    const rows = getPhaseCostFromBilling("2026-06-01", "2026-06-28");

    expect(rows).toEqual([
      { phase: 1, developers: 1, total_cost_usd: 15 },
      { phase: 2, developers: 1, total_cost_usd: 40 },
    ]);
  });

  it("keeps developers with no billing rows at zero cost", () => {
    insertUserDay("2026-06-05", "alice", 1, 0);
    insertUserDay("2026-06-05", "bob", 1, 0);
    insertBilling("2026-06-05", "alice", 10);

    expect(getPhaseCostFromBilling("2026-06-01", "2026-06-28")).toEqual([
      { phase: 1, developers: 2, total_cost_usd: 10 },
    ]);
  });

  it("ignores billing rows outside the range", () => {
    insertUserDay("2026-06-05", "alice", 1, 0);
    insertBilling("2026-05-05", "alice", 999);
    insertBilling("2026-06-05", "alice", 10);

    expect(getPhaseCostFromBilling("2026-06-01", "2026-06-28")).toEqual([
      { phase: 1, developers: 1, total_cost_usd: 10 },
    ]);
  });
});

describe("getPhaseCostFromCredits", () => {
  it("converts summed credits to USD per phase", () => {
    insertUserDay("2026-06-05", "alice", 1, 100);
    insertUserDay("2026-06-06", "alice", 1, 200);
    insertUserDay("2026-06-05", "bob", 3, 500);

    const rows = getPhaseCostFromCredits("2026-06-01", "2026-06-28", 0.01);

    expect(rows).toEqual([
      { phase: 1, developers: 1, total_cost_usd: 3 },
      { phase: 3, developers: 1, total_cost_usd: 5 },
    ]);
  });

  it("attributes all of a user's credits to their latest phase", () => {
    // Credits earned while in phase 1 follow the user into phase 2.
    insertUserDay("2026-06-01", "alice", 1, 100);
    insertUserDay("2026-06-20", "alice", 2, 100);

    expect(getPhaseCostFromCredits("2026-06-01", "2026-06-28", 0.01)).toEqual([
      { phase: 2, developers: 1, total_cost_usd: 2 },
    ]);
  });

  it("respects the enterprise filter on both the phase and credit sides", () => {
    insertUserDay("2026-06-05", "alice", 1, 100, "acme");
    insertUserDay("2026-06-05", "bob", 1, 900, "other");

    expect(
      getPhaseCostFromCredits("2026-06-01", "2026-06-28", 0.01, { enterpriseSlugs: ["acme"] }),
    ).toEqual([{ phase: 1, developers: 1, total_cost_usd: 1 }]);
  });

  it("returns nothing when there is no phase data at all", () => {
    expect(getPhaseCostFromCredits("2026-06-01", "2026-06-28", 0.01)).toEqual([]);
  });
});
