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
import { summarizeIdentityResolution, summarizeHistoryCoverage } from "../licensing/reconciliation-checks";
import type { SeatLedgerCoverage } from "../licensing/seat-ledger";

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

  it("redacts unsafe holder keys with one non-correlatable marker while safe keys pass through unchanged", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const maliciousHolderKey = "attacker@evil.com <script>alert(1)</script>";
    const differentUnsafeHolderKey = "different@example.com <external-id>";
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        unresolvedIdentities: [
          { holderKey: maliciousHolderKey, reason: "no_login" },
          { holderKey: differentUnsafeHolderKey, reason: "no_login" },
        ],
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);

    expect(report.unresolvedIdentities).toHaveLength(2);
    const sanitizedHolderKey = (report.unresolvedIdentities[0] as { holderKey: string }).holderKey;
    expect(sanitizedHolderKey).not.toBe(maliciousHolderKey);
    expect(sanitizedHolderKey).not.toContain("attacker");
    expect(sanitizedHolderKey).not.toContain("evil.com");
    expect(sanitizedHolderKey).not.toContain("<script>");
    expect(sanitizedHolderKey).toBe("[redacted]");
    expect(
      report.unresolvedIdentities.map((entry) => (entry as { holderKey: string }).holderKey)
    ).toEqual(["[redacted]", "[redacted]"]);

    // Deterministic without becoming a candidate-correlation oracle.
    const report2 = buildLicenseRunReport(run, [], []);
    expect((report2.unresolvedIdentities[0] as { holderKey: string }).holderKey).toBe(sanitizedHolderKey);

    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toMatch(/attacker/);
    expect(serialized).not.toMatch(/evil\.com/i);
    expect(serialized).not.toMatch(/script/);
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).not.toMatch(/attacker/);
    expect(rendered).not.toMatch(/evil\.com/i);
  });

  it("omits a non-finite/negative/non-integer or string githubUserId rather than surfacing an invalid value", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        unresolvedIdentities: [
          { holderKey: "holder1", githubUserId: "42", reason: "no_login" },
          { holderKey: "holder2", githubUserId: -5, reason: "no_login" },
          { holderKey: "holder3", githubUserId: 3.5, reason: "no_login" },
          { holderKey: "holder4", githubUserId: 99, reason: "no_login" },
        ],
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    const byHolder = Object.fromEntries(
      (report.unresolvedIdentities as { holderKey: string; githubUserId?: number }[]).map((e) => [e.holderKey, e])
    );
    expect(byHolder.holder1.githubUserId).toBeUndefined();
    expect(byHolder.holder2.githubUserId).toBeUndefined();
    expect(byHolder.holder3.githubUserId).toBeUndefined();
    expect(byHolder.holder4.githubUserId).toBe(99);
  });

  it("restricts reason to a fixed safe set, mapping unknown/free-text reasons (including embedded email/external-id/token content) to 'unknown'", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const maliciousReason = "external_id=abc123 email=leaked@example.com token=ghp_abcdefghijklmnopqrstuvwxyz012345";
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        unresolvedIdentities: [
          { holderKey: "holder1", reason: maliciousReason },
          { holderKey: "holder2", reason: "no_login" },
        ],
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    const byHolder = Object.fromEntries(
      (report.unresolvedIdentities as { holderKey: string; reason?: string }[]).map((e) => [e.holderKey, e])
    );
    expect(byHolder.holder1.reason).toBe("unknown");
    expect(byHolder.holder2.reason).toBe("no_login");

    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toMatch(/leaked@example\.com/);
    expect(serialized).not.toMatch(/ghp_/);
    expect(serialized).not.toMatch(/external_id=abc123/);
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).not.toMatch(/leaked@example\.com/);
    expect(rendered).not.toMatch(/ghp_/);
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
    expect(report.diagnostics).toEqual({
      materializedRowCount: 0,
      activeSeatRowCount: 0,
      consumptionRowCount: 0,
      consumedCredits: 0,
      consumedUsd: 0,
      identityResolution: { bySource: [], unresolvedHolderKeys: [] },
      historyCoverage: [],
      sourceStateSummary: [],
      apiRequestCounts: { total: 0, bySource: {} },
    });
    const rendered = renderLicenseRunReportText(report);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
  });
});

