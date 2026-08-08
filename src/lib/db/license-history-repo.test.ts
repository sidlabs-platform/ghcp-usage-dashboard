import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  upsertAuditEvents,
  replacePeriodSnapshots,
  upsertIdentityRecords,
  upsertOrgBillingSnapshots,
  upsertAicConsumption,
  replaceMaterializedPeriod,
  queryLicensePeriodRows,
  getMaterializedPeriodKPIs,
  getMaterializedPlanBreakdown,
  getMaterializedOrgBreakdown,
  hasMaterializedRows,
  stableStringify,
  parseJsonArray,
  parseJsonObject,
  DETAIL_SORT_COLUMNS,
  ROLLUP_SORT_COLUMNS,
  UNATTRIBUTED_ORG,
  buildDetailOrderBy,
  buildRollupOrderBy,
  type LicensePeriodRowInput,
} from "./license-history-repo";

const SCHEMA_DIR = path.join(process.cwd(), "src", "lib", "db");

function execSchema(database: Database.Database, file: string): void {
  database.exec(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8"));
}

function makePeriodRow(overrides: Partial<LicensePeriodRowInput> = {}): LicensePeriodRowInput {
  return {
    orgLogin: "org1",
    holderKey: "user1",
    githubUserId: 1,
    userLogin: "user1",
    resolvedUserLogin: "user1",
    externalIdentity: null,
    identityResolutionSource: "live_seat",
    accountState: "active",
    licenseAssignedDate: "2026-01-01",
    userRevokedDate: null,
    planType: "business",
    seatStatus: "active",
    assignedVia: "direct",
    lastActivityAt: "2026-01-15T00:00:00Z",
    licenseCost: 19,
    defaultAicCredits: 300,
    defaultAicUsd: 19,
    aicAssignedUsd: 19,
    aicAssignedRule: "plan_default",
    aicConsumedCredits: 100,
    aicConsumedUsd: 6.33,
    currency: "USD",
    rowSource: "materialized",
    consumptionSource: "billing_report",
    historyConfidence: "high",
    dataQualityNotes: [],
    asOfUtc: "2026-01-31T23:59:59Z",
    generatedAtUtc: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Simulate a pre-existing database: main schema + billing schema first,
  // seeded with legacy data, THEN the new licensing schema (mirrors
  // database.ts's real init order and the upgrade path for an existing DB).
  execSchema(db, "schema.sql");
  execSchema(db, "billing-schema.sql");

  db.prepare(`
    INSERT INTO copilot_seats (
      enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at,
      last_activity_editor, last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES ('ent1', 'org1', 'legacyuser', 42, 'business', '2026-01-15T00:00:00Z', 'vscode', NULL, NULL, NULL, NULL, '2025-01-01T00:00:00Z', '2026-01-15T00:00:00Z', NULL)
  `).run();

  db.prepare(`
    INSERT INTO billing_premium_requests (
      enterprise_slug, date, product, sku, quantity, unit_type, applied_cost_per_quantity,
      gross_amount, discount_amount, net_amount, username, organization, model, exceeds_quota,
      total_monthly_quota, charge_scope
    ) VALUES ('ent1', '2026-01-10', 'copilot', 'sku1', 50, 'requests', 0.02, 1, 0, 1, 'legacyuser', 'org1', 'gpt-4', 'FALSE', 500, 'user')
  `).run();

  // Now apply the new, additive licensing schema — twice, to prove
  // idempotency (mirrors getDb() running CREATE TABLE IF NOT EXISTS on
  // every process start against the same on-disk file).
  execSchema(db, "licensing-schema.sql");
  execSchema(db, "licensing-schema.sql");
});

afterAll(() => {
  // Optional chaining: if beforeAll threw before `db` was assigned (e.g. the
  // native binding is unavailable in this environment), this must not throw
  // a second, unrelated error that masks the real failure.
  db?.close();
});

beforeEach(() => {
  db.exec("DELETE FROM license_audit_events");
  db.exec("DELETE FROM license_identity_records");
  db.exec("DELETE FROM license_seat_snapshots");
  db.exec("DELETE FROM license_org_billing_snapshots");
  db.exec("DELETE FROM license_aic_consumption");
  db.exec("DELETE FROM license_period_rows");
});

describe("backward compatibility", () => {
  it("preserves pre-existing copilot_seats and billing rows after licensing schema init (run twice)", () => {
    const seat = db.prepare(`SELECT * FROM copilot_seats WHERE user_login = 'legacyuser'`).get() as
      | { enterprise_slug: string; org_slug: string; plan_type: string }
      | undefined;
    expect(seat).toBeDefined();
    expect(seat?.enterprise_slug).toBe("ent1");
    expect(seat?.plan_type).toBe("business");

    const billingRow = db
      .prepare(`SELECT * FROM billing_premium_requests WHERE username = 'legacyuser'`)
      .get() as { organization: string; quantity: number } | undefined;
    expect(billingRow).toBeDefined();
    expect(billingRow?.organization).toBe("org1");
    expect(billingRow?.quantity).toBe(50);
  });

  it("creates all new licensing tables", () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'license_%'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual([
      "license_aic_consumption",
      "license_audit_events",
      "license_identity_records",
      "license_org_billing_snapshots",
      "license_period_rows",
      "license_reconciliation_checks",
      "license_reconciliation_runs",
      "license_seat_snapshots",
      "license_source_sync_state",
    ]);
  });
});

