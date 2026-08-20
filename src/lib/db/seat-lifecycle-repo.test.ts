import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

/**
 * Minimal facade over Node's built-in `node:sqlite` matching the small
 * `SqliteDatabase` surface the repo uses. This runs the production SQL against
 * a real in-process SQLite engine — it is not a mock of query results.
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
      run: (...params: unknown[]) => {
        const result = stmt.run(...(params as never[]));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
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

import {
  recordSeatLifecycleEvents,
  backfillOnboardingFromSeats,
  projectAuditEventsToLifecycle,
  diffSeatSnapshot,
  getSeatSnapshotForDiff,
  markSeatLifecycleTrackingStarted,
  getSeatLifecycleStats,
  getSeatLifecycleTrend,
  getSeatLifecycleRows,
  getSeatLifecycleCoverage,
  getSeatLifecycleExportRows,
  toEventDate,
  type SeatSnapshotEntry,
} from "./seat-lifecycle-repo";

function insertSeat(overrides: Record<string, unknown> = {}) {
  const seat = {
    enterprise_slug: "ent1",
    org_slug: "org1",
    user_login: "dev1",
    user_id: 1,
    plan_type: "business",
    last_activity_at: "2026-06-20T00:00:00Z",
    last_activity_editor: "vscode",
    last_authenticated_at: null,
    assigning_team_slug: null,
    assigning_team_name: null,
    pending_cancellation_date: null,
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
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

function insertAuditEvent(overrides: Record<string, unknown> = {}) {
  const event = {
    enterprise_slug: "ent1",
    event_id: `evt-${Math.random()}`,
    org_login: "org1",
    action: "assign",
    occurred_at: "2026-06-10T00:00:00Z",
    github_user_id: 1,
    observed_login: "dev1",
    external_identity: null,
    assigned_via: "direct",
    source: "audit_log",
    raw_json: null,
    ...overrides,
  };
  db.prepare(
    `INSERT OR REPLACE INTO license_audit_events
     (enterprise_slug, event_id, org_login, action, occurred_at, github_user_id,
      observed_login, external_identity, assigned_via, source, raw_json)
     VALUES (@enterprise_slug, @event_id, @org_login, @action, @occurred_at, @github_user_id,
      @observed_login, @external_identity, @assigned_via, @source, @raw_json)`,
  ).run(event);
}

function insertIdentityRecord(overrides: Record<string, unknown> = {}) {
  const record = {
    enterprise_slug: "ent1",
    identity_key: `id:${overrides.github_user_id ?? 1}`,
    github_user_id: 1,
    resolved_login: "resolved-user",
    external_identity: null,
    account_state: "member",
    resolution_source: "enterprise_identity",
    observed_at: "2026-06-20T00:00:00Z",
    ...overrides,
  };
  db.prepare(
    `INSERT OR REPLACE INTO license_identity_records
     (enterprise_slug, identity_key, github_user_id, resolved_login, external_identity,
      account_state, resolution_source, observed_at)
     VALUES (@enterprise_slug, @identity_key, @github_user_id, @resolved_login, @external_identity,
      @account_state, @resolution_source, @observed_at)`,
  ).run(record);
}

function insertPeriodRow(overrides: Record<string, unknown> = {}) {
  const row = {
    enterprise_slug: "ent1",
    billing_period: "2026-06",
    org_login: "org1",
    holder_key: `id:${overrides.github_user_id ?? 1}`,
    github_user_id: 1,
    resolved_user_login: "period-user",
    identity_resolution_source: "audit",
    seat_status: "active",
    assigned_via: "direct",
    aic_assigned_rule: "none",
    row_source: "test",
    history_confidence: "high",
    as_of_utc: "2026-06-20T00:00:00Z",
    generated_at_utc: "2026-06-20T00:00:00Z",
    ...overrides,
  };
  db.prepare(
    `INSERT OR REPLACE INTO license_period_rows
     (enterprise_slug, billing_period, org_login, holder_key, github_user_id,
      resolved_user_login, identity_resolution_source, seat_status, assigned_via,
      aic_assigned_rule, row_source, history_confidence, as_of_utc, generated_at_utc)
     VALUES (@enterprise_slug, @billing_period, @org_login, @holder_key, @github_user_id,
      @resolved_user_login, @identity_resolution_source, @seat_status, @assigned_via,
      @aic_assigned_rule, @row_source, @history_confidence, @as_of_utc, @generated_at_utc)`,
  ).run(row);
}

const WINDOW = { start: "2026-06-01", end: "2026-06-30" };
const PAGE = { page: 1, pageSize: 50, sort: "event_date", sortDir: "desc" as const };

beforeAll(() => {
  db = new TestDb(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "schema.sql"), "utf-8"));
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "licensing-schema.sql"), "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM copilot_seats");
  db.exec("DELETE FROM copilot_seat_lifecycle_events");
  db.exec("DELETE FROM copilot_seat_lifecycle_coverage");
  db.exec("DELETE FROM license_audit_events");
  db.exec("DELETE FROM license_identity_records");
  db.exec("DELETE FROM license_period_rows");
});

describe("toEventDate", () => {
  it("reduces an ISO timestamp to the day grain", () => {
    expect(toEventDate("2026-06-15T13:45:00.000Z")).toBe("2026-06-15");
  });

  it("passes through a value that is already day-grained", () => {
    expect(toEventDate("2026-06-15")).toBe("2026-06-15");
  });
});

describe("diffSeatSnapshot", () => {
  const seat = (orgSlug: string, userLogin: string): SeatSnapshotEntry => ({
    orgSlug,
    userLogin,
    userId: 1,
    planType: "business",
  });

  it("emits an offboarded event for a seat present before but absent after", () => {
    const events = diffSeatSnapshot(
      [seat("org1", "gone"), seat("org1", "stays")],
      [seat("org1", "stays")],
      "2026-06-20T00:00:00Z",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userLogin: "gone",
      eventType: "offboarded",
      source: "sync_diff",
      occurredAt: "2026-06-20T00:00:00Z",
    });
  });

  it("emits nothing when the snapshot is unchanged", () => {
    const before = [seat("org1", "a"), seat("org2", "b")];
    expect(diffSeatSnapshot(before, [...before], "2026-06-20T00:00:00Z")).toEqual([]);
  });

  it("treats the same login in a different org as a distinct seat", () => {
    const events = diffSeatSnapshot(
      [seat("org1", "dev"), seat("org2", "dev")],
      [seat("org1", "dev")],
      "2026-06-20T00:00:00Z",
    );
    expect(events).toHaveLength(1);
    expect(events[0].orgSlug).toBe("org2");
  });

  it("matches logins case-insensitively so a casing change is not a false offboard", () => {
    const events = diffSeatSnapshot(
      [seat("org1", "DevOne")],
      [seat("ORG1", "devone")],
      "2026-06-20T00:00:00Z",
    );
    expect(events).toEqual([]);
  });

  it("never reports offboards for an org outside the diff scope (a failed org fetch)", () => {
    // org2's fetch failed, so its seats are absent from `current`. Excluding it
    // from scope is what prevents a mass false offboarding.
    const events = diffSeatSnapshot(
      [seat("org1", "gone"), seat("org2", "untouched-a"), seat("org2", "untouched-b")],
      [],
      "2026-06-20T00:00:00Z",
      ["org1"],
    );
    expect(events).toHaveLength(1);
    expect(events[0].userLogin).toBe("gone");
  });

  it("carries seat metadata onto the offboarded event", () => {
    const events = diffSeatSnapshot(
      [{
        orgSlug: "org1",
        userLogin: "gone",
        userId: 42,
        planType: "enterprise",
        assigningTeamSlug: "team-a",
        assigningTeamName: "Team A",
        lastActivityAt: "2026-06-01T00:00:00Z",
      }],
      [],
      "2026-06-20T00:00:00Z",
    );
    expect(events[0]).toMatchObject({
      userId: 42,
      planType: "enterprise",
      assigningTeamSlug: "team-a",
      assigningTeamName: "Team A",
      lastActivityAt: "2026-06-01T00:00:00Z",
    });
  });
});

describe("backfillOnboardingFromSeats", () => {
  it("derives onboarded events from copilot_seats.created_at", () => {
    insertSeat({ user_login: "dev1", created_at: "2026-06-15T09:00:00Z" });
    expect(backfillOnboardingFromSeats("ent1")).toBe(1);

    const { rows } = getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_login: "dev1",
      event_date: "2026-06-15",
      source: "seat_created_at",
    });
  });

  it("is idempotent across repeated runs", () => {
    insertSeat({ user_login: "dev1" });
    backfillOnboardingFromSeats("ent1");
    backfillOnboardingFromSeats("ent1");
    backfillOnboardingFromSeats("ent1");
    expect(getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).total).toBe(1);
  });

  it("skips seats with a null created_at rather than writing a bogus date", () => {
    insertSeat({ user_login: "no-date", created_at: null });
    insertSeat({ user_login: "dated", created_at: "2026-06-15T00:00:00Z" });
    backfillOnboardingFromSeats("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["dated"]);
  });

  it("skips seats with a malformed created_at", () => {
    insertSeat({ user_login: "bad", created_at: "not-a-date" });
    backfillOnboardingFromSeats("ent1");
    expect(getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).total).toBe(0);
  });

  it("only backfills the requested enterprise when one is given", () => {
    insertSeat({ enterprise_slug: "ent1", user_login: "a" });
    insertSeat({ enterprise_slug: "ent2", user_login: "b" });
    backfillOnboardingFromSeats("ent1");

    const rows = getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).rows;
    expect(rows.map((r) => r.enterprise_slug)).toEqual(["ent1"]);
  });
});

describe("projectAuditEventsToLifecycle", () => {
  it("maps assign to onboarded and cancel to offboarded", () => {
    insertAuditEvent({ event_id: "a1", action: "assign", observed_login: "dev1", occurred_at: "2026-06-05T00:00:00Z" });
    insertAuditEvent({ event_id: "c1", action: "cancel", observed_login: "dev2", occurred_at: "2026-06-12T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");

    const stats = getSeatLifecycleStats({ ...WINDOW });
    expect(stats.onboardedUsers).toBe(1);
    expect(stats.offboardedUsers).toBe(1);
  });

  it("enriches audit rows with seat metadata using a case-insensitive login join", () => {
    insertSeat({ user_login: "DevOne", plan_type: "enterprise", assigning_team_name: "Team A" });
    insertAuditEvent({ event_id: "a1", action: "assign", observed_login: "devone", occurred_at: "2026-06-05T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");

    const row = getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).rows[0];
    expect(row.plan_type).toBe("enterprise");
    expect(row.assigning_team_name).toBe("Team A");
  });

  it("keeps distinct audit rows when login is missing but github_user_id is present", () => {
    insertAuditEvent({
      event_id: "c1",
      action: "cancel",
      observed_login: "",
      github_user_id: 101,
      occurred_at: "2026-06-12T00:00:00Z",
    });
    insertAuditEvent({
      event_id: "c2",
      action: "cancel",
      observed_login: "",
      github_user_id: 102,
      occurred_at: "2026-06-12T00:00:00Z",
    });
    projectAuditEventsToLifecycle("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["user-101", "user-102"]);
  });

  it("skips audit rows that have no stable user identifier", () => {
    insertAuditEvent({
      event_id: "c1",
      action: "cancel",
      observed_login: "",
      github_user_id: null,
      occurred_at: "2026-06-12T00:00:00Z",
    });
    projectAuditEventsToLifecycle("ent1");

    expect(getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).total).toBe(0);
  });

  it("keeps observed_login and existing seat fallback behavior for audit rows", () => {
    insertAuditEvent({
      event_id: "c1",
      action: "cancel",
      observed_login: "observed",
      github_user_id: 101,
      occurred_at: "2026-06-12T00:00:00Z",
    });
    insertSeat({ user_login: "", user_id: 102, plan_type: "enterprise" });
    insertAuditEvent({
      event_id: "c2",
      action: "assign",
      observed_login: "",
      github_user_id: 102,
      occurred_at: "2026-06-13T00:00:00Z",
    });
    projectAuditEventsToLifecycle("ent1");

    const rows = getSeatLifecycleExportRows({ ...WINDOW }, "all").rows;
    expect(rows.map((r) => r.user_login).sort()).toEqual(["", "observed"]);
    expect(rows.find((r) => r.user_login === "")?.plan_type).toBe("enterprise");
  });

  it("is idempotent across repeated runs", () => {
    insertAuditEvent({ event_id: "a1", action: "assign", occurred_at: "2026-06-05T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");
    projectAuditEventsToLifecycle("ent1");
    expect(getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).total).toBe(1);
  });

  it("ignores actions that are not assign or cancel", () => {
    insertAuditEvent({ event_id: "x1", action: "some_other_action", occurred_at: "2026-06-05T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");
    expect(getSeatLifecycleStats({ ...WINDOW }).onboardedEvents).toBe(0);
  });
});

describe("source precedence", () => {
  it("hides sync_diff rows for an enterprise that also has audit_log rows", () => {
    recordSeatLifecycleEvents("ent1", [{
      orgSlug: "org1", userLogin: "diff-only", eventType: "offboarded",
      occurredAt: "2026-06-18T00:00:00Z", source: "sync_diff",
    }]);
    insertAuditEvent({ event_id: "c1", action: "cancel", observed_login: "audited", occurred_at: "2026-06-12T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["audited"]);
  });

  it("serves sync_diff rows when the enterprise has no audit_log rows", () => {
    recordSeatLifecycleEvents("ent1", [{
      orgSlug: "org1", userLogin: "diff-only", eventType: "offboarded",
      occurredAt: "2026-06-18T00:00:00Z", source: "sync_diff",
    }]);
    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["diff-only"]);
  });

  it("serves sync_diff rows when audit_log rows fall after the query window", () => {
    recordSeatLifecycleEvents("ent1", [{
      orgSlug: "org1", userLogin: "diff-only", eventType: "offboarded",
      occurredAt: "2026-06-18T00:00:00Z", source: "sync_diff",
    }]);
    insertAuditEvent({
      event_id: "c1",
      action: "cancel",
      observed_login: "later-audit",
      occurred_at: "2026-07-02T00:00:00Z",
    });
    projectAuditEventsToLifecycle("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["diff-only"]);
  });

  it("applies audit_log precedence to the whole query window for an enterprise", () => {
    recordSeatLifecycleEvents("ent1", [
      {
        orgSlug: "org1", userLogin: "diff-before", eventType: "offboarded",
        occurredAt: "2026-06-05T00:00:00Z", source: "sync_diff",
      },
      {
        orgSlug: "org1", userLogin: "diff-after", eventType: "offboarded",
        occurredAt: "2026-06-20T00:00:00Z", source: "sync_diff",
      },
    ]);
    insertAuditEvent({
      event_id: "c1",
      action: "cancel",
      observed_login: "audited",
      occurred_at: "2026-06-12T00:00:00Z",
    });
    projectAuditEventsToLifecycle("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login);
    expect(logins).toEqual(["audited"]);
  });

  it("scopes the exclusion per enterprise — ent2's diff rows survive ent1's audit data", () => {
    recordSeatLifecycleEvents("ent2", [{
      orgSlug: "org9", userLogin: "ent2-user", eventType: "offboarded",
      occurredAt: "2026-06-18T00:00:00Z", source: "sync_diff",
    }]);
    insertAuditEvent({ event_id: "c1", action: "cancel", observed_login: "ent1-user", occurred_at: "2026-06-12T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");

    const logins = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows
      .map((r) => r.user_login).sort();
    expect(logins).toEqual(["ent1-user", "ent2-user"]);
  });
});

describe("getSeatLifecycleStats", () => {
  beforeEach(() => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "on1", eventType: "onboarded", occurredAt: "2026-06-05T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "on2", eventType: "onboarded", occurredAt: "2026-06-06T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "off1", eventType: "offboarded", occurredAt: "2026-06-10T00:00:00Z", source: "sync_diff" },
    ]);
  });

  it("counts onboarded and offboarded users and the net change", () => {
    const stats = getSeatLifecycleStats({ ...WINDOW });
    expect(stats.onboardedUsers).toBe(2);
    expect(stats.offboardedUsers).toBe(1);
    expect(stats.netChange).toBe(1);
  });

  it("counts a multi-org user once in user counts but twice in event counts", () => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org2", userLogin: "on1", eventType: "onboarded", occurredAt: "2026-06-05T00:00:00Z", source: "seat_created_at" },
    ]);
    const stats = getSeatLifecycleStats({ ...WINDOW });
    expect(stats.onboardedUsers).toBe(2);
    expect(stats.onboardedEvents).toBe(3);
  });

  it("excludes events outside the window", () => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "old", eventType: "onboarded", occurredAt: "2026-05-01T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "future", eventType: "onboarded", occurredAt: "2026-07-01T00:00:00Z", source: "seat_created_at" },
    ]);
    expect(getSeatLifecycleStats({ ...WINDOW }).onboardedUsers).toBe(2);
  });

  it("includes events on the exact window boundaries", () => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "first", eventType: "onboarded", occurredAt: "2026-06-01T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "last", eventType: "onboarded", occurredAt: "2026-06-30T23:59:00Z", source: "seat_created_at" },
    ]);
    expect(getSeatLifecycleStats({ ...WINDOW }).onboardedUsers).toBe(4);
  });

  it("reports churn as a percentage of the current seat population", () => {
    insertSeat({ user_login: "a" });
    insertSeat({ user_login: "b" });
    insertSeat({ user_login: "c" });
    insertSeat({ user_login: "d" });
    expect(getSeatLifecycleStats({ ...WINDOW }).churnRate).toBe(25);
  });

  it("applies allowedLogins to the churn denominator", () => {
    insertSeat({ user_login: "off1" });
    insertSeat({ user_login: "in-seat" });
    insertSeat({ user_login: "out-a" });
    insertSeat({ user_login: "out-b" });

    const stats = getSeatLifecycleStats({ ...WINDOW, allowedLogins: new Set(["OFF1", "IN-SEAT"]) });

    expect(stats.offboardedUsers).toBe(1);
    expect(stats.churnRate).toBe(50);
  });

  it("returns null churn and zero counts for an explicit empty allowedLogins scope", () => {
    insertSeat({ user_login: "off1" });
    insertSeat({ user_login: "other" });

    const stats = getSeatLifecycleStats({ ...WINDOW, allowedLogins: new Set() });

    expect(stats).toMatchObject({
      onboardedUsers: 0,
      offboardedUsers: 0,
      onboardedEvents: 0,
      offboardedEvents: 0,
      netChange: 0,
      churnRate: null,
    });
  });

  it("does not filter the churn denominator when allowedLogins is undefined", () => {
    insertSeat({ user_login: "off1" });
    insertSeat({ user_login: "b" });
    insertSeat({ user_login: "c" });
    insertSeat({ user_login: "d" });

    expect(getSeatLifecycleStats({ ...WINDOW, allowedLogins: undefined }).churnRate).toBe(25);
  });

  it("returns a null churn rate rather than 0 when there are no seats to divide by", () => {
    expect(getSeatLifecycleStats({ ...WINDOW }).churnRate).toBeNull();
  });

  it("returns zeroed stats on an empty ledger", () => {
    db.exec("DELETE FROM copilot_seat_lifecycle_events");
    const stats = getSeatLifecycleStats({ ...WINDOW });
    expect(stats).toMatchObject({ onboardedUsers: 0, offboardedUsers: 0, netChange: 0, churnRate: null });
  });
});

describe("scope filtering", () => {
  beforeEach(() => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "alice", eventType: "onboarded", occurredAt: "2026-06-05T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org2", userLogin: "bob", eventType: "onboarded", occurredAt: "2026-06-06T00:00:00Z", source: "seat_created_at" },
    ]);
    recordSeatLifecycleEvents("ent2", [
      { orgSlug: "org3", userLogin: "carol", eventType: "onboarded", occurredAt: "2026-06-07T00:00:00Z", source: "seat_created_at" },
    ]);
  });

  it("filters by enterprise", () => {
    const rows = getSeatLifecycleRows({ ...WINDOW, enterpriseSlugs: ["ent2"] }, "onboarded", PAGE).rows;
    expect(rows.map((r) => r.user_login)).toEqual(["carol"]);
  });

  it("filters by org", () => {
    const rows = getSeatLifecycleRows({ ...WINDOW, orgs: ["org2"] }, "onboarded", PAGE).rows;
    expect(rows.map((r) => r.user_login)).toEqual(["bob"]);
  });

  it("filters by allowedLogins case-insensitively", () => {
    const rows = getSeatLifecycleRows(
      { ...WINDOW, allowedLogins: new Set(["ALICE"]) },
      "onboarded",
      PAGE,
    ).rows;
    expect(rows.map((r) => r.user_login)).toEqual(["alice"]);
  });

  it("matches nothing for an explicit-but-empty allowedLogins set", () => {
    // An empty scope means "no users are in scope" — it must not silently
    // degrade into "no filter" and leak every user.
    const rows = getSeatLifecycleRows({ ...WINDOW, allowedLogins: new Set() }, "onboarded", PAGE).rows;
    expect(rows).toEqual([]);
  });
});

describe("read-time EMU login display resolution", () => {
  const dashedGuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const hexBlob = "3fa85f6457174562b3fc2c963f66afa6";

  function recordOpaqueLifecycleRow(userLogin: string, userId: number | null, enterpriseSlug = "ent1") {
    recordSeatLifecycleEvents(enterpriseSlug, [{
      orgSlug: "org1",
      userLogin,
      userId,
      eventType: "offboarded",
      occurredAt: "2026-06-12T00:00:00Z",
      source: "sync_diff",
    }]);
  }

  it("resolves a dashed-GUID login from license_identity_records", () => {
    recordOpaqueLifecycleRow(dashedGuid, 101);
    insertIdentityRecord({ github_user_id: 101, resolved_login: "real-dev" });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.user_login).toBe(dashedGuid);
    expect(row.display_login).toBe("real-dev");
    expect(row.login_resolved).toBe(true);
  });

  it("resolves a dashless 32-character hex blob from identity records", () => {
    recordOpaqueLifecycleRow(hexBlob, 102);
    insertIdentityRecord({ github_user_id: 102, resolved_login: "hex-dev" });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.display_login).toBe("hex-dev");
    expect(row.login_resolved).toBe(true);
  });

  it("resolves the user-id placeholder once identity data becomes available", () => {
    recordOpaqueLifecycleRow("user-103", 103);
    insertIdentityRecord({ github_user_id: 103, resolved_login: "placeholder-dev" });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.user_login).toBe("user-103");
    expect(row.display_login).toBe("placeholder-dev");
    expect(row.login_resolved).toBe(true);
  });

  it("leaves real GitHub logins untouched even when identity data exists", () => {
    recordOpaqueLifecycleRow("octocat", 104);
    insertIdentityRecord({ github_user_id: 104, resolved_login: "different-dev" });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.user_login).toBe("octocat");
    expect(row.display_login).toBe("octocat");
    expect(row.login_resolved).toBe(false);
  });

  it("prefers identity records over period rows and audit observations", () => {
    recordOpaqueLifecycleRow(dashedGuid, 105);
    insertIdentityRecord({ github_user_id: 105, resolved_login: "identity-wins" });
    insertPeriodRow({ github_user_id: 105, resolved_user_login: "period-loses" });
    insertAuditEvent({
      event_id: "audit-older",
      github_user_id: 105,
      observed_login: "audit-loses",
      occurred_at: "2026-06-01T00:00:00Z",
    });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.display_login).toBe("identity-wins");
    expect(row.login_resolved).toBe(true);
  });

  it("uses the most recent real audit observation when no resolved records exist", () => {
    recordOpaqueLifecycleRow(dashedGuid, 106);
    insertAuditEvent({
      event_id: "audit-old",
      github_user_id: 106,
      observed_login: "old-login",
      occurred_at: "2026-05-01T00:00:00Z",
    });
    insertAuditEvent({
      event_id: "audit-recent",
      github_user_id: 106,
      observed_login: "recent-login",
      occurred_at: "2026-06-15T00:00:00Z",
    });
    insertAuditEvent({
      event_id: "audit-opaque",
      github_user_id: 106,
      observed_login: "someone@example.com",
      occurred_at: "2026-06-20T00:00:00Z",
    });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.display_login).toBe("recent-login");
    expect(row.login_resolved).toBe(true);
  });

  it("does not promote external identities or email-shaped values into the display login", () => {
    recordOpaqueLifecycleRow(dashedGuid, 107);
    insertIdentityRecord({
      github_user_id: 107,
      resolved_login: "identity@example.com",
      external_identity: "external-real-dev",
    });
    insertPeriodRow({ github_user_id: 107, resolved_user_login: "period@example.com" });
    insertAuditEvent({
      event_id: "audit-email",
      github_user_id: 107,
      observed_login: "audit@example.com",
      occurred_at: "2026-06-15T00:00:00Z",
    });

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.display_login).toBe(dashedGuid);
    expect(row.login_resolved).toBe(false);
  });

  it("returns unresolved rows when licensing tables are absent", () => {
    recordOpaqueLifecycleRow(dashedGuid, 108);
    try {
      db.exec("DROP TABLE license_identity_records");
      db.exec("DROP TABLE license_period_rows");
      db.exec("DROP TABLE license_audit_events");

      const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

      expect(row.user_login).toBe(dashedGuid);
      expect(row.display_login).toBe(dashedGuid);
      expect(row.login_resolved).toBe(false);
    } finally {
      db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "licensing-schema.sql"), "utf-8"));
    }
  });

  it("skips resolution safely when user_id is null", () => {
    recordOpaqueLifecycleRow(dashedGuid, null);

    const row = getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows[0];

    expect(row.user_id).toBeNull();
    expect(row.display_login).toBe(dashedGuid);
    expect(row.login_resolved).toBe(false);
  });
});

describe("getSeatLifecycleRows", () => {
  beforeEach(() => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "c", eventType: "onboarded", occurredAt: "2026-06-03T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "a", eventType: "onboarded", occurredAt: "2026-06-01T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "b", eventType: "onboarded", occurredAt: "2026-06-02T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "z", eventType: "offboarded", occurredAt: "2026-06-04T00:00:00Z", source: "sync_diff" },
    ]);
  });

  it("returns only the requested event type", () => {
    expect(getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).rows.map((r) => r.user_login)).toEqual(["z"]);
  });

  it("sorts by the requested allowlisted column and direction", () => {
    const rows = getSeatLifecycleRows(
      { ...WINDOW }, "onboarded", { ...PAGE, sort: "user_login", sortDir: "asc" },
    ).rows;
    expect(rows.map((r) => r.user_login)).toEqual(["a", "b", "c"]);
  });

  it("falls back to event_date for a sort column outside the allowlist", () => {
    const rows = getSeatLifecycleRows(
      { ...WINDOW }, "onboarded", { ...PAGE, sort: "user_login; DROP TABLE copilot_seats", sortDir: "asc" },
    ).rows;
    expect(rows.map((r) => r.user_login)).toEqual(["a", "b", "c"]);
    // The injection attempt must not have executed.
    expect(() => db.prepare("SELECT COUNT(*) FROM copilot_seats").get()).not.toThrow();
  });

  it("paginates while reporting the unpaginated total", () => {
    const result = getSeatLifecycleRows(
      { ...WINDOW }, "onboarded", { page: 2, pageSize: 2, sort: "user_login", sortDir: "asc" },
    );
    expect(result.total).toBe(3);
    expect(result.rows.map((r) => r.user_login)).toEqual(["c"]);
  });
});

describe("getSeatLifecycleTrend", () => {
  it("returns one ascending point per day with a net value", () => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "a", eventType: "onboarded", occurredAt: "2026-06-02T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "b", eventType: "onboarded", occurredAt: "2026-06-02T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "c", eventType: "offboarded", occurredAt: "2026-06-02T00:00:00Z", source: "sync_diff" },
      { orgSlug: "org1", userLogin: "d", eventType: "offboarded", occurredAt: "2026-06-01T00:00:00Z", source: "sync_diff" },
    ]);
    expect(getSeatLifecycleTrend({ ...WINDOW })).toEqual([
      { day: "2026-06-01", onboarded: 0, offboarded: 1, net: -1 },
      { day: "2026-06-02", onboarded: 2, offboarded: 1, net: 1 },
    ]);
  });

  it("returns an empty array on an empty ledger", () => {
    expect(getSeatLifecycleTrend({ ...WINDOW })).toEqual([]);
  });
});

describe("getSeatLifecycleCoverage", () => {
  it("reports 'none' when nothing has been tracked", () => {
    expect(getSeatLifecycleCoverage()).toMatchObject({ source: "none", trackingStartedAt: null });
  });

  it("flags onboardingOnly when onboarding rows exist but offboarding is untracked", () => {
    insertSeat({ user_login: "dev1" });
    backfillOnboardingFromSeats("ent1");
    expect(getSeatLifecycleCoverage()).toMatchObject({ source: "none", onboardingOnly: true });
  });

  it("reports sync_diff with the tracking start once diffing has run", () => {
    markSeatLifecycleTrackingStarted("ent1", "2026-06-01T00:00:00Z");
    expect(getSeatLifecycleCoverage()).toMatchObject({
      source: "sync_diff",
      trackingStartedAt: "2026-06-01T00:00:00Z",
      onboardingOnly: false,
    });
  });

  it("prefers audit_log over sync_diff", () => {
    markSeatLifecycleTrackingStarted("ent1", "2026-06-01T00:00:00Z");
    insertAuditEvent({ event_id: "a1", action: "assign", occurred_at: "2026-06-05T00:00:00Z" });
    projectAuditEventsToLifecycle("ent1");
    expect(getSeatLifecycleCoverage().source).toBe("audit_log");
  });

  it("keeps the earliest tracking start and ignores later re-marks", () => {
    markSeatLifecycleTrackingStarted("ent1", "2026-06-01T00:00:00Z");
    markSeatLifecycleTrackingStarted("ent1", "2026-07-01T00:00:00Z");
    expect(getSeatLifecycleCoverage().trackingStartedAt).toBe("2026-06-01T00:00:00Z");
  });

  it("scopes to the requested enterprises", () => {
    markSeatLifecycleTrackingStarted("ent2", "2026-06-01T00:00:00Z");
    expect(getSeatLifecycleCoverage(["ent1"]).source).toBe("none");
    expect(getSeatLifecycleCoverage(["ent2"]).source).toBe("sync_diff");
  });
});

describe("getSeatSnapshotForDiff", () => {
  it("reads the stored snapshot for one enterprise", () => {
    insertSeat({ user_login: "a" });
    insertSeat({ user_login: "b", org_slug: "org2" });
    insertSeat({ enterprise_slug: "ent2", user_login: "c" });

    const snapshot = getSeatSnapshotForDiff("ent1");
    expect(snapshot.map((s) => s.userLogin).sort()).toEqual(["a", "b"]);
  });

  it("limits the snapshot to the requested orgs", () => {
    insertSeat({ user_login: "a", org_slug: "org1" });
    insertSeat({ user_login: "b", org_slug: "org2" });
    expect(getSeatSnapshotForDiff("ent1", ["ORG2"]).map((s) => s.userLogin)).toEqual(["b"]);
  });
});

describe("recordSeatLifecycleEvents", () => {
  it("skips events with no login or no timestamp", () => {
    const written = recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "", eventType: "onboarded", occurredAt: "2026-06-01T00:00:00Z", source: "sync_diff" },
      { orgSlug: "org1", userLogin: "ok", eventType: "onboarded", occurredAt: "", source: "sync_diff" },
      { orgSlug: "org1", userLogin: "good", eventType: "onboarded", occurredAt: "2026-06-01T00:00:00Z", source: "sync_diff" },
    ]);
    expect(written).toBe(1);
  });

  it("is idempotent for the same holder, type, date and source", () => {
    const event = {
      orgSlug: "org1", userLogin: "dev1", eventType: "offboarded" as const,
      occurredAt: "2026-06-10T08:00:00Z", source: "sync_diff" as const,
    };
    recordSeatLifecycleEvents("ent1", [event]);
    recordSeatLifecycleEvents("ent1", [{ ...event, occurredAt: "2026-06-10T22:00:00Z" }]);
    expect(getSeatLifecycleRows({ ...WINDOW }, "offboarded", PAGE).total).toBe(1);
  });

  it("keeps a re-onboarding on a later date as a separate event", () => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "dev1", eventType: "onboarded", occurredAt: "2026-06-01T00:00:00Z", source: "sync_diff" },
      { orgSlug: "org1", userLogin: "dev1", eventType: "onboarded", occurredAt: "2026-06-20T00:00:00Z", source: "sync_diff" },
    ]);
    expect(getSeatLifecycleRows({ ...WINDOW }, "onboarded", PAGE).total).toBe(2);
  });
});

describe("getSeatLifecycleExportRows", () => {
  beforeEach(() => {
    recordSeatLifecycleEvents("ent1", [
      { orgSlug: "org1", userLogin: "on1", eventType: "onboarded", occurredAt: "2026-06-05T00:00:00Z", source: "seat_created_at" },
      { orgSlug: "org1", userLogin: "off1", eventType: "offboarded", occurredAt: "2026-06-10T00:00:00Z", source: "sync_diff" },
    ]);
  });

  it("returns both event types for 'all'", () => {
    expect(getSeatLifecycleExportRows({ ...WINDOW }, "all").rows).toHaveLength(2);
  });

  it("returns a single event type when asked", () => {
    const result = getSeatLifecycleExportRows({ ...WINDOW }, "offboarded");
    expect(result.rows.map((r) => r.user_login)).toEqual(["off1"]);
    expect(result.truncated).toBe(false);
  });
});
