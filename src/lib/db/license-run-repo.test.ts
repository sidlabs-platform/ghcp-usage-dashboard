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
 * logic, not a mock of query results: `license-run-repo.ts` is never
 * modified to accommodate this facade, and this facade only translates the
 * handful of better-sqlite3 API shapes (`pragma`, `.transaction`, positional
 * `?` binding) that `node:sqlite` spells slightly differently. Mirrors the
 * identical facade in `license-history-repo.test.ts` (Task 7).
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

import {
  startLicenseRun,
  finishLicenseRun,
  getLicenseRun,
  listLicenseRuns,
  deleteLicenseRun,
  replaceLicenseChecks,
  listLicenseChecks,
  updateLicenseSourceState,
  listLicenseSourceState,
  recordLicenseRunDiagnostics,
  buildLicenseRunReport,
  serializeLicenseRunReport,
  renderLicenseRunReportText,
} from "./license-run-repo";

const SCHEMA_DIR = path.join(process.cwd(), "src", "lib", "db");

function execSchema(database: TestDb, file: string): void {
  database.exec(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8"));
}

beforeAll(() => {
  db = new TestDb(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  execSchema(db, "schema.sql");
  execSchema(db, "billing-schema.sql");
  execSchema(db, "licensing-schema.sql");
  // Run twice to prove idempotency of CREATE TABLE IF NOT EXISTS.
  execSchema(db, "licensing-schema.sql");
});

afterAll(() => {
  // Optional chaining: if beforeAll threw before `db` was assigned (e.g. the
  // native binding is unavailable in this environment), this must not throw
  // a second, unrelated error that masks the real failure.
  db?.close();
});

beforeEach(() => {
  // Delete children before parents: license_reconciliation_checks has an FK
  // to license_reconciliation_runs(id) and foreign_keys=ON is set above, so
  // deleting runs first would fail with a FOREIGN KEY constraint violation
  // whenever a prior test left checks rows behind.
  db.exec("DELETE FROM license_reconciliation_checks");
  db.exec("DELETE FROM license_reconciliation_runs");
  db.exec("DELETE FROM license_source_sync_state");
});

describe("startLicenseRun / finishLicenseRun / getLicenseRun", () => {
  it("starts a run with status 'running' and persists it immediately", () => {
    const id = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01", "2026-02"] });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const run = getLicenseRun(id);
    expect(run).not.toBeNull();
    expect(run?.status).toBe("running");
    expect(run?.enterpriseSlug).toBe("ent1");
    expect(run?.requestedPeriods).toEqual(["2026-01", "2026-02"]);
    expect(run?.completedAt).toBeNull();
    expect(run?.sourceStats).toEqual({});
    expect(run?.unresolvedIdentities).toEqual([]);
    expect(run?.warnings).toEqual([]);
  });

  it("generates unique ids across runs", () => {
    const id1 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const id2 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    expect(id1).not.toBe(id2);
  });

  it("finishes a run and returns parsed typed results on read", () => {
    const id = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    finishLicenseRun(id, {
      status: "warning",
      sourceStats: { auditEvents: 12, seatSnapshots: 5 },
      unresolvedIdentities: [{ holderKey: "user9", reason: "no_login" }],
      warnings: ["org_billing_endpoint_unavailable"],
    });

    const run = getLicenseRun(id);
    expect(run?.status).toBe("warning");
    expect(run?.completedAt).not.toBeNull();
    expect(run?.sourceStats).toEqual({ auditEvents: 12, seatSnapshots: 5 });
    expect(run?.unresolvedIdentities).toEqual([{ holderKey: "user9", reason: "no_login" }]);
    expect(run?.warnings).toEqual(["org_billing_endpoint_unavailable"]);
  });

  it("serializes JSON columns deterministically regardless of key order", () => {
    const idA = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    finishLicenseRun(idA, { status: "success", sourceStats: { b: 1, a: 2 } });
    const idB = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    finishLicenseRun(idB, { status: "success", sourceStats: { a: 2, b: 1 } });

    const rawA = db.prepare(`SELECT source_stats FROM license_reconciliation_runs WHERE id = ?`).get(idA) as {
      source_stats: string;
    };
    const rawB = db.prepare(`SELECT source_stats FROM license_reconciliation_runs WHERE id = ?`).get(idB) as {
      source_stats: string;
    };
    expect(rawA.source_stats).toBe(rawB.source_stats);
  });

  it("returns null for a missing run id", () => {
    expect(getLicenseRun("does-not-exist")).toBeNull();
  });

  it("lists runs for an enterprise, most recent first, isolated by enterprise", () => {
    const id1 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"], startedAt: "2026-01-01T00:00:00Z" });
    const id2 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-02"], startedAt: "2026-02-01T00:00:00Z" });
    startLicenseRun({ enterpriseSlug: "ent2", requestedPeriods: ["2026-01"], startedAt: "2026-01-01T00:00:00Z" });

    const runs = listLicenseRuns("ent1");
    expect(runs.map((r) => r.id)).toEqual([id2, id1]);
    expect(runs.every((r) => r.enterpriseSlug === "ent1")).toBe(true);
  });

  it("returns an empty array when no runs exist for an enterprise", () => {
    expect(listLicenseRuns("no-such-enterprise")).toEqual([]);
  });

  it("throws when finishing a run with an unknown id", () => {
    expect(() => finishLicenseRun("does-not-exist", { status: "success" })).toThrow();
  });
});

describe("deleteLicenseRun", () => {
  it("cascades to delete a run's checks (ON DELETE CASCADE)", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(runId, [
      { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
    ]);
    expect(listLicenseChecks(runId)).toHaveLength(1);

    deleteLicenseRun(runId);

    expect(getLicenseRun(runId)).toBeNull();
    expect(listLicenseChecks(runId)).toEqual([]);
    // The check row itself must be gone from the table (not just unreachable
    // via listLicenseChecks), proving the FK cascade actually fired rather
    // than the row being merely orphaned.
    const remaining = db.prepare(`SELECT * FROM license_reconciliation_checks WHERE run_id = ?`).all(runId);
    expect(remaining).toEqual([]);
  });

  it("does not affect other runs' checks", () => {
    const keepRunId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const deleteRunId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(keepRunId, [{ checkName: "seat_count", status: "pass", message: "ok" }]);
    replaceLicenseChecks(deleteRunId, [{ checkName: "seat_count", status: "pass", message: "ok" }]);

    deleteLicenseRun(deleteRunId);

    expect(getLicenseRun(keepRunId)).not.toBeNull();
    expect(listLicenseChecks(keepRunId)).toHaveLength(1);
  });
});

describe("replaceLicenseChecks / listLicenseChecks", () => {
  it("replaces checks for a run (delete then insert), removing stale entries", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(runId, [
      { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
      { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "warning", message: "2 unresolved" },
    ]);
    let checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(2);

    replaceLicenseChecks(runId, [
      { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
    ]);
    checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(1);
    expect(checks[0].checkName).toBe("seat_count");
  });

  it("stores expected/actual values and details, returning parsed typed results", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(runId, [
      {
        checkName: "aic_gross_vs_net",
        billingPeriod: "2026-01",
        orgLogin: "org1",
        status: "fail",
        expectedValue: 100,
        actualValue: 106,
        message: "variance exceeds 5% tolerance",
        details: { toleranceUsed: 0.05, source: "billing_report" },
      },
    ]);
    const checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      runId,
      checkName: "aic_gross_vs_net",
      status: "fail",
      expectedValue: 100,
      actualValue: 106,
      details: { toleranceUsed: 0.05, source: "billing_report" },
    });
  });

  it("isolates checks by run id", () => {
    const run1 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const run2 = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(run1, [{ checkName: "seat_count", status: "pass", message: "ok" }]);
    replaceLicenseChecks(run2, [{ checkName: "seat_count", status: "fail", message: "mismatch" }]);
    expect(listLicenseChecks(run1)[0].status).toBe("pass");
    expect(listLicenseChecks(run2)[0].status).toBe("fail");
  });

  it("returns an empty array for a run with no checks", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    expect(listLicenseChecks(runId)).toEqual([]);
  });
});

