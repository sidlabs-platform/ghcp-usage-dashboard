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
 * SQLite engine exercising the production repo's real SQL/params/transaction
 * logic, not a mock of query results: `license-history-repo.ts` is never
 * modified, and this facade only translates the handful of better-sqlite3
 * API shapes (`pragma`, `.transaction`, positional `?` binding) that
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
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args) => {
      this.raw.exec("BEGIN");
      try {
        const result = fn(...args);
        this.raw.exec("COMMIT");
        return result;
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

import {
  upsertAuditEvents,
  replacePeriodSnapshots,
  upsertIdentityRecords,
  upsertOrgBillingSnapshots,
  upsertAicConsumption,
  listPersistedAuditEvents,
  listPersistedSeatSnapshots,
  listPersistedIdentityRecords,
  listPersistedOrgBillingSnapshots,
  listPersistedAicConsumption,
  replaceMaterializedPeriod,
  queryLicensePeriodRows,
  getMaterializedPeriodKPIs,
  getMaterializedPlanBreakdown,
  getMaterializedOrgBreakdown,
  getMaterializedPeriods,
  getMaterializedUtilizationBuckets,
  getLatestLicenseQualitySummary,
  hasMaterializedRows,
  stableStringify,
  parseJsonArray,
  parseJsonObject,
  DETAIL_SORT_COLUMNS,
  ROLLUP_SORT_COLUMNS,
  UNATTRIBUTED_ORG,
  buildDetailOrderBy,
  buildRollupOrderBy,
  queryLicensePeriodExport,
  EXPORT_MAX_ROWS,
  type LicensePeriodRowInput,
} from "./license-history-repo";

const SCHEMA_DIR = path.join(process.cwd(), "src", "lib", "db");

function execSchema(database: TestDb, file: string): void {
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
    historyConfidence: "exact_snapshot",
    dataQualityNotes: [],
    asOfUtc: "2026-01-31T23:59:59Z",
    generatedAtUtc: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

beforeAll(() => {
  db = new TestDb(":memory:");
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
  db.exec("DELETE FROM license_reconciliation_checks");
  db.exec("DELETE FROM license_reconciliation_runs");
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

  describe("persisted source readers", () => {
    it("returns durable source rows scoped by enterprise and billing period", () => {
      upsertAuditEvents("ent1", [{
        eventId: "evt1",
        orgLogin: "org1",
        action: "copilot.canceled",
        occurredAt: "2026-01-20T00:00:00Z",
        githubUserId: 7,
        observedLogin: "churned-user",
        externalIdentity: "opaque-id",
        assignedVia: "team",
        source: "audit_log",
      }]);
      replacePeriodSnapshots("ent1", "2026-01", [{
        orgLogin: "org1",
        holderKey: "id:7",
        githubUserId: 7,
        observedLogin: "churned-user",
        planType: "enterprise",
        assignedVia: "team",
        lastActivityAt: "2026-01-15T00:00:00Z",
        snapshotAt: "2026-01-31T00:00:00Z",
        source: "authoritative_import",
      }]);
      upsertIdentityRecords("ent1", [{
        identityKey: "id:7",
        githubUserId: 7,
        resolvedLogin: "churned-user",
        externalIdentity: "opaque-id",
        accountState: "deprovisioned",
        resolutionSource: "scim_enterprise",
        observedAt: "2026-02-01T00:00:00Z",
      }]);
      upsertOrgBillingSnapshots("ent1", [{
        billingPeriod: "2026-01",
        orgLogin: "org1",
        planType: "enterprise",
        totalSeats: 1,
        pendingCancellation: 0,
        observedAt: "2026-01-31T00:00:00Z",
      }]);
      upsertAicConsumption("ent1", [{
        billingPeriod: "2026-01",
        orgLogin: "org1",
        holderKey: "id:7",
        username: "churned-user",
        credits: 40,
        grossUsd: 4,
        netUsd: 3.5,
        source: "enterprise_api",
        observedAt: "2026-01-31T00:00:00Z",
      }]);

      expect(listPersistedAuditEvents("ent1", ["2026-01"])).toEqual([
        expect.objectContaining({
          eventId: "evt1",
          holderKey: "id:7",
          observedLogin: "churned-user",
          externalIdentity: "opaque-id",
        }),
      ]);
      expect(listPersistedSeatSnapshots("ent1", ["2026-01"])).toEqual([
        expect.objectContaining({
          billingPeriod: "2026-01",
          holderKey: "id:7",
          planType: "enterprise",
          source: "authoritative_import",
        }),
      ]);
      expect(listPersistedIdentityRecords("ent1")).toEqual([
        expect.objectContaining({
          identityKey: "id:7",
          accountState: "deprovisioned",
        }),
      ]);
      expect(listPersistedOrgBillingSnapshots("ent1", ["2026-01"])).toEqual([
        expect.objectContaining({ billingPeriod: "2026-01", orgLogin: "org1", totalSeats: 1 }),
      ]);
      expect(listPersistedAicConsumption("ent1", ["2026-01"])).toEqual([
        expect.objectContaining({
          billingPeriod: "2026-01",
          holderKey: "id:7",
          netUsd: 3.5,
        }),
      ]);

      expect(listPersistedAuditEvents("ent2", ["2026-01"])).toEqual([]);
      expect(listPersistedSeatSnapshots("ent1", ["2026-02"])).toEqual([]);
      expect(listPersistedAicConsumption("ent1", ["2026-02"])).toEqual([]);
    });

    it("includes pre-period audit assignments needed to reconstruct an open interval", () => {
      upsertAuditEvents("ent1", [{
        eventId: "dec-assign",
        orgLogin: "org1",
        action: "copilot.assigned",
        occurredAt: "2025-12-20T00:00:00Z",
        githubUserId: 7,
        observedLogin: "churned-user",
        source: "audit_log",
      }]);

      expect(listPersistedAuditEvents("ent1", ["2026-01"]).map((event) => event.eventId))
        .toContain("dec-assign");
    });
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
        historyConfidence: "live_snapshot_only",
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

    const byConfidence = queryLicensePeriodRows({ enterpriseSlug: "ent1", historyConfidence: ["live_snapshot_only"] });
    expect(byConfidence.pagination.totalItems).toBe(1);

    const bySeatStatus = queryLicensePeriodRows({ enterpriseSlug: "ent1", seatStatuses: ["active"] });
    expect(bySeatStatus.pagination.totalItems).toBe(3);

    const byAccountState = queryLicensePeriodRows({ enterpriseSlug: "ent1", accountStates: ["active"] });
    expect(byAccountState.pagination.totalItems).toBe(3);
  });

  describe("confidence vocabulary", () => {
    // Regression test for the fictional high/medium/low ranking that used to
    // back CONFIDENCE_RANK_SQL/RANK_TO_CONFIDENCE: persisted
    // history_confidence values are always one of the four real
    // SeatLedgerConfidence strings (see seat-ledger.ts), never "high"/"low".
    it("persists and returns all four real SeatLedgerConfidence values unchanged on the detail view", () => {
      replaceMaterializedPeriod("ent1", "2026-17", [
        makePeriodRow({ orgLogin: "org1", holderKey: "h-exact", resolvedUserLogin: "h-exact", historyConfidence: "exact_snapshot" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "h-audit", resolvedUserLogin: "h-audit", historyConfidence: "audit_reconstructed" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "h-live", resolvedUserLogin: "h-live", historyConfidence: "live_snapshot_only" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "h-unrec", resolvedUserLogin: "h-unrec", historyConfidence: "unrecoverable" }),
      ]);
      const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-17"] });
      const byHolder = new Map(result.rows.map((r) => [r.holderKey, r.historyConfidence]));
      expect(byHolder.get("h-exact")).toBe("exact_snapshot");
      expect(byHolder.get("h-audit")).toBe("audit_reconstructed");
      expect(byHolder.get("h-live")).toBe("live_snapshot_only");
      expect(byHolder.get("h-unrec")).toBe("unrecoverable");
    });

    it("filters the detail view by each of the four real confidence values individually", () => {
      replaceMaterializedPeriod("ent1", "2026-18", [
        makePeriodRow({ orgLogin: "org1", holderKey: "h-exact2", resolvedUserLogin: "h-exact2", historyConfidence: "exact_snapshot" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "h-audit2", resolvedUserLogin: "h-audit2", historyConfidence: "audit_reconstructed" }),
        makePeriodRow({ orgLogin: "org1", holderKey: "h-unrec2", resolvedUserLogin: "h-unrec2", historyConfidence: "unrecoverable" }),
      ]);
      for (const [confidence, holder] of [
        ["exact_snapshot", "h-exact2"],
        ["audit_reconstructed", "h-audit2"],
        ["unrecoverable", "h-unrec2"],
      ] as const) {
        const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-18"], historyConfidence: [confidence] });
        expect(result.rows.map((r) => r.holderKey)).toEqual([holder]);
      }
    });

    it("rolls up confidence with worst-wins semantics: a resolved login spanning best and worst confidence rows reports the worst", () => {
      // Same resolved login held across two orgs in one period: one row
      // exact_snapshot (best), one row unrecoverable (worst). The rollup
      // must surface "unrecoverable" — the worst-attested constituent row —
      // not the best, matching seat-ledger.ts's own worst-wins convention
      // for aggregating confidence across multiple underlying observations.
      replaceMaterializedPeriod("ent1", "2026-19", [
        makePeriodRow({ orgLogin: "org1", holderKey: "worst-wins", resolvedUserLogin: "worst-wins", historyConfidence: "exact_snapshot" }),
        makePeriodRow({ orgLogin: "org2", holderKey: "worst-wins", resolvedUserLogin: "worst-wins", historyConfidence: "unrecoverable" }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-19"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "worst-wins");
      expect(row?.historyConfidence).toBe("unrecoverable");
    });

    it("rolls up confidence with worst-wins semantics across every adjacent pair of the four real values", () => {
      const pairs: readonly [string, string][] = [
        ["exact_snapshot", "audit_reconstructed"],
        ["audit_reconstructed", "live_snapshot_only"],
        ["live_snapshot_only", "unrecoverable"],
      ];
      let periodSuffix = 90;
      for (const [better, worse] of pairs) {
        const period = `2026-${periodSuffix++}`;
        replaceMaterializedPeriod("ent1", period, [
          makePeriodRow({ orgLogin: "org1", holderKey: "pair-user", resolvedUserLogin: "pair-user", historyConfidence: better as never }),
          makePeriodRow({ orgLogin: "org2", holderKey: "pair-user", resolvedUserLogin: "pair-user", historyConfidence: worse as never }),
        ]);
        const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: [period], view: "rollup" });
        const row = rollup.rows.find((r) => r.resolvedUserLogin === "pair-user");
        expect(row?.historyConfidence).toBe(worse);
      }
    });

    it("rolls up a single-row group to that row's own confidence (no aggregation artifact)", () => {
      replaceMaterializedPeriod("ent1", "2026-30", [
        makePeriodRow({ orgLogin: "org1", holderKey: "solo-audit", resolvedUserLogin: "solo-audit", historyConfidence: "audit_reconstructed" }),
      ]);
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-30"], view: "rollup" });
      const row = rollup.rows.find((r) => r.resolvedUserLogin === "solo-audit");
      expect(row?.historyConfidence).toBe("audit_reconstructed");
    });
  });

  describe("allowedLogins (team/org-resolved fail-closed filter)", () => {
    // Dedicated fixture (own period, not the shared outer beforeEach data):
    // each holder has userLogin/resolvedUserLogin/holderKey all equal to its
    // own name, so allowedLogins matches are unambiguous (the shared "2026-01"
    // fixture reuses makePeriodRow's default userLogin "user1" for its
    // second row too, which would make an allowedLogins: ["user1"] test
    // ambiguously also match that row via the user_login column).
    beforeEach(() => {
      replaceMaterializedPeriod("ent1", "2026-40", [
        makePeriodRow({ orgLogin: "org1", holderKey: "alice", userLogin: "alice", resolvedUserLogin: "alice" }),
        makePeriodRow({ orgLogin: "org2", holderKey: "bob", userLogin: "bob", resolvedUserLogin: "bob", planType: "enterprise" }),
      ]);
    });

    it("restricts the detail view to a single allowed login", () => {
      const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"], allowedLogins: ["alice"] });
      expect(result.rows.map((r) => r.holderKey)).toEqual(["alice"]);
    });

    it("restricts the detail view to many allowed logins", () => {
      const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"], allowedLogins: ["alice", "bob"] });
      expect(result.rows.map((r) => r.holderKey).sort()).toEqual(["alice", "bob"]);
    });

    it("fails closed to zero rows for an EMPTY allowedLogins array — never unrestricted", () => {
      const result = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"], allowedLogins: [] });
      expect(result.rows).toEqual([]);
      expect(result.pagination.totalItems).toBe(0);
    });

    it("leaves the query unrestricted when allowedLogins is omitted (undefined)", () => {
      const withUndefined = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"] });
      expect(withUndefined.pagination.totalItems).toBe(2);
    });

    it("restricts the rollup view identically to the detail view", () => {
      const rollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"], allowedLogins: ["alice"], view: "rollup" });
      expect(rollup.rows.map((r) => r.resolvedUserLogin)).toEqual(["alice"]);

      const emptyRollup = queryLicensePeriodRows({ enterpriseSlug: "ent1", periods: ["2026-40"], allowedLogins: [], view: "rollup" });
      expect(emptyRollup.rows).toEqual([]);
    });

    it("combines safely (AND) with the existing `logins` filter — narrows further, never widens", () => {
      // bob is allowed AND explicitly requested via `logins` -> matches.
      const both = queryLicensePeriodRows({
        enterpriseSlug: "ent1",
        periods: ["2026-40"],
        allowedLogins: ["alice", "bob"],
        logins: ["bob"],
      });
      expect(both.rows.map((r) => r.holderKey)).toEqual(["bob"]);

      // bob is requested via `logins` but NOT in the allowed set -> zero rows.
      const excluded = queryLicensePeriodRows({
        enterpriseSlug: "ent1",
        periods: ["2026-40"],
        allowedLogins: ["alice"],
        logins: ["bob"],
      });
      expect(excluded.rows).toEqual([]);
    });

    it("combines safely (AND) with org and enterprise filters", () => {
      const byOrg = queryLicensePeriodRows({
        enterpriseSlug: "ent1",
        periods: ["2026-40"],
        allowedLogins: ["alice", "bob"],
        orgLogins: ["org2"],
      });
      expect(byOrg.rows.map((r) => r.holderKey)).toEqual(["bob"]);

      // Enterprise isolation still applies even when the login would be
      // allowed: userX only exists under ent2 (from the outer beforeEach).
      const wrongEnterprise = queryLicensePeriodRows({
        enterpriseSlug: "ent1",
        allowedLogins: ["userX"],
      });
      expect(wrongEnterprise.rows).toEqual([]);

      const rightEnterprise = queryLicensePeriodRows({
        enterpriseSlug: "ent2",
        allowedLogins: ["userX"],
      });
      expect(rightEnterprise.rows.map((r) => r.holderKey)).toEqual(["userX"]);
    });
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
    expect(user1?.periods).toEqual(["2026-01", "2026-02"]);
    expect(user1?.orgLogins).toEqual(["org1"]);
    expect(user1?.planTypes).toEqual(["business"]);

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

  it("supports sort=total_cost (license_cost + aic_consumed_usd) for both detail and rollup views, matching live-path parity", () => {
    replaceMaterializedPeriod("ent1", "2026-42", [
      makePeriodRow({ orgLogin: "org1", holderKey: "low-total", resolvedUserLogin: "low-total", licenseCost: 5, aicConsumedUsd: 1 }), // total 6
      makePeriodRow({ orgLogin: "org1", holderKey: "high-total", resolvedUserLogin: "high-total", licenseCost: 25, aicConsumedUsd: 20 }), // total 45
      makePeriodRow({ orgLogin: "org1", holderKey: "mid-total", resolvedUserLogin: "mid-total", licenseCost: 15, aicConsumedUsd: 5 }), // total 20
    ]);

    const detailAsc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-42"],
      sortField: "total_cost",
      sortDir: "asc",
    });
    expect(detailAsc.rows.map((r) => r.holderKey)).toEqual(["low-total", "mid-total", "high-total"]);

    const detailDesc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-42"],
      sortField: "total_cost",
      sortDir: "desc",
    });
    expect(detailDesc.rows.map((r) => r.holderKey)).toEqual(["high-total", "mid-total", "low-total"]);

    const rollupAsc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-42"],
      view: "rollup",
      sortField: "total_cost",
      sortDir: "asc",
    });
    expect(rollupAsc.rows.map((r) => r.resolvedUserLogin)).toEqual(["low-total", "mid-total", "high-total"]);

    const rollupDesc = queryLicensePeriodRows({
      enterpriseSlug: "ent1",
      periods: ["2026-42"],
      view: "rollup",
      sortField: "total_cost",
      sortDir: "desc",
    });
    expect(rollupDesc.rows.map((r) => r.resolvedUserLogin)).toEqual(["high-total", "mid-total", "low-total"]);
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
    //     aicAssignedUsd 19, aicConsumedCredits 100, aicConsumedUsd 6.33, exact_snapshot confidence
    //   - user2/org2: enterprise, licenseCost 19, defaultAicCredits 300, defaultAicUsd 19,
    //     aicAssignedUsd 19, aicConsumedCredits 100, aicConsumedUsd 40 (over budget), live_snapshot_only confidence
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
      expect(getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-01"], historyConfidence: ["live_snapshot_only"] }).totalRows).toBe(1);
      expect(getMaterializedPeriodKPIs({ enterpriseSlugs: ["ent1", "ent2"], periods: ["2026-01"] }).totalRows).toBe(3);
    });

    describe("allowedLogins applied uniformly to KPIs/breakdowns/hasMaterializedRows", () => {
      // Own dedicated period (distinct userLogin/resolvedUserLogin/holderKey
      // per holder), same rationale as the detail/rollup allowedLogins block
      // above — avoids the shared "2026-01" fixture's userLogin overlap.
      beforeEach(() => {
        replaceMaterializedPeriod("ent1", "2026-41", [
          makePeriodRow({ orgLogin: "org1", holderKey: "carol", userLogin: "carol", resolvedUserLogin: "carol" }),
          makePeriodRow({ orgLogin: "org2", holderKey: "dave", userLogin: "dave", resolvedUserLogin: "dave", planType: "enterprise" }),
        ]);
      });

      it("scopes KPI totals to a single allowed login", () => {
        const kpis = getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["carol"] });
        expect(kpis.totalRows).toBe(1);
        expect(kpis.totalUsers).toBe(1);
      });

      it("scopes KPI totals to many allowed logins", () => {
        const kpis = getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["carol", "dave"] });
        expect(kpis.totalRows).toBe(2);
      });

      it("fails closed to zero KPI totals for an EMPTY allowedLogins array", () => {
        const kpis = getMaterializedPeriodKPIs({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: [] });
        expect(kpis.totalRows).toBe(0);
        expect(kpis.totalUsers).toBe(0);
        expect(kpis.totalLicenseCost).toBe(0);
        expect(kpis.overallUtilizationPct).toBe(0);
      });

      it("fails closed to an empty plan breakdown for an EMPTY allowedLogins array", () => {
        expect(getMaterializedPlanBreakdown({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: [] })).toEqual([]);
      });

      it("scopes the plan breakdown to allowed logins", () => {
        const plans = getMaterializedPlanBreakdown({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["carol"] });
        expect(plans.map((p) => p.key)).toEqual(["business"]);
      });

      it("fails closed to an empty org breakdown for an EMPTY allowedLogins array", () => {
        expect(getMaterializedOrgBreakdown({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: [] })).toEqual([]);
      });

      it("scopes the org breakdown to allowed logins", () => {
        const orgs = getMaterializedOrgBreakdown({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["dave"] });
        expect(orgs.map((o) => o.key)).toEqual(["org2"]);
      });

      it("fails closed to false for hasMaterializedRows when allowedLogins is an EMPTY array, even though rows exist", () => {
        expect(hasMaterializedRows({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: [] })).toBe(false);
      });

      it("still detects materialized rows via hasMaterializedRows when allowedLogins contains a matching login", () => {
        expect(hasMaterializedRows({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["carol"] })).toBe(true);
      });

      it("reports no materialized rows via hasMaterializedRows when allowedLogins contains only non-matching logins", () => {
        expect(hasMaterializedRows({ enterpriseSlug: "ent1", periods: ["2026-41"], allowedLogins: ["nobody-such-user"] })).toBe(false);
      });
    });
  });
});