describe("stableStringify / parseJsonArray / parseJsonObject", () => {
  it("serializes object keys in sorted order regardless of input order", () => {
    const a = stableStringify({ b: 1, a: 2, c: [3, 2, 1] });
    const b = stableStringify({ c: [3, 2, 1], a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":[3,2,1]}');
  });

  it("always returns a string, even for inputs where JSON.stringify itself returns undefined", () => {
    // JSON.stringify(undefined) returns the JS value `undefined`, not a
    // string — stableStringify must not propagate that footgun since its
    // output is always written into a SQLite TEXT column.
    expect(stableStringify(undefined)).toBe("null");
    expect(typeof stableStringify(undefined)).toBe("string");
    expect(stableStringify(() => {})).toBe("null");
    expect(typeof stableStringify(() => {})).toBe("string");
  });

  it("parses JSON arrays/objects and degrades gracefully on invalid input", () => {
    expect(parseJsonArray('["x","y"]')).toEqual(["x", "y"]);
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonArray('{"a":1}')).toEqual([]);

    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject(null)).toEqual({});
    expect(parseJsonObject("not json")).toEqual({});
    expect(parseJsonObject("[1,2]")).toEqual({});
  });
});

describe("upsertAuditEvents", () => {
  it("inserts events and is idempotent on re-run with the same eventId", () => {
    const events = [
      {
        eventId: "evt1",
        orgLogin: "org1",
        action: "member.added_to_business",
        occurredAt: "2026-01-01T00:00:00Z",
        githubUserId: 1,
        observedLogin: "user1",
        source: "audit_log",
      },
    ];
    expect(upsertAuditEvents("ent1", events)).toBe(1);
    expect(upsertAuditEvents("ent1", events)).toBe(1);
    const rows = db.prepare(`SELECT * FROM license_audit_events WHERE enterprise_slug = 'ent1'`).all();
    expect(rows).toHaveLength(1);
  });

  it("isolates events by enterprise_slug", () => {
    upsertAuditEvents("ent1", [
      { eventId: "evt1", action: "a", occurredAt: "2026-01-01T00:00:00Z", source: "audit_log" },
    ]);
    upsertAuditEvents("ent2", [
      { eventId: "evt1", action: "a", occurredAt: "2026-01-01T00:00:00Z", source: "audit_log" },
    ]);
    const ent1Rows = db.prepare(`SELECT * FROM license_audit_events WHERE enterprise_slug = 'ent1'`).all();
    const ent2Rows = db.prepare(`SELECT * FROM license_audit_events WHERE enterprise_slug = 'ent2'`).all();
    expect(ent1Rows).toHaveLength(1);
    expect(ent2Rows).toHaveLength(1);
  });
});

describe("replacePeriodSnapshots", () => {
  it("replaces the snapshot set for a period, removing stale holders", () => {
    replacePeriodSnapshots("ent1", "2026-01", [
      { holderKey: "user1", snapshotAt: "2026-01-31T00:00:00Z", source: "seat_api", orgLogin: "org1" },
      { holderKey: "user2", snapshotAt: "2026-01-31T00:00:00Z", source: "seat_api", orgLogin: "org1" },
    ]);
    let rows = db.prepare(`SELECT holder_key FROM license_seat_snapshots WHERE billing_period = '2026-01'`).all();
    expect(rows).toHaveLength(2);

    // Re-run with only one holder: the stale one must be gone.
    replacePeriodSnapshots("ent1", "2026-01", [
      { holderKey: "user1", snapshotAt: "2026-01-31T12:00:00Z", source: "seat_api", orgLogin: "org1" },
    ]);
    rows = db.prepare(`SELECT holder_key FROM license_seat_snapshots WHERE billing_period = '2026-01'`).all();
    expect(rows).toEqual([{ holder_key: "user1" }]);
  });

  it("does not affect other periods or enterprises", () => {
    replacePeriodSnapshots("ent1", "2026-01", [
      { holderKey: "user1", snapshotAt: "2026-01-31T00:00:00Z", source: "seat_api" },
    ]);
    replacePeriodSnapshots("ent1", "2026-02", [
      { holderKey: "user1", snapshotAt: "2026-02-28T00:00:00Z", source: "seat_api" },
    ]);
    replacePeriodSnapshots("ent1", "2026-01", []);
    const janRows = db.prepare(`SELECT * FROM license_seat_snapshots WHERE billing_period = '2026-01'`).all();
    const febRows = db.prepare(`SELECT * FROM license_seat_snapshots WHERE billing_period = '2026-02'`).all();
    expect(janRows).toHaveLength(0);
    expect(febRows).toHaveLength(1);
  });

  it("fails and rolls back when the input batch contains a duplicate (org, holder) key (plain INSERT, not last-write-wins)", () => {
    replacePeriodSnapshots("ent1", "2026-05", [
      { holderKey: "user1", snapshotAt: "2026-05-31T00:00:00Z", source: "seat_api", orgLogin: "org1" },
    ]);
    expect(() =>
      replacePeriodSnapshots("ent1", "2026-05", [
        { holderKey: "dup", snapshotAt: "2026-05-31T00:00:00Z", source: "seat_api", orgLogin: "org1" },
        { holderKey: "dup", snapshotAt: "2026-05-31T01:00:00Z", source: "seat_api", orgLogin: "org1" },
      ])
    ).toThrow();
    // Rolled back entirely: the pre-existing row from before this call must survive.
    const rows = db.prepare(`SELECT holder_key FROM license_seat_snapshots WHERE billing_period = '2026-05'`).all();
    expect(rows).toEqual([{ holder_key: "user1" }]);
  });
});

