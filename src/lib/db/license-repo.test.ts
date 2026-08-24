import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

/**
 * Minimal better-sqlite3-compatible facade backed by Node's built-in
 * `node:sqlite` (`DatabaseSync`). Used here — instead of `better-sqlite3`
 * directly — because that package's native binding cannot be located/loaded
 * under this environment's Node version, which otherwise makes every test in
 * this file skip before any assertion runs. This is a real, in-process
 * SQLite engine exercising the production repo's real SQL/params, not a
 * mock of query results: `license-repo.ts` is never modified, and this
 * facade only translates the handful of better-sqlite3 API shapes
 * (`pragma`, `.transaction`, positional/named `?`/`@param` binding) that
 * `node:sqlite` spells slightly differently.
 */
class TestDb {
  private readonly raw: DatabaseSync;
  constructor(location: string) {
    this.raw = new DatabaseSync(location);
  }
  pragma(clause: string): void {
    this.raw.exec(`PRAGMA ${clause};`);
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string) {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...(params as never[])),
      get: (...params: unknown[]) => stmt.get(...(params as never[])),
      all: (...params: unknown[]) => stmt.all(...(params as never[])),
    };
  }
  transaction<Args extends unknown[]>(fn: (...args: Args) => void): (...args: Args) => void {
    return (...args: Args) => {
      this.raw.exec("BEGIN");
      try {
        fn(...args);
        this.raw.exec("COMMIT");
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    };
  }
  close(): void {
    this.raw.close();
  }
}

let db: TestDb;

vi.mock("./database", () => ({
  getDb: () => db,
}));

// Deterministic licensing config independent of dashboard-config.json.
vi.mock("@/lib/config/dashboard-config", () => ({
  getLicensingConfig: () => ({
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 1900, enterprise: 3900, unknown: 0 },
    perUserBudgetUsd: { budgetuser: 50 },
  }),
}));

import {
  getLicenseReconciliationRows,
  getLicenseReconciliationDataset,
  computeLicenseKPIs,
  computePlanBreakdown,
  computeOrgBreakdown,
  computeUtilizationBuckets,
  sortLicenseRows,
  normalizePlan,
} from "./license-repo";

function insertSeat(overrides: Record<string, unknown> = {}) {
  const userLogin = String(overrides.user_login ?? "dev1");
  const userId = [...userLogin.toLowerCase()].reduce(
    (hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  const seat = {
    enterprise_slug: "ent1",
    org_slug: "org1",
    user_login: userLogin,
    user_id: userId,
    plan_type: "business",
    last_activity_at: new Date().toISOString(),
    last_activity_editor: "vscode",
    last_authenticated_at: null,
    assigning_team_slug: null,
    assigning_team_name: null,
    pending_cancellation_date: null,
    created_at: "2026-01-15T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    avatar_url: null,
    ...overrides,
  };
  db.prepare(
    `INSERT OR REPLACE INTO copilot_seats
     (enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at, last_activity_editor,
      last_authenticated_at, assigning_team_slug, assigning_team_name, pending_cancellation_date,
      created_at, updated_at, avatar_url)
     VALUES (@enterprise_slug, @org_slug, @user_login, @user_id, @plan_type, @last_activity_at, @last_activity_editor,
      @last_authenticated_at, @assigning_team_slug, @assigning_team_name, @pending_cancellation_date,
      @created_at, @updated_at, @avatar_url)`,
  ).run(seat);
}

function insertConsumption(
  username: string,
  credits: number,
  usd: number,
  date = "2026-06-10",
  ent = "ent1",
  overrides: { unit_type?: string; aic_quantity?: number } = {},
) {
  const unitType = overrides.unit_type ?? "ai-credits";
  const aicQuantity = overrides.aic_quantity ?? credits;
  db.prepare(
    `INSERT INTO billing_premium_requests
     (enterprise_slug, date, product, sku, quantity, unit_type, applied_cost_per_quantity,
      gross_amount, discount_amount, net_amount, username, organization, model, exceeds_quota,
      total_monthly_quota, charge_scope, input_tokens, output_tokens, cached_tokens,
      cost_center_name, aic_quantity, aic_gross_amount)
     VALUES (?, ?, 'copilot', 'aic', ?, ?, 0, ?, 0, ?, ?, 'org1', 'gpt-4', '',
      0, 'user', 0, 0, 0, '', ?, ?)`,
  ).run(ent, date, credits, unitType, usd, usd, username, aicQuantity, usd);
}

const WINDOW = { start: "2026-06-01", end: "2026-06-30" };

beforeAll(() => {
  db = new TestDb(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "schema.sql"), "utf-8"));
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "billing-schema.sql"), "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM copilot_seats");
  db.exec("DELETE FROM billing_premium_requests");
});

