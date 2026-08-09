import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrateSummaryCacheClassification } from "./summary-cache-migration";

let db: Database.Database;

afterEach(() => {
  db.close();
});

/** Minimal schema mirroring the real summary-schema.sql + user_daily_metrics/team_memberships shape. */
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE user_daily_metrics (
      day TEXT NOT NULL,
      enterprise_slug TEXT NOT NULL DEFAULT '',
      user_login TEXT NOT NULL,
      totals_by_feature TEXT,
      PRIMARY KEY (day, enterprise_slug, user_login)
    );

    CREATE TABLE team_memberships (
      enterprise_slug TEXT NOT NULL DEFAULT '',
      team_slug TEXT NOT NULL,
      source TEXT NOT NULL,
      org_slug TEXT,
      team_name TEXT NOT NULL,
      user_login TEXT NOT NULL,
      PRIMARY KEY (enterprise_slug, team_slug, source, user_login)
    );

    CREATE TABLE user_period_summary (
      enterprise_slug TEXT NOT NULL DEFAULT '',
      user_login TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      active_days INTEGER DEFAULT 0,
      loc_added INTEGER DEFAULT 0,
      loc_deleted INTEGER DEFAULT 0,
      interactions INTEGER DEFAULT 0,
      code_gen INTEGER DEFAULT 0,
      code_accept INTEGER DEFAULT 0,
      acceptance_rate REAL DEFAULT 0,
      used_agent INTEGER DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (enterprise_slug, user_login, period_start, period_end)
    );

    CREATE TABLE daily_aggregate_cache (
      enterprise_slug TEXT NOT NULL DEFAULT '',
      day TEXT NOT NULL,
      total_users INTEGER DEFAULT 0,
      loc_added INTEGER DEFAULT 0,
      completion_loc_suggested INTEGER DEFAULT 0,
      completion_loc_accepted INTEGER DEFAULT 0,
      agent_loc_added INTEGER DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (enterprise_slug, day)
    );

    CREATE TABLE team_summary_cache (
      enterprise_slug TEXT NOT NULL DEFAULT '',
      team_slug TEXT NOT NULL,
      source TEXT NOT NULL,
      org_slug TEXT,
      team_name TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      total_members INTEGER DEFAULT 0,
      overall_acceptance_rate REAL DEFAULT 0,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (enterprise_slug, team_slug, source, period_start, period_end)
    );

    CREATE TABLE summary_cache_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

/** Legacy totals_by_feature set: completion rows plus huge copilot_app/chat_inline/unknown rows. */
function legacyFeatureSet(): string {
  return JSON.stringify([
    { feature: "code_completion", code_generation_activity_count: 20, code_acceptance_activity_count: 15, loc_added_sum: 80, loc_suggested_to_add_sum: 100, loc_deleted_sum: 0, loc_suggested_to_delete_sum: 0 },
    // These must NOT enter completion acceptance — deliberately huge to expose leakage.
    { feature: "copilot_app", code_generation_activity_count: 9999, code_acceptance_activity_count: 9999, loc_added_sum: 5000, loc_suggested_to_add_sum: 5000, loc_deleted_sum: 0, loc_suggested_to_delete_sum: 0 },
    { feature: "chat_inline", code_generation_activity_count: 8888, code_acceptance_activity_count: 8888, loc_added_sum: 4000, loc_suggested_to_add_sum: 4000, loc_deleted_sum: 0, loc_suggested_to_delete_sum: 0 },
    { feature: "some_future_unknown_feature", code_generation_activity_count: 7777, code_acceptance_activity_count: 7777, loc_added_sum: 3000, loc_suggested_to_add_sum: 3000, loc_deleted_sum: 0, loc_suggested_to_delete_sum: 0 },
    { feature: "agent_edit", code_generation_activity_count: 5, code_acceptance_activity_count: 0, loc_added_sum: 500, loc_suggested_to_add_sum: 0, loc_deleted_sum: 200, loc_suggested_to_delete_sum: 0 },
  ]);
}