describe("upsertIdentityRecords / upsertOrgBillingSnapshots / upsertAicConsumption", () => {
  it("upserts identity records idempotently", () => {
    const records = [
      {
        identityKey: "1",
        githubUserId: 1,
        resolvedLogin: "user1",
        resolutionSource: "live_seat",
        observedAt: "2026-01-01T00:00:00Z",
      },
    ];
    expect(upsertIdentityRecords("ent1", records)).toBe(1);
    expect(upsertIdentityRecords("ent1", records)).toBe(1);
    const rows = db.prepare(`SELECT * FROM license_identity_records`).all();
    expect(rows).toHaveLength(1);
  });

  it("upserts org billing snapshots idempotently", () => {
    const records = [
      { billingPeriod: "2026-01", orgLogin: "org1", totalSeats: 10, observedAt: "2026-01-31T00:00:00Z" },
    ];
    expect(upsertOrgBillingSnapshots("ent1", records)).toBe(1);
    expect(upsertOrgBillingSnapshots("ent1", records)).toBe(1);
    const rows = db.prepare(`SELECT total_seats FROM license_org_billing_snapshots`).all();
    expect(rows).toEqual([{ total_seats: 10 }]);
  });

  it("upserts AIC consumption idempotently and stores raw_json deterministically", () => {
    const records = [
      {
        billingPeriod: "2026-01",
        orgLogin: "org1",
        holderKey: "user1",
        credits: 100,
        grossUsd: 6.33,
        source: "billing_report",
        observedAt: "2026-01-31T00:00:00Z",
        raw: { z: 1, a: 2 },
      },
    ];
    expect(upsertAicConsumption("ent1", records)).toBe(1);
    expect(upsertAicConsumption("ent1", records)).toBe(1);
    const row = db.prepare(`SELECT raw_json FROM license_aic_consumption`).get() as { raw_json: string };
    expect(row.raw_json).toBe('{"a":2,"z":1}');
  });
});