describe("normalizePlan", () => {
  it("normalizes plan aliases", () => {
    expect(normalizePlan("copilot_business")).toBe("business");
    expect(normalizePlan("Enterprise")).toBe("enterprise");
    expect(normalizePlan(null)).toBe("unknown");
    expect(normalizePlan("")).toBe("unknown");
  });
});

describe("getLicenseReconciliationRows", () => {
  it("joins seats with AI-credit consumption and applies config pricing", () => {
    insertSeat({ user_login: "dev1", plan_type: "business" });
    insertConsumption("dev1", 950, 15.2);

    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.user_login).toBe("dev1");
    expect(r.plan_type).toBe("business");
    expect(r.license_cost).toBe(19);
    expect(r.default_aic_credits).toBe(1900);
    expect(r.default_aic_usd).toBe(19);
    expect(r.aic_consumed_credits).toBe(950);
    expect(r.aic_consumed_usd).toBe(15.2);
    expect(r.utilization_pct).toBe(50); // 950 / 1900
    expect(r.total_cost).toBe(34.2); // 19 + 15.2
    expect(r.license_assigned_date).toBe("2026-01-15");
  });

  it("returns zero consumption when a seat has no AI-credit rows", () => {
    insertSeat({ user_login: "idle" });
    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows[0].aic_consumed_credits).toBe(0);
    expect(rows[0].utilization_pct).toBe(0);
  });

  it("aggregates a multi-org user into one row with combined license cost", () => {
    insertSeat({ user_login: "multi", org_slug: "org1", plan_type: "business" });
    insertSeat({ user_login: "multi", org_slug: "org2", plan_type: "enterprise" });
    insertConsumption("multi", 100, 1.6);

    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.seat_count).toBe(2);
    expect(r.org_count).toBe(2);
    expect(r.plan_type).toBe("enterprise"); // highest plan wins
    expect(r.license_cost).toBe(58); // 19 + 39
    expect(r.org_license_costs).toEqual({ org1: 19, org2: 39 });
    expect(r.org_seat_counts).toEqual({ org1: 1, org2: 1 });
  });

  it("merges casing variants for the same user before applying the login allowlist", () => {
    insertSeat({ user_login: "CaseUser", user_id: 42, org_slug: "org1" });
    insertSeat({ user_login: "caseuser", user_id: 42, org_slug: "org2" });
    insertConsumption("caseuser", 100, 1);

    const rows = getLicenseReconciliationRows({
      ...WINDOW,
      filters: { allowedLogins: new Set(["CASEUSER"]) },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].user_login).toBe("CaseUser");
    expect(rows[0].seat_count).toBe(2);
    expect(rows[0].aic_consumed_credits).toBe(100);
    expect(computeLicenseKPIs(rows).totalConsumedCredits).toBe(100);
  });

  it("marks pending cancellation seats inactive with a revoked date", () => {
    insertSeat({ user_login: "leaving", pending_cancellation_date: "2026-07-01T00:00:00Z" });
    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows[0].user_status).toBe("inactive");
    expect(rows[0].seat_status).toBe("pending_cancellation");
    expect(rows[0].user_revoked_date).toBe("2026-07-01");
  });

  it("keeps multi-seat users active while surfacing any pending cancellation", () => {
    insertSeat({ user_login: "mixed", org_slug: "org1", pending_cancellation_date: null });
    insertSeat({
      user_login: "mixed",
      org_slug: "org2",
      pending_cancellation_date: "2026-07-03T00:00:00Z",
    });

    const row = getLicenseReconciliationRows(WINDOW)[0];
    expect(row.user_status).toBe("active");
    expect(row.seat_status).toBe("pending_cancellation");
    expect(row.user_revoked_date).toBe("2026-07-03");
  });

  it("flags over-budget users using the case-insensitive per-user budget override", () => {
    insertSeat({ user_login: "BudgetUser", plan_type: "business" });
    insertConsumption("BudgetUser", 8000, 80);
    const r = getLicenseReconciliationRows(WINDOW)[0];
    expect(r.aic_assigned_rule).toBe("per_user_budget");
    expect(r.aic_assigned_usd).toBe(50);
    expect(r.over_budget).toBe(true);
  });

  it("derives assigned_via from team attribution", () => {
    insertSeat({ user_login: "teamed", assigning_team_slug: "core", assigning_team_name: "Core" });
    const r = getLicenseReconciliationRows(WINDOW)[0];
    expect(r.assigned_via).toBe("team");
  });

  it("filters by allowedLogins", () => {
    insertSeat({ user_login: "A" });
    insertSeat({ user_login: "b" });
    const rows = getLicenseReconciliationRows({ ...WINDOW, filters: { allowedLogins: new Set(["a"]) } });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_login).toBe("A");
  });

  it("filters by allowedLogins with multiple allowed logins", () => {
    insertSeat({ user_login: "a" });
    insertSeat({ user_login: "b" });
    insertSeat({ user_login: "c" });
    const rows = getLicenseReconciliationRows({ ...WINDOW, filters: { allowedLogins: new Set(["a", "b"]) } });
    expect(rows.map((r) => r.user_login).sort()).toEqual(["a", "b"]);
  });

  it("fails closed to zero rows for an EMPTY allowedLogins Set — never unrestricted", () => {
    insertSeat({ user_login: "a" });
    insertSeat({ user_login: "b" });
    const rows = getLicenseReconciliationRows({ ...WINDOW, filters: { allowedLogins: new Set() } });
    expect(rows).toEqual([]);
  });

  it("filters by search on login or org", () => {
    insertSeat({ user_login: "alpha", org_slug: "orgX" });
    insertSeat({ user_login: "beta", org_slug: "orgY" });
    expect(getLicenseReconciliationRows({ ...WINDOW, filters: { search: "alph" } })).toHaveLength(1);
    expect(getLicenseReconciliationRows({ ...WINDOW, filters: { search: "orgy" } })).toHaveLength(1);
  });

  it("does not count premium requests as AI credits — a request is not a credit", () => {
    // GitHub's usage report carries a `unit_type` per row precisely so credits,
    // requests and token units are aggregated separately. The shared cost basis
    // reports a pre-June-2026 window under `requestsBilled`, so counting those
    // rows as credits here would contradict the strip on the same page.
    insertSeat({ user_login: "dev1" });
    insertConsumption("dev1", 500, 8, "2026-05-15", "ent1", { unit_type: "requests", aic_quantity: 0 });
    const r = getLicenseReconciliationRows({ start: "2026-05-01", end: "2026-06-30" })[0];
    expect(r.aic_consumed_credits).toBe(0);
  });

  it("counts each seat individually when a user holds both an active and a cancelling seat", () => {
    // `seat_status` is aggregated per user, so it reports
    // "pending_cancellation" for this user. Deriving active seats from it would
    // count zero active seats even though one seat is plainly active.
    insertSeat({ user_login: "dev1", org_slug: "org1" });
    insertSeat({ user_login: "dev1", org_slug: "org2", pending_cancellation_date: "2026-07-31" });

    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].seat_count).toBe(2);
    expect(rows[0].active_seat_count).toBe(1);

    const kpis = computeLicenseKPIs(rows);
    expect(kpis.totalSeats).toBe(2);
    expect(kpis.activeSeats).toBe(1);
  });

  it("reports consumption that matches no seat as an unmatched residual instead of dropping it", () => {
    insertSeat({ user_login: "dev1" });
    insertConsumption("dev1", 100, 1);
    insertConsumption("ex-employee", 400, 4);

    const { rows, coverage } = getLicenseReconciliationDataset(WINDOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].aic_consumed_credits).toBe(100);
    expect(coverage.attributedCredits).toBe(500);
    expect(coverage.matchedCredits).toBe(100);
    expect(coverage.unmatchedCredits).toBe(400);
    expect(coverage.unmatchedUsers).toBe(1);
    // The residual exists precisely so rows + residual reconciles with the
    // attributed total on the cost-basis strip.
    expect(coverage.matchedCredits + coverage.unmatchedCredits).toBe(coverage.attributedCredits);
  });
});