describe("migrateSummaryCacheClassification — user_period_summary", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("corrects a legacy acceptance_rate computed under the old feature != 'agent_edit' semantics", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());

    // Legacy row: acceptance_rate was computed as (15+9999+8888+7777) / (20+9999+8888+7777) * 100 ≈ 100,
    // instead of the correct completion-only 15/20 = 75.
    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev1", "2024-01-01", "2024-01-01", 99.9, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const row = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev1'`
    ).get() as { acceptance_rate: number };
    expect(row.acceptance_rate).toBe(75);
  });

  it("leaves unrelated cached columns unchanged", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, active_days, loc_added, loc_deleted, interactions, code_gen, code_accept, acceptance_rate, used_agent, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev1", "2024-01-01", "2024-01-01", 1, 12345, 678, 9, 20, 20, 99.9, 1, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const row = db.prepare(
      `SELECT active_days, loc_added, loc_deleted, interactions, code_gen, code_accept, used_agent FROM user_period_summary WHERE user_login = 'dev1'`
    ).get() as Record<string, number>;
    expect(row).toEqual({ active_days: 1, loc_added: 12345, loc_deleted: 678, interactions: 9, code_gen: 20, code_accept: 20, used_agent: 1 });
  });

  it("leaves rows unchanged when there is no matching totals_by_feature data for the period", () => {
    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev-no-data", "2024-01-01", "2024-01-01", 42, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const row = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev-no-data'`
    ).get() as { acceptance_rate: number };
    expect(row.acceptance_rate).toBe(42);
  });
});

describe("migrateSummaryCacheClassification — daily_aggregate_cache", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("corrects legacy completion_loc_suggested/completion_loc_accepted in place", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO daily_aggregate_cache (enterprise_slug, day, total_users, loc_added, completion_loc_suggested, completion_loc_accepted, agent_loc_added, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ent1", "2024-01-01", 1, 99999, 12100, 26279, 500, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const row = db.prepare(
      `SELECT completion_loc_suggested, completion_loc_accepted, agent_loc_added, loc_added, total_users FROM daily_aggregate_cache WHERE day = '2024-01-01'`
    ).get() as Record<string, number>;
    // Strict completion-only: loc_suggested_to_add_sum=100, loc_added_sum=80.
    expect(row.completion_loc_suggested).toBe(100);
    expect(row.completion_loc_accepted).toBe(80);
    // agent_loc_added is out of scope for this migration — left unchanged.
    expect(row.agent_loc_added).toBe(500);
    // Unrelated columns unchanged.
    expect(row.loc_added).toBe(99999);
    expect(row.total_users).toBe(1);
  });
});