describe("buildLicenseRunReport typed diagnostics (materialized rows, identity resolution, history coverage, source states, API requests)", () => {
  it("exposes deterministic empty defaults for every diagnostics field when no diagnostics input is given", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.diagnostics).toEqual({
      materializedRowCount: 0,
      activeSeatRowCount: 0,
      consumptionRowCount: 0,
      consumedCredits: 0,
      consumedUsd: 0,
      identityResolution: { bySource: [], unresolvedHolderKeys: [] },
      historyCoverage: [],
      sourceStateSummary: [],
      apiRequestCounts: { total: 0, bySource: {} },
    });
  });

  it("builds a full, deterministic diagnostics report from realistic Task 6/7/check-shaped inputs, and both JSON and text expose sorted periods, counts, summaries, request counts, checks/warnings and elapsed", () => {
    // Realistic Task 7 (materialize-license-period) shaped row count inputs.
    const materializedRowCount = 3;
    const activeSeatRowCount = 2;

    // Realistic Task 6 (identity-resolver) shaped rows summarized via the
    // already-exported `summarizeIdentityResolution` (reused, not reimplemented).
    const identityResolution = summarizeIdentityResolution([
      { holderKey: "user1", identityResolutionSource: "seat", resolvedUserLogin: "user1" },
      { holderKey: "user2", identityResolutionSource: "audit", resolvedUserLogin: "user2" },
      { holderKey: "user3", identityResolutionSource: "unresolved", resolvedUserLogin: null },
    ]);

    // Realistic Task 6 (seat-ledger) shaped coverage summarized via the
    // already-exported `summarizeHistoryCoverage` (reused, not reimplemented).
    const coverage: SeatLedgerCoverage[] = [
      {
        enterpriseSlug: "ent1",
        billingPeriod: "2026-01",
        orgLogin: "org1",
        confidence: "exact_snapshot",
        counts: { exact_snapshot: 2, audit_reconstructed: 0, live_snapshot_only: 0, unrecoverable: 0 },
        warnings: [],
      },
      {
        enterpriseSlug: "ent1",
        billingPeriod: "2026-01",
        orgLogin: "org2",
        confidence: "live_snapshot_only",
        counts: { exact_snapshot: 0, audit_reconstructed: 0, live_snapshot_only: 1, unrecoverable: 0 },
        warnings: [],
      },
    ];
    const historyCoverage = summarizeHistoryCoverage(coverage);

    const runId = startLicenseRun({
      enterpriseSlug: "ent1",
      requestedPeriods: ["2026-02", "2026-01"],
      startedAt: "2026-02-01T00:00:00.000Z",
    });
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        completedAt: "2026-02-01T00:00:07.000Z",
        warnings: ["partial_seat_snapshot"],
      },
      checks: [
        { checkName: "seat_count", billingPeriod: "2026-01", orgLogin: "org1", status: "pass", message: "ok" },
        { checkName: "history_coverage", billingPeriod: "2026-01", orgLogin: "org2", status: "warning", message: "limited reconstruction" },
      ],
      sourceStates: [
        { enterpriseSlug: "ent1", source: "seat_snapshot", billingPeriod: "2026-01", status: "ok" },
        { enterpriseSlug: "ent1", source: "audit_log", billingPeriod: "2026-01", status: "ok" },
      ],
    });

    const run = getLicenseRun(runId)!;
    const checks = listLicenseChecks(runId);
    const sourceStates = listLicenseSourceState("ent1");

    const report = buildLicenseRunReport(run, checks, sourceStates, {
      materializedRowCount,
      activeSeatRowCount,
      consumptionRowCount: 2,
      consumedCredits: 500,
      consumedUsd: 5,
      identityResolution,
      historyCoverage,
      apiRequestCounts: { total: 12, bySource: { seat_snapshot: 7, audit_log: 5 } },
    });

    expect(report.requestedPeriods).toEqual(["2026-01", "2026-02"]);
    expect(report.elapsedMs).toBe(7000);
    expect(report.checkCounts).toEqual({ pass: 1, warning: 1, fail: 0 });
    expect(report.warnings).toEqual(["partial_seat_snapshot"]);

    expect(report.diagnostics.materializedRowCount).toBe(3);
    expect(report.diagnostics.activeSeatRowCount).toBe(2);
    expect(report.diagnostics.consumptionRowCount).toBe(2);
    expect(report.diagnostics.consumedCredits).toBe(500);
    expect(report.diagnostics.consumedUsd).toBe(5);
    expect(report.diagnostics.identityResolution.bySource).toEqual([
      { source: "audit", count: 1 },
      { source: "seat", count: 1 },
      { source: "unresolved", count: 1 },
    ]);
    expect(report.diagnostics.identityResolution.unresolvedHolderKeys).toEqual(["user3"]);
    expect(report.diagnostics.historyCoverage).toEqual([
      { confidence: "exact_snapshot", count: 1 },
      { confidence: "live_snapshot_only", count: 1 },
    ]);
    expect(report.diagnostics.sourceStateSummary.map((s) => s.source)).toEqual(["audit_log", "seat_snapshot"]);
    expect(report.diagnostics.apiRequestCounts).toEqual({ total: 12, bySource: { audit_log: 5, seat_snapshot: 7 } });

    const serialized = serializeLicenseRunReport(report);
    const parsed = JSON.parse(serialized);
    expect(parsed.requestedPeriods).toEqual(["2026-01", "2026-02"]);
    expect(parsed.checkCounts).toEqual({ pass: 1, warning: 1, fail: 0 });
    expect(parsed.warnings).toEqual(["partial_seat_snapshot"]);
    expect(parsed.elapsedMs).toBe(7000);
    expect(parsed.diagnostics.materializedRowCount).toBe(3);
    expect(parsed.diagnostics.activeSeatRowCount).toBe(2);
    expect(parsed.diagnostics.apiRequestCounts.total).toBe(12);

    const rendered = renderLicenseRunReportText(report);
    expect(rendered).toContain("2026-01, 2026-02");
    expect(rendered).toContain("Materialized rows: 3");
    expect(rendered).toContain("Active/seat rows: 2");
    expect(rendered).toContain("audit=1");
    expect(rendered).toContain("seat=1");
    expect(rendered).toContain("unresolved=1");
    expect(rendered).toContain("exact_snapshot=1");
    expect(rendered).toContain("live_snapshot_only=1");
    expect(rendered).toContain("total=12");
    expect(rendered).toContain("seat_snapshot=7");
    expect(rendered).toContain("audit_log=5");
    expect(rendered).toContain("partial_seat_snapshot");
    expect(rendered).toContain("seat_count");
    expect(rendered).toContain("Elapsed: 7000ms");
  });

  it("bounds a caller-provided apiRequestCounts.bySource/total to safe non-negative integers", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], [], {
      apiRequestCounts: { total: -5, bySource: { good: 3, bad: NaN, negative: -1 } },
    });
    expect(report.diagnostics.apiRequestCounts.total).toBe(0);
    expect(report.diagnostics.apiRequestCounts.bySource).toEqual({ good: 3, bad: 0, negative: 0 });
  });
});