describe("computeLicenseKPIs", () => {
  it("marks output as live_snapshot_only (this is the legacy live-query path, not materialized history)", () => {
    insertSeat({ user_login: "dev1", plan_type: "business" });
    const kpis = computeLicenseKPIs(getLicenseReconciliationRows(WINDOW));
    expect(kpis.dataSource).toBe("live_snapshot_only");
  });

  it("aggregates totals and utilization", () => {
    insertSeat({ user_login: "dev1", plan_type: "business" });
    insertSeat({ user_login: "dev2", plan_type: "enterprise" });
    insertConsumption("dev1", 950, 15.2);
    insertConsumption("dev2", 3900, 62.4);

    const rows = getLicenseReconciliationRows(WINDOW);
    const kpis = computeLicenseKPIs(rows);
    expect(kpis.totalUsers).toBe(2);
    expect(kpis.totalLicenseCost).toBe(58); // 19 + 39
    expect(kpis.totalAllowanceCredits).toBe(5800); // 1900 + 3900
    expect(kpis.totalConsumedCredits).toBe(4850); // 950 + 3900
    expect(kpis.overallUtilizationPct).toBe(83.62); // 4850/5800
    expect(kpis.totalCostOfOwnership).toBe(135.6); // 58 + 77.6
  });

  it("counts zero-consumption seats", () => {
    insertSeat({ user_login: "idle", org_slug: "org1" });
    insertSeat({ user_login: "idle", org_slug: "org2" });
    const kpis = computeLicenseKPIs(getLicenseReconciliationRows(WINDOW));
    expect(kpis.zeroConsumptionSeats).toBe(2);
  });
});