describe("migrateSummaryCacheClassification — team_summary_cache", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("corrects legacy overall_acceptance_rate in place", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO team_memberships (enterprise_slug, team_slug, source, org_slug, team_name, user_login) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "team-a", "org", "my-org", "Team A", "dev1");
    db.prepare(
      `INSERT INTO team_summary_cache (enterprise_slug, team_slug, source, org_slug, team_name, period_start, period_end, total_members, overall_acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ent1", "team-a", "org", "my-org", "Team A", "2024-01-01", "2024-01-01", 1, 99.9, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const row = db.prepare(
      `SELECT overall_acceptance_rate, total_members FROM team_summary_cache WHERE team_slug = 'team-a'`
    ).get() as { overall_acceptance_rate: number; total_members: number };
    expect(row.overall_acceptance_rate).toBe(75);
    expect(row.total_members).toBe(1); // unrelated column unchanged
  });
});

describe("migrateSummaryCacheClassification — idempotency and ledger", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("records the migration marker only after a successful run", () => {
    migrateSummaryCacheClassification(db);
    const row = db.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(row).toBeTruthy();
  });

  it("is idempotent: a second run does not reclobber a subsequently-recomputed value", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev1", "2024-01-01", "2024-01-01", 99.9, "2024-01-01T00:00:00.000Z");

    migrateSummaryCacheClassification(db);

    const afterFirstRun = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev1'`
    ).get() as { acceptance_rate: number };
    expect(afterFirstRun.acceptance_rate).toBe(75);

    // Simulate a normal refresh (e.g. from a later sync) explicitly setting a
    // new, different value. A second migration run must NOT recompute/clobber
    // this — the ledger should make it a pure no-op.
    db.prepare(`UPDATE user_period_summary SET acceptance_rate = 33.3 WHERE user_login = 'dev1'`).run();

    migrateSummaryCacheClassification(db);

    const afterSecondRun = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev1'`
    ).get() as { acceptance_rate: number };
    expect(afterSecondRun.acceptance_rate).toBe(33.3);

    const markerCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get() as { cnt: number };
    expect(markerCount.cnt).toBe(1);
  });

  it("is safe (no-op, no throw) when the ledger table is missing", () => {
    const bareDb = new Database(":memory:");
    expect(() => migrateSummaryCacheClassification(bareDb)).not.toThrow();
    bareDb.close();
  });

  it("is safe (no-op, no throw) when the cache/source tables are missing", () => {
    const bareDb = new Database(":memory:");
    bareDb.exec(`CREATE TABLE summary_cache_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    expect(() => migrateSummaryCacheClassification(bareDb)).not.toThrow();
    const row = bareDb.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(row).toBeTruthy();
    bareDb.close();
  });

  it("is safe (no-op, no throw) when the cache tables are empty", () => {
    // Schema exists but no rows at all — must safely mark complete.
    expect(() => migrateSummaryCacheClassification(db)).not.toThrow();
    const row = db.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(row).toBeTruthy();
  });
});

describe("migrateSummaryCacheClassification — malformed totals_by_feature JSON", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
  });

  it("does not throw and still applies the ledger marker when a legacy row has malformed JSON (user_period_summary)", () => {
    // Malformed row alongside a well-formed row for a different user.
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev-bad", "{not valid json");
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());

    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev-bad", "2024-01-01", "2024-01-01", 42, "2024-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO user_period_summary (enterprise_slug, user_login, period_start, period_end, acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "dev1", "2024-01-01", "2024-01-01", 99.9, "2024-01-01T00:00:00.000Z");

    expect(() => migrateSummaryCacheClassification(db)).not.toThrow();

    // Malformed row left untouched (treated as if it had no matching data).
    const badRow = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev-bad'`
    ).get() as { acceptance_rate: number };
    expect(badRow.acceptance_rate).toBe(42);

    // Well-formed row is still correctly recomputed.
    const goodRow = db.prepare(
      `SELECT acceptance_rate FROM user_period_summary WHERE user_login = 'dev1'`
    ).get() as { acceptance_rate: number };
    expect(goodRow.acceptance_rate).toBe(75);

    const marker = db.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(marker).toBeTruthy();
  });

  it("does not throw and still recomputes valid rows when a legacy row has malformed JSON (daily_aggregate_cache)", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev-bad", "[{broken");
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO daily_aggregate_cache (enterprise_slug, day, total_users, loc_added, completion_loc_suggested, completion_loc_accepted, agent_loc_added, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ent1", "2024-01-01", 2, 99999, 12100, 26279, 500, "2024-01-01T00:00:00.000Z");

    expect(() => migrateSummaryCacheClassification(db)).not.toThrow();

    const row = db.prepare(
      `SELECT completion_loc_suggested, completion_loc_accepted FROM daily_aggregate_cache WHERE day = '2024-01-01'`
    ).get() as Record<string, number>;
    expect(row.completion_loc_suggested).toBe(100);
    expect(row.completion_loc_accepted).toBe(80);

    const marker = db.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(marker).toBeTruthy();
  });

  it("does not throw and still recomputes valid rows when a legacy row has malformed JSON (team_summary_cache)", () => {
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev-bad", "totally not json");
    db.prepare(
      `INSERT INTO user_daily_metrics (day, enterprise_slug, user_login, totals_by_feature) VALUES (?, ?, ?, ?)`
    ).run("2024-01-01", "ent1", "dev1", legacyFeatureSet());
    db.prepare(
      `INSERT INTO team_memberships (enterprise_slug, team_slug, source, org_slug, team_name, user_login) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "team-a", "org", "my-org", "Team A", "dev-bad");
    db.prepare(
      `INSERT INTO team_memberships (enterprise_slug, team_slug, source, org_slug, team_name, user_login) VALUES (?, ?, ?, ?, ?, ?)`
    ).run("ent1", "team-a", "org", "my-org", "Team A", "dev1");
    db.prepare(
      `INSERT INTO team_summary_cache (enterprise_slug, team_slug, source, org_slug, team_name, period_start, period_end, total_members, overall_acceptance_rate, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("ent1", "team-a", "org", "my-org", "Team A", "2024-01-01", "2024-01-01", 2, 99.9, "2024-01-01T00:00:00.000Z");

    expect(() => migrateSummaryCacheClassification(db)).not.toThrow();

    const row = db.prepare(
      `SELECT overall_acceptance_rate FROM team_summary_cache WHERE team_slug = 'team-a'`
    ).get() as { overall_acceptance_rate: number };
    expect(row.overall_acceptance_rate).toBe(75);

    const marker = db.prepare(
      `SELECT name FROM summary_cache_migrations WHERE name = 'summary-cache-completion-classification-v1'`
    ).get();
    expect(marker).toBeTruthy();
  });
});