describe("report content sanitization (legacy sourceStats/warnings/errorMessage)", () => {
  it("redacts Bearer tokens, GitHub PAT-shaped tokens, and email addresses embedded in legacy sourceStats/warnings/errorMessage without leaking the originals, while safe operational text remains readable", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const bearerHeader = "Bearer abcdefghijklmnop.qrstuvwx-yz012345";
    const leakedEmail = "someone@example.com";

    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        sourceStats: {
          apiRequests: 5,
          debugAuthHeader: bearerHeader,
          leakedNote: `token ${secretToken} for ${leakedEmail}`,
        },
        warnings: [`sync failed for ${leakedEmail}`, "org_billing_endpoint_unavailable"],
        errorMessage: `auth failed using ${secretToken}`,
      },
      checks: [],
    });

    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    const serialized = serializeLicenseRunReport(report);
    const rendered = renderLicenseRunReportText(report);

    for (const surface of [serialized, rendered]) {
      expect(surface).not.toContain(secretToken);
      expect(surface).not.toContain(bearerHeader);
      expect(surface).not.toContain(leakedEmail);
    }

    // Safe operational content remains readable in both surfaces.
    expect(serialized).toContain("org_billing_endpoint_unavailable");
    expect(rendered).toContain("org_billing_endpoint_unavailable");
    expect(serialized).toContain('"apiRequests":5');
  });

  it("bounds sourceStats collection size to avoid log amplification", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const bigArray = Array.from({ length: 200 }, (_, i) => `item-${i}`);
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        sourceStats: { bigArray },
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    const stored = report.sourceStats.bigArray as unknown[];
    // Bounded to a fixed max collection size plus a truncation marker —
    // never the full 200-entry original.
    expect(stored.length).toBeLessThanOrEqual(51);
    expect(stored.length).toBeLessThan(bigArray.length);
  });

  it("does not affect the raw persisted run record — sanitization applies only to report content", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const secretToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "warning", sourceStats: { note: `token ${secretToken}` } },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    expect(run.sourceStats).toEqual({ note: `token ${secretToken}` });
  });
});