describe("updateLicenseSourceState / listLicenseSourceState", () => {
  it("upserts source state idempotently", () => {
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-01",
      status: "ok",
      lastSyncedAt: "2026-01-31T00:00:00Z",
    });
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-01",
      status: "ok",
      lastSyncedAt: "2026-02-01T00:00:00Z",
    });
    const states = listLicenseSourceState("ent1");
    expect(states).toHaveLength(1);
    expect(states[0].lastSyncedAt).toBe("2026-02-01T00:00:00Z");
  });

  it("tracks separate state per (enterprise, source, billingPeriod)", () => {
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" });
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-02", status: "pending" });
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "identity_map", billingPeriod: "", status: "ok" });
    const states = listLicenseSourceState("ent1");
    expect(states).toHaveLength(3);
  });

  it("defaults status to 'pending' and billingPeriod to '' when omitted", () => {
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "identity_map" });
    const states = listLicenseSourceState("ent1");
    expect(states).toEqual([
      expect.objectContaining({ source: "identity_map", billingPeriod: "", status: "pending" }),
    ]);
  });

  it("performs a true partial upsert: omitted fields preserve their prior stored value", () => {
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-03",
      status: "syncing",
      lastSyncedAt: "2026-03-01T00:00:00Z",
      coverageStart: "2025-01-01",
      coverageEnd: "2026-03-31",
      errorMessage: "rate_limited",
    });

    // Partial update: only `status` is provided. lastSyncedAt/coverage/error
    // must all survive untouched — this is NOT the same as re-supplying
    // defaults, which would silently wipe them.
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-03", status: "retrying" });

    const state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-03");
    expect(state?.status).toBe("retrying");
    expect(state?.lastSyncedAt).toBe("2026-03-01T00:00:00Z");
    expect(state?.coverageStart).toBe("2025-01-01");
    expect(state?.coverageEnd).toBe("2026-03-31");
    // "retrying" isn't a success status, so the prior error must be preserved too.
    expect(state?.errorMessage).toBe("rate_limited");
  });

  it("clears error_message automatically when status is explicitly set to a success value", () => {
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-04",
      status: "error",
      errorMessage: "boom",
    });
    let state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-04");
    expect(state?.errorMessage).toBe("boom");

    // Explicit success, errorMessage omitted: must clear the stale error.
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-04", status: "ok" });
    state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-04");
    expect(state?.status).toBe("ok");
    expect(state?.errorMessage).toBeNull();
  });

  it("still lets an explicit errorMessage take precedence even alongside a success status", () => {
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-05",
      status: "ok",
      errorMessage: "partial_success_warning",
    });
    const state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-05");
    expect(state?.status).toBe("ok");
    expect(state?.errorMessage).toBe("partial_success_warning");
  });

  it("returns an empty array for missing/empty state", () => {
    expect(listLicenseSourceState("no-such-enterprise")).toEqual([]);
  });
});

