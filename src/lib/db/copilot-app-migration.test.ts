import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "./sqlite-database";
import { migrateCopilotAppMetrics } from "./copilot-app-migration";

let db: Database;

afterEach(() => {
  db.close();
});

/** Minimal legacy enterprise/org table shape (pre-Copilot-App columns). */
function createLegacyEnterpriseTable(database: Database): void {
  database.exec(`
    CREATE TABLE enterprise_daily_metrics (
      day TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      daily_active_users INTEGER DEFAULT 0,
      raw_json TEXT,
      PRIMARY KEY (day, enterprise_id)
    )
  `);
}

function createLegacyOrgTable(database: Database): void {
  database.exec(`
    CREATE TABLE org_daily_metrics (
      day TEXT NOT NULL,
      org_slug TEXT NOT NULL,
      daily_active_users INTEGER DEFAULT 0,
      raw_json TEXT,
      PRIMARY KEY (day, org_slug)
    )
  `);
}

function createLegacyUserTable(database: Database): void {
  database.exec(`
    CREATE TABLE user_daily_metrics (
      day TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      user_login TEXT NOT NULL,
      raw_json TEXT,
      PRIMARY KEY (day, enterprise_id, user_id)
    )
  `);
}

const SAMPLE_APP_TOTAL = {
  session_count: 2,
  request_count: 6,
  prompt_count: 3,
  token_usage: {
    output_tokens_sum: 6200,
    prompt_tokens_sum: 8600,
    avg_tokens_per_request: 2466.67,
  },
};

describe("migrateCopilotAppMetrics — enterprise aggregate", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createLegacyEnterpriseTable(db);
  });

  it("adds the missing columns to a legacy enterprise table", () => {
    migrateCopilotAppMetrics(db);
    const columns = db.prepare("PRAGMA table_info(enterprise_daily_metrics)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("daily_active_copilot_app_users");
    expect(names).toContain("totals_by_copilot_app");
  });

  it("backfills daily_active_copilot_app_users and totals_by_copilot_app from raw_json", () => {
    db.prepare(
      `INSERT INTO enterprise_daily_metrics (day, enterprise_id, daily_active_users, raw_json) VALUES (?, ?, ?, ?)`
    ).run(
      "2024-01-10",
      "ent-123",
      10,
      JSON.stringify({ daily_active_copilot_app_users: 4, totals_by_copilot_app: SAMPLE_APP_TOTAL })
    );

    migrateCopilotAppMetrics(db);

    const row = db.prepare(
      `SELECT daily_active_copilot_app_users, totals_by_copilot_app FROM enterprise_daily_metrics WHERE day = '2024-01-10'`
    ).get() as { daily_active_copilot_app_users: number | null; totals_by_copilot_app: string | null };

    expect(row.daily_active_copilot_app_users).toBe(4);
    expect(JSON.parse(row.totals_by_copilot_app as string)).toEqual(SAMPLE_APP_TOTAL);
  });
});

describe("migrateCopilotAppMetrics — organization aggregate", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createLegacyOrgTable(db);
  });

  it("adds the missing columns to a legacy org table", () => {
    migrateCopilotAppMetrics(db);
    const columns = db.prepare("PRAGMA table_info(org_daily_metrics)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("daily_active_copilot_app_users");
    expect(names).toContain("totals_by_copilot_app");
  });

  it("backfills daily_active_copilot_app_users and totals_by_copilot_app from raw_json", () => {
    db.prepare(
      `INSERT INTO org_daily_metrics (day, org_slug, daily_active_users, raw_json) VALUES (?, ?, ?, ?)`
    ).run(
      "2024-01-11",
      "my-org",
      6,
      JSON.stringify({ daily_active_copilot_app_users: 2, totals_by_copilot_app: SAMPLE_APP_TOTAL })
    );

    migrateCopilotAppMetrics(db);

    const row = db.prepare(
      `SELECT daily_active_copilot_app_users, totals_by_copilot_app FROM org_daily_metrics WHERE day = '2024-01-11'`
    ).get() as { daily_active_copilot_app_users: number | null; totals_by_copilot_app: string | null };

    expect(row.daily_active_copilot_app_users).toBe(2);
    expect(JSON.parse(row.totals_by_copilot_app as string)).toEqual(SAMPLE_APP_TOTAL);
  });
});