// ── Task 8 production-readiness privacy fixes ────────────────────────

describe("buildLicenseRunReport: check message/details sanitization", () => {
  it("sanitizes check message and recursively sanitizes nested details (arrays/objects, including nested sensitive keys) without leaking secrets, while safe fields remain readable", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const leakedEmail = "auditor@example.com";
    const leakedToken = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "warning" },
      checks: [
        {
          checkName: "seat_count",
          billingPeriod: "2026-01",
          orgLogin: "org1",
          status: "fail",
          message: `mismatch reported by ${leakedEmail} using ${leakedToken}`,
          details: {
            toleranceUsed: 0.05,
            source: "billing_report",
            [leakedEmail]: "sensitive-keyed-value",
            nested: {
              contactEmail: leakedEmail,
              history: [leakedToken, "safe-value", { deep: leakedEmail }],
            },
          },
        },
      ],
    });
    const run = getLicenseRun(runId)!;
    const checks = listLicenseChecks(runId);
    const report = buildLicenseRunReport(run, checks, []);

    expect(report.checks[0].message).not.toContain(leakedEmail);
    expect(report.checks[0].message).not.toContain(leakedToken);
    const detailsStr = JSON.stringify(report.checks[0].details);
    expect(detailsStr).not.toContain(leakedEmail);
    expect(detailsStr).not.toContain(leakedToken);
    expect(report.checks[0].details.toleranceUsed).toBe(0.05);
    expect(report.checks[0].details.source).toBe("billing_report");

    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toContain(leakedEmail);
    expect(serialized).not.toContain(leakedToken);
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).not.toContain(leakedEmail);
    expect(rendered).not.toContain(leakedToken);
    expect(serialized).toContain("billing_report");
  });
});