describe("recordLicenseRunDiagnostics", () => {
  it("atomically finishes the run, replaces its checks, and upserts source states in one transaction", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });

    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "warning", sourceStats: { auditEvents: 3 }, warnings: ["partial_sync"] },
      checks: [
        { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
        { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "warning", message: "1 unresolved" },
      ],
      sourceStates: [
        { enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok", lastSyncedAt: "2026-02-01T00:00:00Z" },
      ],
    });

    const run = getLicenseRun(runId);
    expect(run?.status).toBe("warning");
    expect(run?.sourceStats).toEqual({ auditEvents: 3 });
    expect(run?.warnings).toEqual(["partial_sync"]);

    const checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(2);

    const states = listLicenseSourceState("ent1");
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ source: "audit_log", status: "ok", lastSyncedAt: "2026-02-01T00:00:00Z" });
  });

  it("replaces (does not append to) a run's prior checks", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(runId, [{ checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "fail", message: "stale" }]);

    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "success" },
      checks: [{ checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "fresh" }],
    });

    const checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(1);
    expect(checks[0].message).toBe("fresh");
  });

  it("performs a true partial upsert of source state, same as updateLicenseSourceState", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    updateLicenseSourceState({
      enterpriseSlug: "ent1",
      source: "audit_log",
      billingPeriod: "2026-01",
      status: "syncing",
      coverageStart: "2025-01-01",
      coverageEnd: "2026-01-31",
    });

    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "success" },
      checks: [],
      sourceStates: [{ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" }],
    });

    const state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-01");
    expect(state?.status).toBe("ok");
    expect(state?.coverageStart).toBe("2025-01-01");
    expect(state?.coverageEnd).toBe("2026-01-31");
  });

  it("rolls back the entire write (run finish + checks + source state) when finishing an unknown run id", () => {
    updateLicenseSourceState({ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "pending" });

    expect(() =>
      recordLicenseRunDiagnostics({
        runId: "does-not-exist",
        finish: { status: "success" },
        checks: [{ checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" }],
        sourceStates: [{ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" }],
      })
    ).toThrow();

    // Nothing must have been written: no checks for the non-existent run, and
    // the pre-existing source state must be untouched (still "pending").
    expect(listLicenseChecks("does-not-exist")).toEqual([]);
    const state = listLicenseSourceState("ent1").find((s) => s.billingPeriod === "2026-01");
    expect(state?.status).toBe("pending");
  });

  it("rolls back the entire write on a duplicate (checkName, billingPeriod, orgLogin) triple in the same batch", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    // Seed a pre-existing check so we can prove it survives the rollback untouched.
    replaceLicenseChecks(runId, [{ checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "pre-existing" }]);

    expect(() =>
      recordLicenseRunDiagnostics({
        runId,
        finish: { status: "success" },
        checks: [
          { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "first" },
          { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "fail", message: "duplicate" },
        ],
      })
    ).toThrow();

    // The run must still be "running" (finish never committed) and the
    // pre-existing check must be untouched — not deleted, not replaced.
    const run = getLicenseRun(runId);
    expect(run?.status).toBe("running");
    const checks = listLicenseChecks(runId);
    expect(checks).toHaveLength(1);
    expect(checks[0].message).toBe("pre-existing");
  });

  it("does not touch other runs' checks or source state", () => {
    const runA = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const runB = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    replaceLicenseChecks(runA, [{ checkName: "seat_count", status: "pass", message: "run A" }]);

    recordLicenseRunDiagnostics({
      runId: runB,
      finish: { status: "success" },
      checks: [{ checkName: "seat_count", status: "warning", message: "run B" }],
    });

    expect(listLicenseChecks(runA)).toHaveLength(1);
    expect(listLicenseChecks(runA)[0].message).toBe("run A");
    expect(listLicenseChecks(runB)).toHaveLength(1);
    expect(listLicenseChecks(runB)[0].message).toBe("run B");
  });
});

describe("buildLicenseRunReport / serializeLicenseRunReport / renderLicenseRunReportText", () => {
  it("builds a deterministic report object with sorted requested periods, sources, and checks", () => {
    const runId = startLicenseRun({
      enterpriseSlug: "ent1",
      requestedPeriods: ["2026-02", "2026-01"],
      startedAt: "2026-02-01T00:00:00.000Z",
    });
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        completedAt: "2026-02-01T00:00:05.000Z",
        sourceStats: { seatSnapshots: 10, apiRequests: 42 },
        unresolvedIdentities: [
          { holderKey: "zeta-holder", reason: "no_login" },
          { holderKey: "alpha-holder", reason: "no_login", externalIdentity: "should-be-dropped@example.com" },
        ],
        warnings: ["zeta_warning", "alpha_warning"],
      },
      checks: [
        { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "warning", message: "partial" },
        { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
      ],
      sourceStates: [
        { enterpriseSlug: "ent1", source: "seat_snapshot", billingPeriod: "2026-01", status: "ok" },
        { enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" },
      ],
    });

    const run = getLicenseRun(runId)!;
    const checks = listLicenseChecks(runId);
    const sourceStates = listLicenseSourceState("ent1");
    const report = buildLicenseRunReport(run, checks, sourceStates);

    expect(report.id).toBe(runId);
    expect(report.status).toBe("warning");
    expect(report.requestedPeriods).toEqual(["2026-01", "2026-02"]);
    expect(report.elapsedMs).toBe(5000);
    expect(report.sources.map((s) => s.source)).toEqual(["audit_log", "seat_snapshot"]);
    expect(report.checks.map((c) => c.name)).toEqual(["real_login_coverage", "seat_count"]);
    expect(report.checkCounts).toEqual({ pass: 1, warning: 1, fail: 0 });
    expect(report.warnings).toEqual(["alpha_warning", "zeta_warning"]);
  });

  it("sanitizes unresolved identities to only safe identifiers (holderKey/githubUserId/reason), dropping anything else", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        unresolvedIdentities: [
          {
            holderKey: "holder1",
            githubUserId: 42,
            reason: "no_login",
            externalIdentity: "leaked@example.com",
            samlNameId: "leaked-saml",
            token: "leaked-token",
          },
        ],
      },
      checks: [],
    });

    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);

    expect(report.unresolvedIdentities).toEqual([{ holderKey: "holder1", githubUserId: 42, reason: "no_login" }]);
    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toMatch(/leaked/);
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).not.toMatch(/leaked/);
  });

  it("sorts unresolved identities deterministically by holderKey", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        unresolvedIdentities: [
          { holderKey: "zeta", reason: "no_login" },
          { holderKey: "alpha", reason: "no_login" },
        ],
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.unresolvedIdentities.map((u) => (u as { holderKey: string }).holderKey)).toEqual(["alpha", "zeta"]);
  });

  it("produces identical serialized JSON regardless of input key/array order for equivalent data", () => {
    const runA = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01", "2026-02"] });
    recordLicenseRunDiagnostics({
      runId: runA,
      finish: { status: "success", sourceStats: { b: 1, a: 2 } },
      checks: [
        { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
        { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
      ],
    });
    const runB = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-02", "2026-01"] });
    recordLicenseRunDiagnostics({
      runId: runB,
      finish: { status: "success", sourceStats: { a: 2, b: 1 } },
      checks: [
        { checkName: "real_login_coverage", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
        { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
      ],
    });

    const reportA = buildLicenseRunReport(getLicenseRun(runA)!, listLicenseChecks(runA), []);
    const reportB = buildLicenseRunReport(getLicenseRun(runB)!, listLicenseChecks(runB), []);
    // Normalize the only intentionally-distinct field (id) before comparing.
    const serializedA = serializeLicenseRunReport({ ...reportA, id: "same", startedAt: "t", completedAt: "t", elapsedMs: 0 });
    const serializedB = serializeLicenseRunReport({ ...reportB, id: "same", startedAt: "t", completedAt: "t", elapsedMs: 0 });
    expect(serializedA).toBe(serializedB);
  });

  it("renders null elapsed and '(in progress)' completed for a still-running run", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.elapsedMs).toBeNull();
    expect(report.completedAt).toBeNull();
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).toMatch(/in progress/i);
  });

  it("renders a concise human-readable report containing all required sections", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "warning", sourceStats: { apiRequests: 7 }, warnings: ["org_billing_endpoint_unavailable"] },
      checks: [{ checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "warning", message: "small variance" }],
      sourceStates: [{ enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" }],
    });
    const run = getLicenseRun(runId)!;
    const checks = listLicenseChecks(runId);
    const sourceStates = listLicenseSourceState("ent1");
    const report = buildLicenseRunReport(run, checks, sourceStates);
    const rendered = renderLicenseRunReportText(report);

    expect(rendered).toContain(runId);
    expect(rendered).toContain("WARNING");
    expect(rendered).toContain("2026-01");
    expect(rendered).toContain("audit_log");
    expect(rendered).toContain("seat_count");
    expect(rendered).toContain("small variance");
    expect(rendered).toContain("org_billing_endpoint_unavailable");
    expect(rendered).toContain("apiRequests");
    expect(rendered).toContain("7");
  });

  it("handles empty checks/sources/warnings/unresolved-identities gracefully", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: [] });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.checks).toEqual([]);
    expect(report.sources).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.unresolvedIdentities).toEqual([]);
    expect(report.checkCounts).toEqual({ pass: 0, warning: 0, fail: 0 });
    const rendered = renderLicenseRunReportText(report);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
  });
});