describe("replaceMaterializedPeriod + queryLicensePeriodRows", () => {
  beforeEach(() => {
    replaceMaterializedPeriod("ent1", "2026-01", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1" }),
      makePeriodRow({
        orgLogin: "org2",
        holderKey: "user2",
        resolvedUserLogin: "user2",
        planType: "enterprise",
        historyConfidence: "low",
        aicConsumedUsd: 40,
        aicAssignedUsd: 19,
        defaultAicUsd: 19,
      }),
    ]);
    replaceMaterializedPeriod("ent1", "2026-02", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1", licenseCost: 19 }),
    ]);
    replaceMaterializedPeriod("ent2", "2026-01", [
      makePeriodRow({ orgLogin: "org9", holderKey: "userX", resolvedUserLogin: "userX" }),
    ]);
  });

  it("replaces stale rows for a period without touching other periods/enterprises", () => {
    replaceMaterializedPeriod("ent1", "2026-01", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1" }),
    ]);
    const jan = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-01"] });
    expect(jan.pagination.totalItems).toBe(1);
    const feb = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-02"] });
    expect(feb.pagination.totalItems).toBe(1);
    const ent2 = queryLicensePeriodRows({ enterpriseSlug: "ent2" });
    expect(ent2.pagination.totalItems).toBe(1);
  });

  it("isolates rows by enterprise (enterprise isolation)", () => {
    const ent1 = queryLicensePeriodRows({ enterpriseSlug: "ent1" });
    const ent2 = queryLicensePeriodRows({ enterpriseSlug: "ent2" });
    expect(ent1.rows.every((r) => r.enterpriseSlug === "ent1")).toBe(true);
    expect(ent2.rows.every((r) => r.enterpriseSlug === "ent2")).toBe(true);
    expect(ent2.pagination.totalItems).toBe(1);
  });

  it("supports period range filters (both bounds, start-only, and end-only)", () => {
    const bothBounds = queryLicensePeriodRows({ enterpriseSlug: "ent1", periodStart: "2026-02", periodEnd: "2026-02" });
    expect(bothBounds.pagination.totalItems).toBe(1);
    expect(bothBounds.rows.every((r) => r.billingPeriod === "2026-02")).toBe(true);

    // periodStart only: everything from Feb onward (excludes Jan).
    const startOnly = queryLicensePeriodRows({ enterpriseSlug: "ent1", periodStart: "2026-02" });
    expect(startOnly.pagination.totalItems).toBe(1);
    expect(startOnly.rows.every((r) => r.billingPeriod >= "2026-02")).toBe(true);

    // periodEnd only: everything up to and including Jan (excludes Feb).
    const endOnly = queryLicensePeriodRows({ enterpriseSlug: "ent1", periodEnd: "2026-01" });
    expect(endOnly.pagination.totalItems).toBe(2);
    expect(endOnly.rows.every((r) => r.billingPeriod <= "2026-01")).toBe(true);
  });

  it("supports org/login/plan/account/seat/confidence filters", () => {
    const byOrg = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-01"], orgLogins: ["org2"] });
    expect(byOrg.pagination.totalItems).toBe(1);

    const byLogin = queryLicensePeriodRows({ enterpriseSlug: "ent1", logins: ["user2"] });
    expect(byLogin.pagination.totalItems).toBe(1);

    const byPlan = queryLicensePeriodRows({ enterpriseSlug: "ent1", planTypes: ["enterprise"] });
    expect(byPlan.pagination.totalItems).toBe(1);

    const byConfidence = queryLicensePeriodRows({ enterpriseSlug: "ent1", historyConfidence: ["low"] });
    expect(byConfidence.pagination.totalItems).toBe(1);

    const bySeatStatus = queryLicensePeriodRows({ enterpriseSlug: "ent1", seatStatuses: ["active"] });
    expect(bySeatStatus.pagination.totalItems).toBe(3);

    const byAccountState = queryLicensePeriodRows({ enterpriseSlug: "ent1", accountStates: ["active"] });
    expect(byAccountState.pagination.totalItems).toBe(3);
  });

  it("matches the `logins` filter through each of its three distinct column branches", () => {
    replaceMaterializedPeriod("ent1", "2026-12", [
      makePeriodRow({
        orgLogin: "org1",
        holderKey: "holder-only-key",
        userLogin: null,
        resolvedUserLogin: null,
      }),
      makePeriodRow({
        orgLogin: "org1",
        holderKey: "holder-2",
        userLogin: "raw-login-only",
        resolvedUserLogin: null,
      }),
      makePeriodRow({
        orgLogin: "org1",
        holderKey: "holder-3",
        userLogin: null,
        resolvedUserLogin: "resolved-login-only",
      }),
    ]);

    // Branch 1: matches via holder_key (no user_login/resolved_user_login).
    const byHolderKey = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-12"], logins: ["holder-only-key"] });
    expect(byHolderKey.rows.map((r) => r.holderKey)).toEqual(["holder-only-key"]);

    // Branch 2: matches via user_login.
    const byUserLogin = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-12"], logins: ["raw-login-only"] });
    expect(byUserLogin.rows.map((r) => r.holderKey)).toEqual(["holder-2"]);

    // Branch 3: matches via resolved_user_login.
    const byResolvedLogin = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-12"],
      logins: ["resolved-login-only"],
    });
    expect(byResolvedLogin.rows.map((r) => r.holderKey)).toEqual(["holder-3"]);
  });

  it("supports enterpriseSlugs (plural) filtering across multiple enterprises at once", () => {
    const result = queryLicensePeriodRows({ enterpriseSlugs: ["ent1", "ent2"] });
    const slugs = new Set(result.rows.map((r) => r.enterpriseSlug));
    expect(slugs).toEqual(new Set(["ent1", "ent2"]));
    expect(result.pagination.totalItems).toBe(4); // 2 (ent1 Jan) + 1 (ent1 Feb) + 1 (ent2 Jan)
  });

  it("supports free-text search across login/org/external-identity columns", () => {
    const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", search: "user2" });
    expect(result.pagination.totalItems).toBe(1);
    const none = queryLicensePeriodRows({ enterpriseSlug: "ent1", search: "no-such-user" });
    expect(none.pagination.totalItems).toBe(0);
    expect(none.rows).toEqual([]);
  });

  it("falls back to a safe default sort column when an unknown sort field is requested", () => {
    const result = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-01"],
      sortField: "'; DROP TABLE license_period_rows; --",
      sortDir: "asc",
    });
    expect(result.pagination.totalItems).toBe(2);
    // Table must still exist (no SQL injection via sortField).
    const stillExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='license_period_rows'`)
      .get();
    expect(stillExists).toBeDefined();
  });

  it("paginates results", () => {
    const page1 = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-01"], page: 1, pageSize: 1 });
    expect(page1.rows).toHaveLength(1);
    expect(page1.pagination.totalItems).toBe(2);
    expect(page1.pagination.totalPages).toBe(2);
    const page2 = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-01"], page: 2, pageSize: 1 });
    expect(page2.rows).toHaveLength(1);
  });

  it("parses dataQualityNotes JSON on read", () => {
    replaceMaterializedPeriod("ent1", "2026-03", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1", dataQualityNotes: ["late_source"] }),
    ]);
    const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-03"] });
    expect(result.rows[0]).toMatchObject({ dataQualityNotes: ["late_source"] });
  });

  it("returns valid empty results when no rows match", () => {
    const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2099-01"] });
    expect(result.rows).toEqual([]);
    expect(result.pagination.totalItems).toBe(0);
    expect(result.pagination.totalPages).toBe(0);
  });

  it("aggregates rollup view in SQL (sums cost/consumption per resolved login across periods/orgs)", () => {
    const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", view: "rollup" });
    expect(rollup.view).toBe("rollup");
    const user1 = rollup.rows.find((r) => r.resolvedUserLogin === "user1");
    expect(user1).toBeDefined();
    // user1 holds the *same* org1 seat across Jan and Feb — one continuously
    // held seat, not two period-rows. seatCount is a distinct (org, holder)
    // count, decoupled from periodCount (see LicenseRollupRowRecord.seatCount doc).
    expect(user1?.seatCount).toBe(1);
    expect(user1?.periodCount).toBe(2);
    expect(user1?.licenseCost).toBeCloseTo(19 + 19, 5);
    // GROUP_CONCAT(DISTINCT ...) uses a comma separator (splitDistinct must
    // parse on ",", not "\u0001") — assert the grouped arrays themselves,
    // not just their counts.
    expect(user1?.periods.slice().sort()).toEqual(["2026-01", "2026-02"]);
    expect(user1?.orgLogins.slice().sort()).toEqual(["org1"]);
    expect(user1?.planTypes.slice().sort()).toEqual(["business"]);

    const user2 = rollup.rows.find((r) => r.resolvedUserLogin === "user2");
    expect(user2?.periods).toEqual(["2026-01"]);
    expect(user2?.orgLogins).toEqual(["org2"]);
    expect(user2?.planTypes).toEqual(["enterprise"]);
  });

  it("counts distinct (org, holder) seats, not period-rows: a holder with 2 different org seats in ONE period counts twice", () => {
    replaceMaterializedPeriod("ent1", "2026-10", [
      makePeriodRow({ orgLogin: "org1", holderKey: "multi-org-user", resolvedUserLogin: "multi-org-user" }),
      makePeriodRow({ orgLogin: "org2", holderKey: "multi-org-user", resolvedUserLogin: "multi-org-user" }),
    ]);
    const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-10"], view: "rollup" });
    const row = rollup.rows.find((r) => r.resolvedUserLogin === "multi-org-user");
    expect(row).toBeDefined();
    expect(row?.seatCount).toBe(2); // two distinct orgs held in the same period
    expect(row?.periodCount).toBe(1);
  });

  it("projects utilization_pct in SQL consistent with aic_consumed/aic_assigned and honors the assigned-then-default fallback", () => {
    const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", view: "rollup" });
    const user2 = rollup.rows.find((r) => r.resolvedUserLogin === "user2");
    // user2 fixture (single row, Jan only): aicConsumedUsd 40, aicAssignedUsd 19.
    expect(user2).toBeDefined();
    expect(user2?.utilizationPct).toBeCloseTo((40 / 19) * 100, 5);
  });

  describe("utilization_pct branches (assigned budget, default-fallback, and zero)", () => {
    it("uses the assigned budget when aic_assigned_usd > 0", () => {
      replaceMaterializedPeriod("ent1", "2026-13", [
        makePeriodRow({
          orgLogin: "org1",
          holderKey: "assigned-branch",
          resolvedUserLogin: "assigned-branch",
          aicAssignedUsd: 20,
          defaultAicUsd: 19,
          aicConsumedUsd: 10,
        }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-13"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "assigned-branch");
      expect(row?.utilizationPct).toBeCloseTo((10 / 20) * 100, 5);
    });

    it("falls back to the plan default when aic_assigned_usd is 0", () => {
      replaceMaterializedPeriod("ent1", "2026-14", [
        makePeriodRow({
          orgLogin: "org1",
          holderKey: "default-branch",
          resolvedUserLogin: "default-branch",
          aicAssignedUsd: 0,
          defaultAicUsd: 19,
          aicConsumedUsd: 5,
        }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-14"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "default-branch");
      expect(row?.utilizationPct).toBeCloseTo((5 / 19) * 100, 5);
    });

    it("returns 0 when both aic_assigned_usd and default_aic_usd are 0", () => {
      replaceMaterializedPeriod("ent1", "2026-15", [
        makePeriodRow({
          orgLogin: "org1",
          holderKey: "zero-branch",
          resolvedUserLogin: "zero-branch",
          aicAssignedUsd: 0,
          defaultAicUsd: 0,
          aicConsumedUsd: 5,
        }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-15"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "zero-branch");
      expect(row?.utilizationPct).toBe(0);
    });
  });

  it("actually orders rows by utilization_pct and by license_cost, not just accepting the sort field", () => {
    replaceMaterializedPeriod("ent1", "2026-16", [
      makePeriodRow({ orgLogin: "org1", holderKey: "low-util", resolvedUserLogin: "low-util", aicAssignedUsd: 100, aicConsumedUsd: 10, licenseCost: 5 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "high-util", resolvedUserLogin: "high-util", aicAssignedUsd: 100, aicConsumedUsd: 90, licenseCost: 25 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "mid-util", resolvedUserLogin: "mid-util", aicAssignedUsd: 100, aicConsumedUsd: 50, licenseCost: 15 }),
    ]);

    const byUtilAsc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-16"],
      view: "rollup",
      sortField: "utilization_pct",
      sortDir: "asc",
    });
    expect(byUtilAsc.rows.map((r) => r.resolvedUserLogin)).toEqual(["low-util", "mid-util", "high-util"]);

    const byUtilDesc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-16"],
      view: "rollup",
      sortField: "utilization_pct",
      sortDir: "desc",
    });
    expect(byUtilDesc.rows.map((r) => r.resolvedUserLogin)).toEqual(["high-util", "mid-util", "low-util"]);

    const byCostAsc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-16"],
      sortField: "license_cost",
      sortDir: "asc",
    });
    expect(byCostAsc.rows.map((r) => r.holderKey)).toEqual(["low-util", "mid-util", "high-util"]);

    const byCostDesc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-16"],
      sortField: "license_cost",
      sortDir: "desc",
    });
    expect(byCostDesc.rows.map((r) => r.holderKey)).toEqual(["high-util", "mid-util", "low-util"]);
  });

  describe("sort allowlist coverage", () => {
    it("accepts every detail sort column without error", () => {
      for (const field of DETAIL_SORT_COLUMNS) {
        const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", sortField: field, sortDir: "asc" });
        expect(result.view).toBe("detail");
        expect(Array.isArray(result.rows)).toBe(true);
      }
    });

    it("accepts every rollup sort column without error, including utilization_pct", () => {
      for (const field of ROLLUP_SORT_COLUMNS) {
        const result = queryLicensePeriodRows({
          enterpriseSlug: "ent1",
          view: "rollup",
          sortField: field,
          sortDir: "desc",
        });
        expect(result.view).toBe("rollup");
        expect(Array.isArray(result.rows)).toBe(true);
      }
    });
  });

  it("keeps OFFSET pagination stable when the sort column has ties (deterministic tie-breakers)", () => {
    replaceMaterializedPeriod("ent1", "2026-06", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a", licenseCost: 19 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-b", resolvedUserLogin: "user-b", licenseCost: 19 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-c", resolvedUserLogin: "user-c", licenseCost: 19 }),
    ]);
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const result = queryLicensePeriodRows({
        enterpriseSlug: "ent1",
        periods: ["2026-06"],
        sortField: "license_cost",
        sortDir: "asc",
        page,
        pageSize: 1,
      });
      expect(result.rows).toHaveLength(1);
      const holderKey = result.rows[0].holderKey;
      expect(seen.has(holderKey)).toBe(false); // no duplicates across pages
      seen.add(holderKey);
    }
    expect(seen).toEqual(new Set(["user-a", "user-b", "user-c"]));
  });

  describe("ORDER BY tie-breakers have no duplicate/conflicting column mentions", () => {
    it("detail: omits the primary sort column from its own tie-breaker list", () => {
      const clause = buildDetailOrderBy({ page: 1, pageSize: 10, sortField: "billing_period", sortDir: "desc", search: undefined });
      const mentions = clause.match(/\bbilling_period\b/g) ?? [];
      expect(mentions).toHaveLength(1);
      // org_login/holder_key/enterprise_slug tie-breakers must still be present.
      expect(clause).toMatch(/\borg_login\b/);
      expect(clause).toMatch(/\bholder_key\b/);
      expect(clause).toMatch(/\benterprise_slug\b/);
    });

    it("detail: falls back to full PK tie-breakers when sorting by a non-PK column", () => {
      const clause = buildDetailOrderBy({ page: 1, pageSize: 10, sortField: "license_cost", sortDir: "asc", search: undefined });
      expect(clause.match(/\bbilling_period\b/g)).toHaveLength(1);
      expect(clause.match(/\borg_login\b/g)).toHaveLength(1);
      expect(clause.match(/\bholder_key\b/g)).toHaveLength(1);
      expect(clause.match(/\benterprise_slug\b/g)).toHaveLength(1);
    });

    it("rollup: omits the primary sort column from its own tie-breaker list", () => {
      const clause = buildRollupOrderBy({ page: 1, pageSize: 10, sortField: "resolved_user_login", sortDir: "asc", search: undefined });
      const mentions = clause.match(/\bresolved_user_login\b/g) ?? [];
      expect(mentions).toHaveLength(1);
      expect(clause).toMatch(/\benterprise_slug\b/);
    });

    it("rollup: keeps both tie-breakers when sorting by a non-group-key column", () => {
      const clause = buildRollupOrderBy({ page: 1, pageSize: 10, sortField: "seat_count", sortDir: "desc", search: undefined });
      expect(clause.match(/\benterprise_slug\b/g)).toHaveLength(1);
      expect(clause.match(/\bresolved_user_login\b/g)).toHaveLength(1);
    });
  });

  it("escapes LIKE wildcards in search so % and _ match literally, not as wildcards", () => {
    replaceMaterializedPeriod("ent1", "2026-07", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user_a", resolvedUserLogin: "user_a" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "userXa", resolvedUserLogin: "userXa" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "100%dev", resolvedUserLogin: "100%dev" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "100Xdev", resolvedUserLogin: "100Xdev" }),
    ]);

    // A literal underscore must not act as a "match any single character" wildcard.
    const underscoreSearch = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-07"], search: "user_a" });
    expect(underscoreSearch.rows.map((r) => r.resolvedUserLogin)).toEqual(["user_a"]);

    // A literal percent must not act as a "match anything" wildcard.
    const percentSearch = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-07"], search: "100%dev" });
    expect(percentSearch.rows.map((r) => r.resolvedUserLogin)).toEqual(["100%dev"]);
  });

  it("rolls back the entire batch when a later row violates a NOT NULL constraint (transaction atomicity)", () => {
    // Seed a known-good baseline for the period.
    replaceMaterializedPeriod("ent1", "2026-04", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1" }),
    ]);
    const before = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-04"] });
    expect(before.pagination.totalItems).toBe(1);

    const goodRow = makePeriodRow({ orgLogin: "org1", holderKey: "user3", resolvedUserLogin: "user3" });
    const badRow = makePeriodRow({ orgLogin: "org1", holderKey: "user2", resolvedUserLogin: "user2" });
    // Force a NOT NULL constraint violation on the second statement of the batch
    // (aic_assigned_rule is NOT NULL with no default).
    (badRow as unknown as { aicAssignedRule: string | null }).aicAssignedRule = null;

    expect(() => replaceMaterializedPeriod("ent1", "2026-04", [goodRow, badRow])).toThrow();

    // The whole transaction (DELETE + both INSERTs) must have rolled back:
    // the pre-existing "user1" row must survive, and "user3" — whose INSERT
    // ran successfully before the failing statement — must not have leaked
    // in as a partial write.
    const after = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-04"] });
    expect(after.pagination.totalItems).toBe(1);
    expect(after.rows[0].holderKey).toBe("user1");
  });

  it("fails and rolls back when the input batch contains duplicate (org, holder) keys (plain INSERT, not last-write-wins)", () => {
    replaceMaterializedPeriod("ent1", "2026-11", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user1", resolvedUserLogin: "user1" }),
    ]);
    expect(() =>
      replaceMaterializedPeriod("ent1", "2026-11", [
        makePeriodRow({ orgLogin: "org1", holderKey: "dup", resolvedUserLogin: "dup" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "dup", resolvedUserLogin: "dup" }), // duplicate PK within the same batch
      ])
    ).toThrow();
    // Rolled back entirely: the pre-existing row from before this call must survive.
    const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-11"] });
    expect(result.pagination.totalItems).toBe(1);
    expect(result.rows[0].holderKey).toBe("user1");
  });

  describe("canonical unattributed org representation", () => {
    it("normalizes a missing/empty org_login to the '(unattributed)' sentinel on write and read", () => {
      replaceMaterializedPeriod("ent1", "2026-08", [
        makePeriodRow({ orgLogin: "", holderKey: "user-unattributed", resolvedUserLogin: "user-unattributed" }),
        makePeriodRow({ orgLogin: undefined, holderKey: "user-unattributed-2", resolvedUserLogin: "user-unattributed-2" }),
      ]);
      const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-08"] });
      expect(result.rows.every((r) => r.orgLogin === UNATTRIBUTED_ORG)).toBe(true);
      // The stored column value itself must be the sentinel, not "".
      const stored = db
        .prepare(`SELECT org_login FROM license_period_rows WHERE billing_period = '2026-08' AND holder_key = 'user-unattributed'`)
        .get() as { org_login: string };
      expect(stored.org_login).toBe(UNATTRIBUTED_ORG);
    });

    it("keeps rollup orgLogins and orgCount in agreement for unattributed-only holders", () => {
      replaceMaterializedPeriod("ent1", "2026-09", [
        makePeriodRow({ orgLogin: "", holderKey: "user-unattributed-3", resolvedUserLogin: "user-unattributed-3" }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-09"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "user-unattributed-3");
      expect(row).toBeDefined();
      expect(row?.orgCount).toBe(1);
      expect(row?.orgLogins).toEqual([UNATTRIBUTED_ORG]);
    });
  });

  it("has an expression index matching the rollup GROUP BY key", () => {
    const index = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_license_period_rows_rollup_group'`)
      .get() as { sql: string } | undefined;
    expect(index).toBeDefined();
    expect(index?.sql).toContain("resolved_user_login");
    expect(index?.sql).toContain("holder_key");
  });

  describe("getMaterializedPeriodKPIs / getMaterializedPlanBreakdown / getMaterializedOrgBreakdown / hasMaterializedRows", () => {
    // Fixture (from the outer beforeEach): ent1/2026-01 has
    //   - user1/org1: business, licenseCost 19, defaultAicCredits 300, defaultAicUsd 19,
    //     aicAssignedUsd 19, aicConsumedCredits 100, aicConsumedUsd 6.33, high confidence
    //   - user2/org2: enterprise, licenseCost 19, defaultAicCredits 300, defaultAicUsd 19,
    //     aicAssignedUsd 19, aicConsumedCredits 100, aicConsumedUsd 40 (over budget), low confidence
    // plus ent1/2026-02 (user1/org1) and ent2/2026-01 (userX/org9), excluded by the period/enterprise filter below.

    it("computes KPI totals in SQL, scoped to the requested enterprise/period only", () => {
      const kpis = getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"] });
      expect(kpis.totalRows).toBe(2);
      expect(kpis.totalUsers).toBe(2);
      expect(kpis.activeSeats).toBe(2);
      expect(kpis.inactiveSeats).toBe(0);
      expect(kpis.zeroConsumptionRows).toBe(0);
      expect(kpis.totalLicenseCost).toBe(38);
      expect(kpis.totalAllowanceCredits).toBe(600);
      expect(kpis.totalAssignedUsd).toBe(38);
      expect(kpis.totalConsumedCredits).toBe(200);
      expect(kpis.totalConsumedUsd).toBe(46.33);
      expect(kpis.overBudgetRows).toBe(1); // only user2 (40 > 19)
      expect(kpis.totalOverageUsd).toBe(21); // max(40-19,0) + max(6.33-19,0)
      expect(kpis.totalCostOfOwnership).toBe(59); // 38 + 21
      expect(kpis.overallUtilizationPct).toBe(121.92); // 46.33/38*100
      expect(kpis.currency).toBe("USD");
    });

    it("never returns NaN/Infinity and defaults currency to USD for an empty scope", () => {
      const kpis = getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2099-01"] });
      expect(kpis.totalRows).toBe(0);
      expect(kpis.totalUsers).toBe(0);
      expect(kpis.totalLicenseCost).toBe(0);
      expect(kpis.overallUtilizationPct).toBe(0);
      expect(kpis.totalOverageUsd).toBe(0);
      expect(kpis.currency).toBe("USD");
      for (const value of Object.values(kpis)) {
        if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      }
    });

    it("breaks totals down by plan_type, aggregated in SQL", () => {
      const plans = getMaterializedPlanBreakdown({ enterpriseSlug: "ent1", periods: ["2026-01"] });
      expect(plans.map((p) => p.key).sort()).toEqual(["business", "enterprise"]);
      const business = plans.find((p) => p.key === "business")!;
      const enterprise = plans.find((p) => p.key === "enterprise")!;
      expect(business.rows).toBe(1);
      expect(business.consumedUsd).toBe(6.33);
      expect(business.overageUsd).toBe(0);
      expect(enterprise.consumedUsd).toBe(40);
      expect(enterprise.overageUsd).toBe(21);
      expect(enterprise.utilizationPct).toBe(210.53); // 40/19*100
    });

    it("breaks totals down by org_login, aggregated in SQL", () => {
      const orgs = getMaterializedOrgBreakdown({ enterpriseSlug: "ent1", periods: ["2026-01"] });
      expect(orgs.map((o) => o.key).sort()).toEqual(["org1", "org2"]);
      expect(orgs.find((o) => o.key === "org2")!.overageUsd).toBe(21);
    });

    it("returns empty breakdown arrays for a scope with no materialized rows", () => {
      expect(getMaterializedPlanBreakdown({ enterpriseSlug: "ent1", periods: ["2099-01"] })).toEqual([]);
      expect(getMaterializedOrgBreakdown({ enterpriseSlug: "ent1", periods: ["2099-01"] })).toEqual([]);
    });

    it("detects materialized rows exist for a scope, letting callers skip the legacy fallback", () => {
      expect(hasMaterializedRows({ enterpriseSlug: "ent1", periods: ["2026-01"] })).toBe(true);
    });

    it("detects NO materialized rows for an unmaterialized scope, without a false historical success", () => {
      expect(hasMaterializedRows({ enterpriseSlug: "ent1", periods: ["2099-01"] })).toBe(false);
      expect(hasMaterializedRows({ enterpriseSlug: "never-synced-enterprise" })).toBe(false);
    });

    it("respects enterprise/org/login/plan/account/seat/confidence filters shared with the detail/rollup query", () => {
      expect(getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"], planTypes: ["enterprise"] }).totalRows).toBe(1);
      expect(getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"], orgLogins: ["org1"] }).totalRows).toBe(1);
      expect(getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"], logins: ["user2"] }).totalRows).toBe(1);
      expect(getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"], historyConfidence: ["low"] }).totalRows).toBe(1);
      expect(getMaterializedPeriodKPIs({ enterpriseSlugs: ["ent1", "ent2"], periods: ["2026-01"] }).totalRows).toBe(3);
    });
  });
});

describe("empty tables", () => {
  it("returns zero/empty results from a freshly-created, unpopulated schema", () => {
    const emptyDb = new Database(":memory:");
    execSchema(emptyDb, "schema.sql");
    execSchema(emptyDb, "billing-schema.sql");
    execSchema(emptyDb, "licensing-schema.sql");
    const rows = emptyDb.prepare(`SELECT * FROM license_period_rows`).all();
    expect(rows).toEqual([]);
    emptyDb.close();
  });
});