describe("sanitizeReportValue/sanitizeReportRecord: key sanitization + prototype-safety", () => {
  it("redacts sensitive object keys (email/token) and de-duplicates deterministically on collision, without leaking originals", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const emailKeyA = "alice@example.com";
    const emailKeyB = "bob@example.com";
    recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: "warning",
        sourceStats: {
          [emailKeyA]: 1,
          [emailKeyB]: 2,
          safeKey: 3,
        },
      },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    const keys = Object.keys(report.sourceStats);
    expect(keys).not.toContain(emailKeyA);
    expect(keys).not.toContain(emailKeyB);
    expect(keys).toContain("safeKey");
    // Two distinct emails redact to the same marker: deterministic dedup suffix, not a merge/overwrite.
    expect(keys.filter((k) => k.startsWith("[REDACTED_EMAIL]")).sort()).toEqual(["[REDACTED_EMAIL]", "[REDACTED_EMAIL]:2"]);
    expect(report.sourceStats["[REDACTED_EMAIL]"]).toBe(1);
    expect(report.sourceStats["[REDACTED_EMAIL]:2"]).toBe(2);

    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toContain(emailKeyA);
    expect(serialized).not.toContain(emailKeyB);

    // Deterministic across repeated builds of the same underlying data.
    const report2 = buildLicenseRunReport(run, [], []);
    expect(Object.keys(report2.sourceStats).sort()).toEqual(keys.sort());
  });

  it("renames __proto__/constructor/prototype keys and never mutates a shared prototype", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    // JSON.parse creates real *own* properties for these names (it never
    // triggers the `__proto__` accessor setter), matching how sourceStats
    // actually round-trips through the DB's JSON text column.
    const maliciousSourceStats = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "safe": 1}'
    ) as Record<string, unknown>;
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "warning", sourceStats: maliciousSourceStats },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    expect(Object.getPrototypeOf(run.sourceStats)).toBe(Object.prototype);

    const report = buildLicenseRunReport(run, [], []);
    // No global prototype pollution occurred anywhere along the way.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(report.sourceStats.safe).toBe(1);
    const keys = Object.keys(report.sourceStats);
    expect(keys).not.toContain("__proto__");
    expect(keys).not.toContain("constructor");
    expect(keys).not.toContain("prototype");

    // Serializing/parsing must not resurrect a real `__proto__` own key either.
    const serialized = serializeLicenseRunReport(report);
    const parsed = JSON.parse(serialized);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed.sourceStats)).not.toContain("__proto__");
  });
});

describe("buildLicenseRunReport diagnostics: apiRequestCounts.bySource key sanitization", () => {
  it("redacts a token/email-like apiRequestCounts.bySource key without leaking the original, while safe source keys pass through", () => {
    const runId = startLicenseRun({ enterpriseSlug: "ent1", requestedPeriods: ["2026-01"] });
    const run = getLicenseRun(runId)!;
    const leakedKey = "leaked@example.com";
    const report = buildLicenseRunReport(run, [], [], {
      apiRequestCounts: { total: 4, bySource: { [leakedKey]: 3, seat_snapshot: 1 } },
    });
    const bySourceKeys = Object.keys(report.diagnostics.apiRequestCounts.bySource);
    expect(bySourceKeys).not.toContain(leakedKey);
    expect(bySourceKeys).toContain("seat_snapshot");
    expect(report.diagnostics.apiRequestCounts.bySource.seat_snapshot).toBe(1);

    const serialized = serializeLicenseRunReport(report);
    expect(serialized).not.toContain(leakedKey);
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).not.toContain(leakedKey);
    expect(rendered).toContain("seat_snapshot");
  });
});

describe("buildLicenseRunReport: elapsedMs validity", () => {
  it("is null (never NaN) for an unparseable startedAt timestamp, agreeing across the report object, JSON, and text", () => {
    const runId = startLicenseRun({
      enterpriseSlug: "ent1",
      requestedPeriods: ["2026-01"],
      startedAt: "not-a-real-timestamp",
    });
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "success", completedAt: "2026-01-01T00:00:00.000Z" },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.elapsedMs).toBeNull();
    expect(Number.isNaN(report.elapsedMs as unknown as number)).toBe(false);
    const parsed = JSON.parse(serializeLicenseRunReport(report));
    expect(parsed.elapsedMs).toBeNull();
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).toMatch(/in progress/i);
  });

  it("is null (never negative) when completedAt is before startedAt (out-of-order timestamps), agreeing across JSON and text", () => {
    const runId = startLicenseRun({
      enterpriseSlug: "ent1",
      requestedPeriods: ["2026-01"],
      startedAt: "2026-01-01T00:00:10.000Z",
    });
    recordLicenseRunDiagnostics({
      runId,
      finish: { status: "success", completedAt: "2026-01-01T00:00:00.000Z" },
      checks: [],
    });
    const run = getLicenseRun(runId)!;
    const report = buildLicenseRunReport(run, [], []);
    expect(report.elapsedMs).toBeNull();
    const parsed = JSON.parse(serializeLicenseRunReport(report));
    expect(parsed.elapsedMs).toBeNull();
    const rendered = renderLicenseRunReportText(report);
    expect(rendered).toMatch(/in progress/i);
  });
});