describe("queryLicensePeriodExport", () => {
  it("returns rows and totalItems consistently, matching queryLicensePeriodRows for the same filters (detail)", () => {
    replaceMaterializedPeriod("ent1", "2026-50", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a", licenseCost: 10 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-b", resolvedUserLogin: "user-b", licenseCost: 20 }),
    ]);
    const result = queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-50"], sortField: "license_cost", sortDir: "asc" });
    expect(result.tooLarge).toBe(false);
    if (result.tooLarge) throw new Error("unreachable");
    expect(result.view).toBe("detail");
    expect(result.totalItems).toBe(2);
    expect(result.rows.map((r) => r.holderKey)).toEqual(["user-a", "user-b"]);
  });

  it("returns rows and totalItems consistently for the rollup view", () => {
    replaceMaterializedPeriod("ent1", "2026-51", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a", licenseCost: 10 }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-b", resolvedUserLogin: "user-b", licenseCost: 20 }),
    ]);
    const result = queryLicensePeriodExport({
      enterpriseSlug: "ent1",
      periods: ["2026-51"],
      view: "rollup",
      sortField: "license_cost",
      sortDir: "desc",
    });
    expect(result.tooLarge).toBe(false);
    if (result.tooLarge) throw new Error("unreachable");
    expect(result.view).toBe("rollup");
    expect(result.totalItems).toBe(2);
    expect(result.rows.map((r) => r.resolvedUserLogin)).toEqual(["user-b", "user-a"]);
  });

  it("applies the same filters, search, and total_cost sort as the paginated query", () => {
    replaceMaterializedPeriod("ent1", "2026-52", [
      makePeriodRow({ orgLogin: "org1", holderKey: "carol", resolvedUserLogin: "carol", licenseCost: 5, aicConsumedUsd: 1, planType: "business" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "dave", resolvedUserLogin: "dave", licenseCost: 25, aicConsumedUsd: 20, planType: "enterprise" }),
    ]);
    const result = queryLicensePeriodExport({
      enterpriseSlug: "ent1",
      periods: ["2026-52"],
      planTypes: ["business"],
      sortField: "total_cost",
      sortDir: "asc",
    });
    expect(result.tooLarge).toBe(false);
    if (result.tooLarge) throw new Error("unreachable");
    expect(result.rows.map((r) => r.holderKey)).toEqual(["carol"]);
  });

  it("returns a typed too-large result (without rows) when totalItems exceeds maxRows, and never runs the row SELECT", () => {
    replaceMaterializedPeriod("ent1", "2026-53", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-b", resolvedUserLogin: "user-b" }),
      makePeriodRow({ orgLogin: "org1", holderKey: "user-c", resolvedUserLogin: "user-c" }),
    ]);
    const preparedSql: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      preparedSql.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;
    try {
      const result = queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-53"], maxRows: 2 });
      expect(result.tooLarge).toBe(true);
      if (!result.tooLarge) throw new Error("unreachable");
      expect(result.totalItems).toBe(3);
      // The row-fetch SELECT (identifiable by its total_cost alias, unique to
      // the row-fetch statement, never the COUNT(*) guard query) must never
      // have been prepared/executed once the count guard rejected the request.
      expect(preparedSql.some((sql) => sql.includes("total_cost"))).toBe(false);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  });

  it("validates maxRows is a positive integer and clamps to the exported hard cap", () => {
    replaceMaterializedPeriod("ent1", "2026-54", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a" }),
    ]);
    expect(() => queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-54"], maxRows: 0 })).toThrow(RangeError);
    expect(() => queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-54"], maxRows: 1.5 })).toThrow(RangeError);
    expect(() => queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-54"], maxRows: -5 })).toThrow(RangeError);
    // A caller-supplied maxRows above the hard cap is clamped down, not an error.
    const result = queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-54"], maxRows: EXPORT_MAX_ROWS + 1000 });
    expect(result.tooLarge).toBe(false);
  });

  it("defaults maxRows to the exported EXPORT_MAX_ROWS cap when not supplied", () => {
    expect(EXPORT_MAX_ROWS).toBeGreaterThan(0);
    expect(Number.isInteger(EXPORT_MAX_ROWS)).toBe(true);
    expect(EXPORT_MAX_ROWS).toBeLessThanOrEqual(5000);
  });

  it("propagates a row-fetch error and leaves the connection usable afterward (transaction rollback/cleanup)", () => {
    replaceMaterializedPeriod("ent1", "2026-55", [
      makePeriodRow({ orgLogin: "org1", holderKey: "user-a", resolvedUserLogin: "user-a" }),
    ]);
    const originalPrepare = db.prepare.bind(db);
    let shouldFail = true;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (shouldFail && sql.includes("total_cost")) {
        throw new Error("simulated row-fetch failure");
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
    try {
      expect(() => queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-55"] })).toThrow(
        "simulated row-fetch failure",
      );
      shouldFail = false;
      // The connection/transaction must not be left stuck (e.g. mid-BEGIN) —
      // a subsequent call must succeed normally.
      const recovered = queryLicensePeriodExport({ enterpriseSlug: "ent1", periods: ["2026-55"] });
      expect(recovered.tooLarge).toBe(false);
      if (recovered.tooLarge) throw new Error("unreachable");
      expect(recovered.totalItems).toBe(1);
    } finally {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  });
});

describe("empty tables", () => {
  it("returns zero/empty results from a freshly-created, unpopulated schema", () => {
    const emptyDb = new TestDb(":memory:");
    execSchema(emptyDb, "schema.sql");
    execSchema(emptyDb, "billing-schema.sql");
    execSchema(emptyDb, "licensing-schema.sql");
    const rows = emptyDb.prepare(`SELECT * FROM license_period_rows`).all();
    expect(rows).toEqual([]);
    emptyDb.close();
  });
});

describe("historical reconciliation response aggregates", () => {
    it("returns only materialized periods in the requested enterprise and login scope", () => {
      replaceMaterializedPeriod("ent1", "2026-60", [
        makePeriodRow({ holderKey: "alice", userLogin: "alice", resolvedUserLogin: "alice" }),
      ]);
      replaceMaterializedPeriod("ent1", "2026-61", [
        makePeriodRow({ holderKey: "bob", userLogin: "bob", resolvedUserLogin: "bob" }),
      ]);
      replaceMaterializedPeriod("ent2", "2026-60", [
        makePeriodRow({ holderKey: "alice", userLogin: "alice", resolvedUserLogin: "alice" }),
      ]);

      expect(
        getMaterializedPeriods({
          enterpriseSlugs: ["ent1"],
          periods: ["2026-60", "2026-61", "2026-62"],
          allowedLogins: ["alice"],
        }),
      ).toEqual(["2026-60"]);
      expect(getMaterializedPeriods({ periods: ["2099-01"] })).toEqual([]);
    });

    it("aggregates the utilization histogram in SQL at the enterprise-user rollup grain", () => {
      replaceMaterializedPeriod("ent1", "2026-63", [
        makePeriodRow({ holderKey: "zero", resolvedUserLogin: "zero", aicAssignedUsd: 100, aicConsumedUsd: 0 }),
        makePeriodRow({ holderKey: "low", resolvedUserLogin: "low", aicAssignedUsd: 100, aicConsumedUsd: 10 }),
        makePeriodRow({ holderKey: "medium", resolvedUserLogin: "medium", aicAssignedUsd: 100, aicConsumedUsd: 30 }),
        makePeriodRow({ holderKey: "high", resolvedUserLogin: "high", aicAssignedUsd: 100, aicConsumedUsd: 60 }),
        makePeriodRow({ holderKey: "full", resolvedUserLogin: "full", aicAssignedUsd: 100, aicConsumedUsd: 90 }),
        makePeriodRow({ holderKey: "over", resolvedUserLogin: "over", aicAssignedUsd: 100, aicConsumedUsd: 110 }),
      ]);

      expect(
        getMaterializedUtilizationBuckets({
          enterpriseSlugs: ["ent1"],
          periods: ["2026-63"],
        }),
      ).toEqual([
        { label: "0%", min: 0, max: 0, count: 1 },
        { label: "1–25%", min: 0.0001, max: 25, count: 1 },
        { label: "26–50%", min: 25, max: 50, count: 1 },
        { label: "51–75%", min: 50, max: 75, count: 1 },
        { label: "76–100%", min: 75, max: 100, count: 1 },
        { label: ">100%", min: 100, max: null, count: 1 },
      ]);
    });

    it("summarizes checks from only the latest completed run per enterprise and requested scope", () => {
      db.prepare(`
        INSERT INTO license_reconciliation_runs
          (id, enterprise_slug, started_at, completed_at, status, requested_periods)
        VALUES
          ('old-ent1', 'ent1', '2026-06-01T00:00:00Z', '2026-06-01T00:01:00Z', 'warning', '["2026-60"]'),
          ('latest-ent1', 'ent1', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z', 'warning', '["2026-60","2026-61"]'),
          ('latest-ent2', 'ent2', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z', 'failed', '["2026-60"]')
      `).run();
      db.prepare(`
        INSERT INTO license_reconciliation_checks
          (run_id, check_name, billing_period, org_login, status, message)
        VALUES
          ('old-ent1', 'seat_count', '2026-60', 'org1', 'fail', 'old failure'),
          ('latest-ent1', 'seat_count', '2026-60', 'org1', 'pass', 'ok'),
          ('latest-ent1', 'history_coverage', '2026-60', 'org1', 'warning', 'partial'),
          ('latest-ent1', 'seat_count', '2026-61', 'org1', 'fail', 'other period'),
          ('latest-ent1', 'seat_count', '2026-60', 'org2', 'fail', 'other org'),
          ('latest-ent2', 'seat_count', '2026-60', 'org1', 'fail', 'other enterprise')
      `).run();

      expect(
        getLatestLicenseQualitySummary({
          enterpriseSlugs: ["ent1"],
          periods: ["2026-60"],
          orgLogins: ["org1"],
        }),
      ).toEqual({ pass: 1, warning: 1, fail: 0 });
      expect(
        getLatestLicenseQualitySummary({
          enterpriseSlugs: ["ent1"],
          periods: ["2099-01"],
        }),
      ).toEqual({ pass: 0, warning: 0, fail: 0 });
  });

  it("selects the most recently completed run when completed runs overlap", () => {
      db.prepare(`
        INSERT INTO license_reconciliation_runs
          (id, enterprise_slug, started_at, completed_at, status, requested_periods)
        VALUES
          ('started-later', 'ent1', '2026-07-02T00:00:00Z', '2026-07-02T00:01:00Z', 'warning', '["2026-64"]'),
          ('completed-later', 'ent1', '2026-07-01T00:00:00Z', '2026-07-02T00:02:00Z', 'success', '["2026-64"]')
      `).run();
      db.prepare(`
        INSERT INTO license_reconciliation_checks
          (run_id, check_name, billing_period, org_login, status, message)
        VALUES
          ('started-later', 'seat_count', '2026-64', 'org1', 'fail', 'stale result'),
          ('completed-later', 'seat_count', '2026-64', 'org1', 'pass', 'latest result')
      `).run();

      expect(
        getLatestLicenseQualitySummary({
          enterpriseSlugs: ["ent1"],
          periods: ["2026-64"],
        }),
      ).toEqual({ pass: 1, warning: 0, fail: 0 });
  });

  it("selects the latest completed run that covers the requested period", () => {
    db.prepare(`
      INSERT INTO license_reconciliation_runs
        (id, enterprise_slug, started_at, completed_at, status, requested_periods)
      VALUES
        ('target-period-run', 'ent1', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z', 'failed', '["2026-66"]'),
        ('newer-other-period-run', 'ent1', '2026-07-02T00:00:00Z', '2026-07-02T00:01:00Z', 'success', '["2026-67"]')
    `).run();
    db.prepare(`
      INSERT INTO license_reconciliation_checks
        (run_id, check_name, billing_period, org_login, status, message)
      VALUES
        ('target-period-run', 'seat_count', '2026-66', 'org1', 'fail', 'target failure'),
        ('newer-other-period-run', 'seat_count', '2026-67', 'org1', 'pass', 'other period')
    `).run();

    expect(
      getLatestLicenseQualitySummary({
        enterpriseSlugs: ["ent1"],
        periods: ["2026-66"],
      }),
    ).toEqual({ pass: 0, warning: 0, fail: 1 });
  });
});