describe("migrateCopilotAppMetrics — user-level records", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createLegacyUserTable(db);
  });

  it("adds the missing columns to a legacy user table", () => {
    migrateCopilotAppMetrics(db);
    const columns = db.prepare("PRAGMA table_info(user_daily_metrics)").all() as { name: string }[];
    const names = columns.map((c) => c.name);
    expect(names).toContain("used_copilot_app");
    expect(names).toContain("totals_by_copilot_app");
  });

  it("backfills used_copilot_app=true and totals_by_copilot_app from raw_json", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run(
      "2024-01-12",
      "ent-123",
      1,
      "dev1",
      JSON.stringify({ used_copilot_app: true, totals_by_copilot_app: SAMPLE_APP_TOTAL })
    );

    migrateCopilotAppMetrics(db);

    const row = db.prepare(
      `SELECT used_copilot_app, totals_by_copilot_app FROM user_daily_metrics WHERE user_login = 'dev1'`
    ).get() as { used_copilot_app: number | null; totals_by_copilot_app: string | null };

    expect(row.used_copilot_app).toBe(1);
    expect(JSON.parse(row.totals_by_copilot_app as string)).toEqual(SAMPLE_APP_TOTAL);
  });

  it("preserves used_copilot_app=false (0) distinctly from legacy absence (NULL)", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run("2024-01-13", "ent-123", 2, "dev-false", JSON.stringify({ used_copilot_app: false }));
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run("2024-01-13", "ent-123", 3, "dev-legacy", JSON.stringify({ code_generation_activity_count: 1 }));

    migrateCopilotAppMetrics(db);

    const falseRow = db.prepare(
      `SELECT used_copilot_app FROM user_daily_metrics WHERE user_login = 'dev-false'`
    ).get() as { used_copilot_app: number | null };
    const legacyRow = db.prepare(
      `SELECT used_copilot_app FROM user_daily_metrics WHERE user_login = 'dev-legacy'`
    ).get() as { used_copilot_app: number | null };

    expect(falseRow.used_copilot_app).toBe(0);
    expect(legacyRow.used_copilot_app).toBeNull();
  });

  it("backfills totals_by_copilot_app even when used_copilot_app is absent from raw_json, and vice versa", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run(
      "2024-01-14",
      "ent-123",
      4,
      "totals-only",
      JSON.stringify({ totals_by_copilot_app: SAMPLE_APP_TOTAL })
    );
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run("2024-01-14", "ent-123", 5, "flag-only", JSON.stringify({ used_copilot_app: true }));

    migrateCopilotAppMetrics(db);

    const totalsOnly = db.prepare(
      `SELECT used_copilot_app, totals_by_copilot_app FROM user_daily_metrics WHERE user_login = 'totals-only'`
    ).get() as { used_copilot_app: number | null; totals_by_copilot_app: string | null };
    const flagOnly = db.prepare(
      `SELECT used_copilot_app, totals_by_copilot_app FROM user_daily_metrics WHERE user_login = 'flag-only'`
    ).get() as { used_copilot_app: number | null; totals_by_copilot_app: string | null };

    expect(totalsOnly.used_copilot_app).toBeNull();
    expect(JSON.parse(totalsOnly.totals_by_copilot_app as string)).toEqual(SAMPLE_APP_TOTAL);
    expect(flagOnly.used_copilot_app).toBe(1);
    expect(flagOnly.totals_by_copilot_app).toBeNull();
  });
});

describe("migrateCopilotAppMetrics — safety and idempotency", () => {
  it("no-ops safely when none of the target tables exist", () => {
    db = new Database(":memory:");
    expect(() => migrateCopilotAppMetrics(db)).not.toThrow();
  });

  it("no-ops safely when a target table has no raw_json column", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_daily_metrics (
        day TEXT NOT NULL,
        enterprise_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        user_login TEXT NOT NULL,
        PRIMARY KEY (day, enterprise_id, user_id)
      )
    `);
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login) VALUES (?, ?, ?, ?)`
    ).run("2024-01-15", "ent-123", 6, "no-raw-json");

    expect(() => migrateCopilotAppMetrics(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(user_daily_metrics)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("used_copilot_app");
  });

  it("is idempotent: a second invocation neither throws nor overwrites explicitly-set values", () => {
    db = new Database(":memory:");
    createLegacyUserTable(db);
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_id, user_id, user_login, raw_json) VALUES (?, ?, ?, ?, ?)`
    ).run(
      "2024-01-16",
      "ent-123",
      7,
      "dev-idempotent",
      JSON.stringify({ used_copilot_app: true, totals_by_copilot_app: SAMPLE_APP_TOTAL })
    );

    migrateCopilotAppMetrics(db);

    // Simulate a repo write explicitly clearing the flag back to false (0).
    db.prepare(
      `UPDATE user_daily_metrics SET used_copilot_app = 0 WHERE user_login = 'dev-idempotent'`
    ).run();

    expect(() => migrateCopilotAppMetrics(db)).not.toThrow();

    const row = db.prepare(
      `SELECT used_copilot_app, totals_by_copilot_app FROM user_daily_metrics WHERE user_login = 'dev-idempotent'`
    ).get() as { used_copilot_app: number | null; totals_by_copilot_app: string | null };

    // Backfill must not clobber the explicitly-set 0 back to the raw_json's true (1).
    expect(row.used_copilot_app).toBe(0);
    expect(JSON.parse(row.totals_by_copilot_app as string)).toEqual(SAMPLE_APP_TOTAL);

    const columns = db.prepare("PRAGMA table_info(user_daily_metrics)").all() as { name: string }[];
    const usedCopilotAppColumns = columns.filter((c) => c.name === "used_copilot_app");
    expect(usedCopilotAppColumns).toHaveLength(1);
  });
});