describe("breakdowns", () => {
  it("groups by plan", () => {
    insertSeat({ user_login: "a", org_slug: "org1", plan_type: "business" });
    insertSeat({ user_login: "a", org_slug: "org2", plan_type: "business" });
    insertSeat({ user_login: "b", plan_type: "enterprise" });
    insertConsumption("a", 100, 1.6);
    const plans = computePlanBreakdown(getLicenseReconciliationRows(WINDOW));
    expect(plans.map((p) => p.key).sort()).toEqual(["business", "enterprise"]);
    expect(plans.find((p) => p.key === "business")!.seats).toBe(2);
  });

  it("groups by org", () => {
    insertSeat({ user_login: "a", org_slug: "org1" });
    insertSeat({ user_login: "b", org_slug: "org2" });
    const orgs = computeOrgBreakdown(getLicenseReconciliationRows(WINDOW));
    expect(orgs.map((o) => o.key).sort()).toEqual(["org1", "org2"]);
  });

  it("uses seat-level org license costs and first-org allowance attribution", () => {
    insertSeat({ user_login: "multi", org_slug: "orgA", plan_type: "business" });
    insertSeat({ user_login: "multi", org_slug: "orgB", plan_type: "enterprise" });
    insertConsumption("multi", 100, 1.6);

    const orgs = computeOrgBreakdown(getLicenseReconciliationRows(WINDOW));
    const orgA = orgs.find((o) => o.key === "orgA")!;
    const orgB = orgs.find((o) => o.key === "orgB")!;

    expect(orgA.licenseCost).toBe(19);
    expect(orgB.licenseCost).toBe(39);
    expect(orgA.allowanceCredits).toBe(3900);
    expect(orgB.allowanceCredits).toBe(0);
    expect(orgA.consumedCredits).toBe(100);
    expect(orgB.consumedCredits).toBe(0);
  });

  it("counts all seats in the same org across enterprises", () => {
    insertSeat({ enterprise_slug: "ent1", user_login: "multi", org_slug: "shared", plan_type: "business" });
    insertSeat({ enterprise_slug: "ent2", user_login: "multi", org_slug: "shared", plan_type: "business" });

    const row = getLicenseReconciliationRows(WINDOW)[0];
    expect(row.seat_count).toBe(2);
    expect(row.org_seat_counts).toEqual({ shared: 2 });

    const org = computeOrgBreakdown([row]).find((o) => o.key === "shared")!;
    expect(org.seats).toBe(2);
  });

  it("buckets utilization", () => {
    insertSeat({ user_login: "zero" });
    insertSeat({ user_login: "half", plan_type: "business" });
    insertConsumption("half", 950, 15.2); // 50%
    const buckets = computeUtilizationBuckets(getLicenseReconciliationRows(WINDOW));
    expect(buckets.find((b) => b.label === "0%")!.count).toBe(1);
    expect(buckets.find((b) => b.label === "26–50%")!.count).toBe(1);
  });
});

describe("sortLicenseRows", () => {
  it("sorts by numeric field descending", () => {
    insertSeat({ user_login: "a", plan_type: "business" });
    insertSeat({ user_login: "b", plan_type: "enterprise" });
    const rows = getLicenseReconciliationRows(WINDOW);
    const sorted = sortLicenseRows(rows, "license_cost", "desc");
    expect(sorted[0].license_cost).toBeGreaterThanOrEqual(sorted[1].license_cost);
  });

  it("sorts by login ascending", () => {
    insertSeat({ user_login: "zed" });
    insertSeat({ user_login: "abe" });
    const sorted = sortLicenseRows(getLicenseReconciliationRows(WINDOW), "user_login", "asc");
    expect(sorted[0].user_login).toBe("abe");
  });
});

describe("empty state", () => {
  it("returns empty results when no seats exist", () => {
    const rows = getLicenseReconciliationRows(WINDOW);
    expect(rows).toEqual([]);
    const kpis = computeLicenseKPIs(rows);
    expect(kpis.totalUsers).toBe(0);
    expect(kpis.overallUtilizationPct).toBe(0);
  });
});
