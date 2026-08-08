import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  startLicenseRun,
  finishLicenseRun,
  getLicenseRun,
  listLicenseRuns,
  replaceLicenseChecks,
  listLicenseChecks,
  updateLicenseSourceState,
  listLicenseSourceState,
} from "./license-run-repo";

const SCHEMA_DIR = path.join(process.cwd(), "src", "lib", "db");

function execSchema(database: Database.Database, file: string): void {
  database.exec(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8"));
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  execSchema(db, "schema.sql");
  execSchema(db, "billing-schema.sql");
  execSchema(db, "licensing-schema.sql");
  // Run twice to prove idempotency of CREATE TABLE IF NOT EXISTS.
  execSchema(db, "licensing-schema.sql");
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM license_reconciliation_runs");
  db.exec("DELETE FROM license_reconciliation_checks");
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

  it("returns an empty array for missing/empty state", () => {
    expect(listLicenseSourceState("no-such-enterprise")).toEqual([]);
  });
});
