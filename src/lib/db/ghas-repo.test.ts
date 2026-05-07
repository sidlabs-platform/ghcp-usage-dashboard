import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  upsertCodeScanningAlerts,
  upsertDependabotAlerts,
  upsertSecretScanningAlerts,
  recomputeCodeScanningDaily,
  recomputeSecretScanningDaily,
  recomputeDependabotDaily,
  getCodeScanningDaily,
  getDependabotDaily,
  getSecretScanningDaily,
  getSecurityOverview,
  getOpenCodeScanningAlerts,
  promoteAutofixCommitted,
  updateGhasSyncState,
  getGhasSyncState,
  getAllGhasSyncStates,
  computeMTTR,
  updateAlertAutofixStatuses,
} from "./ghas-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "ghas-schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM ghas_code_scanning_alerts");
  db.exec("DELETE FROM ghas_dependabot_alerts");
  db.exec("DELETE FROM ghas_secret_scanning_alerts");
  db.exec("DELETE FROM ghas_code_scanning_daily");
  db.exec("DELETE FROM ghas_dependabot_daily");
  db.exec("DELETE FROM ghas_secret_scanning_daily");
  db.exec("DELETE FROM ghas_sync_state");
});

describe("upsertCodeScanningAlerts", () => {
  it("inserts alerts", () => {
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "open", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z", fixed_at: null, dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
    ] as any[]);
    const rows = db.prepare("SELECT * FROM ghas_code_scanning_alerts").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("open");
    expect(rows[0].severity).toBe("high");
  });

  it("upserts on conflict preserving autofix_status", () => {
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "open", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z", fixed_at: null, dismissed_at: null, dismissed_reason: null, autofix: { status: "available" } },
    ] as any[]);
    // Update with state change but autofix "none" → should keep "available"
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "fixed", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-11T00:00:00Z", fixed_at: "2024-01-11T00:00:00Z", dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
    ] as any[]);
    const row = db.prepare("SELECT * FROM ghas_code_scanning_alerts WHERE alert_number = 1").get() as any;
    expect(row.state).toBe("fixed");
    expect(row.autofix_status).toBe("available");
  });

  it("handles null repository and null severity gracefully", () => {
    upsertCodeScanningAlerts("ent1", "org", "null-org", [
      { number: 99, repository: null, state: "open", rule: { id: "r2", severity: null, security_severity_level: null }, tool: { name: "CodeQL" }, created_at: "2024-01-12T00:00:00Z", updated_at: "2024-01-12T00:00:00Z", fixed_at: null, dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
    ] as any[]);
    const rows = db.prepare("SELECT * FROM ghas_code_scanning_alerts WHERE scope_id = 'null-org'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].repo_full_name).toBe("unknown");
    expect(rows[0].severity).toBeNull();
  });
});

describe("upsertSecretScanningAlerts", () => {
  it("inserts secret scanning alerts", () => {
    upsertSecretScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "open", secret_type: "github_token", secret_type_display_name: "GitHub Token", created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z", resolved_at: null, resolution: null },
    ] as any[]);
    const rows = db.prepare("SELECT * FROM ghas_secret_scanning_alerts").all();
    expect(rows).toHaveLength(1);
  });
});

describe("recomputeCodeScanningDaily", () => {
  it("computes daily aggregates from alerts", () => {
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "open", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z", fixed_at: null, dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
      { number: 2, repository: { full_name: "org/repo" }, state: "fixed", rule: { id: "r2", severity: "critical", security_severity_level: "critical" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-11T00:00:00Z", fixed_at: "2024-01-11T00:00:00Z", dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
    ] as any[]);
    recomputeCodeScanningDaily("ent1", "org", "my-org");
    const rows = getCodeScanningDaily("org", "my-org", "2024-01-01", "2024-01-31") as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const day10 = rows.find((r: any) => r.day === "2024-01-10");
    expect(day10.opened).toBe(2);
  });
});

describe("getOpenCodeScanningAlerts", () => {
  it("returns only open alerts", () => {
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "open", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-10T00:00:00Z", fixed_at: null, dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
      { number: 2, repository: { full_name: "org/repo" }, state: "fixed", rule: { id: "r2", severity: "low", security_severity_level: "low" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-11T00:00:00Z", fixed_at: "2024-01-11T00:00:00Z", dismissed_at: null, dismissed_reason: null, autofix: { status: "none" } },
    ] as any[]);
    const open = getOpenCodeScanningAlerts("org", "my-org");
    expect(open).toHaveLength(1);
    expect(open[0].alert_number).toBe(1);
  });
});

describe("promoteAutofixCommitted", () => {
  it("promotes fixed alerts with autofix available", () => {
    upsertCodeScanningAlerts("ent1", "org", "my-org", [
      { number: 1, repository: { full_name: "org/repo" }, state: "fixed", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "CodeQL" }, created_at: "2024-01-10T00:00:00Z", updated_at: "2024-01-11T00:00:00Z", fixed_at: "2024-01-11T00:00:00Z", dismissed_at: null, dismissed_reason: null, autofix: { status: "available" } },
    ] as any[]);
    const count = promoteAutofixCommitted("ent1", "org", "my-org");
    expect(count).toBe(1);
    const row = db.prepare("SELECT autofix_status FROM ghas_code_scanning_alerts WHERE alert_number = 1").get() as any;
    expect(row.autofix_status).toBe("committed");
  });
});

describe("sync state", () => {
  it("returns null when no state exists", () => {
    expect(getGhasSyncState("org", "my-org", "code_scanning")).toBeNull();
  });

  it("updates and retrieves sync state", () => {
    updateGhasSyncState("ent1", "org", "my-org", "code_scanning", "2024-01-10T00:00:00Z", "2024-01-10T00:00:00Z", 5, "ok");
    const state = getGhasSyncState("org", "my-org", "code_scanning", ["ent1"]);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("ok");
    expect(state!.total_alerts).toBe(5);
  });
});

describe("getSecurityOverview", () => {
  it("returns overview with no data", () => {
    const overview = getSecurityOverview("org", "my-org");
    expect(overview.codeScanning).toBeNull();
    expect(overview.dependabot).toBeNull();
    expect(overview.secretScanning).toBeNull();
  });

  it("returns populated overview when alerts exist", () => {
    upsertCodeScanningAlerts("ent1", "org", "overview-org", [
      { number: 300, repository: { full_name: "org/r" }, state: "open", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "codeql" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ] as any);
    upsertDependabotAlerts("ent1", "org", "overview-org", [
      { number: 301, repository: { full_name: "org/r" }, state: "open", security_vulnerability: { severity: "critical", package: { ecosystem: "npm", name: "pkg" } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ] as any);
    upsertSecretScanningAlerts("ent1", "org", "overview-org", [
      { number: 302, repository: { full_name: "org/r" }, state: "open", secret_type: "token", secret_type_display_name: "Token", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ] as any);
    const overview = getSecurityOverview("org", "overview-org", ["ent1"]);
    expect(overview.codeScanning).not.toBeNull();
    expect(overview.codeScanning!.totalOpen).toBe(1);
    expect(overview.dependabot).not.toBeNull();
    expect(overview.dependabot!.criticalOpen).toBe(1);
    expect(overview.secretScanning).not.toBeNull();
    expect(overview.secretScanning!.totalOpen).toBe(1);
  });
});

describe("recomputeDependabotDaily / getDependabotDaily", () => {
  it("recomputes daily aggregates from dependabot alerts", () => {
    upsertDependabotAlerts("ent1", "org", "my-org", [
      { number: 100, repository: { full_name: "org/repo" }, state: "open", security_vulnerability: { severity: "high", package: { ecosystem: "npm", name: "lodash" } }, created_at: "2024-01-10T10:00:00Z", updated_at: "2024-01-10T10:00:00Z" },
    ] as any);
    recomputeDependabotDaily("ent1", "org", "my-org");
    const daily = getDependabotDaily("org", "my-org", "2024-01-01", "2024-01-31", ["ent1"]);
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(daily[0].opened).toBe(1);
  });

  it("populates fixed, dismissed, severity, and ecosystem_counts", () => {
    upsertDependabotAlerts("ent1", "org", "my-org", [
      { number: 10, repository: { full_name: "org/r" }, state: "open", security_vulnerability: { severity: "critical", package: { ecosystem: "pip", name: "pkg" } }, created_at: "2024-02-01T00:00:00Z", updated_at: "2024-02-01T00:00:00Z" },
      { number: 11, repository: { full_name: "org/r" }, state: "fixed", security_vulnerability: { severity: "high", package: { ecosystem: "npm", name: "x" } }, created_at: "2024-02-01T00:00:00Z", updated_at: "2024-02-02T00:00:00Z", fixed_at: "2024-02-02T00:00:00Z" },
      { number: 12, repository: { full_name: "org/r" }, state: "dismissed", security_vulnerability: { severity: "medium", package: { ecosystem: "npm", name: "y" } }, created_at: "2024-02-01T00:00:00Z", updated_at: "2024-02-02T00:00:00Z", dismissed_at: "2024-02-02T00:00:00Z", dismissed_reason: "tolerable_risk" },
    ] as any);
    recomputeDependabotDaily("ent1", "org", "my-org");
    const daily = getDependabotDaily("org", "my-org", "2024-02-01", "2024-02-28", ["ent1"]);
    const day2 = daily.find(d => d.day === "2024-02-02");
    expect(day2).toBeDefined();
    expect(day2!.fixed).toBe(1);
    expect(day2!.dismissed).toBe(1);
    expect(day2!.severity_critical).toBe(1);
    expect(day2!.ecosystem_counts).toEqual({ pip: 1 });
  });
});

describe("recomputeSecretScanningDaily / getSecretScanningDaily", () => {
  it("recomputes daily aggregates from secret scanning alerts", () => {
    upsertSecretScanningAlerts("ent1", "org", "my-org", [
      { number: 200, repository: { full_name: "org/repo" }, state: "open", secret_type: "github_token", secret_type_display_name: "GitHub Token", created_at: "2024-01-12T10:00:00Z", updated_at: "2024-01-12T10:00:00Z" },
    ] as any);
    recomputeSecretScanningDaily("ent1", "org", "my-org");
    const daily = getSecretScanningDaily("org", "my-org", "2024-01-01", "2024-01-31", ["ent1"]);
    expect(daily.length).toBeGreaterThanOrEqual(1);
    expect(daily[0].opened).toBe(1);
  });

  it("populates resolved and resolution_counts", () => {
    upsertSecretScanningAlerts("ent1", "org", "my-org", [
      { number: 50, repository: { full_name: "org/r" }, state: "resolved", secret_type: "aws_key", secret_type_display_name: "AWS Key", created_at: "2024-03-01T00:00:00Z", updated_at: "2024-03-02T00:00:00Z", resolved_at: "2024-03-02T00:00:00Z", resolution: "revoked" },
      { number: 51, repository: { full_name: "org/r" }, state: "open", secret_type: "npm_token", secret_type_display_name: "NPM", created_at: "2024-03-01T00:00:00Z", updated_at: "2024-03-01T00:00:00Z" },
    ] as any);
    recomputeSecretScanningDaily("ent1", "org", "my-org");
    const daily = getSecretScanningDaily("org", "my-org", "2024-03-01", "2024-03-31", ["ent1"]);
    const day2 = daily.find(d => d.day === "2024-03-02");
    expect(day2).toBeDefined();
    expect(day2!.resolved).toBe(1);
    expect(day2!.resolution_counts).toEqual({ revoked: 1 });
  });

  it("returns early when no alerts exist for scope", () => {
    recomputeSecretScanningDaily("ent1", "org", "empty-org");
    const daily = getSecretScanningDaily("org", "empty-org", "2024-01-01", "2024-12-31", ["ent1"]);
    expect(daily).toEqual([]);
  });
});

describe("getAllGhasSyncStates", () => {
  it("returns all sync states", () => {
    updateGhasSyncState("ent1", "org", "test-org", "code_scanning", "2024-01-10T00:00:00Z", "2024-01-10T00:00:00Z", 3, "ok");
    const states = getAllGhasSyncStates(["ent1"]);
    expect(states.length).toBeGreaterThanOrEqual(1);
  });
});

describe("computeMTTR", () => {
  it("computes mean time to remediate for code scanning", () => {
    upsertCodeScanningAlerts("ent1", "org", "mttr-org", [
      { number: 500, repository: { full_name: "org/repo" }, state: "fixed", rule: { id: "r1", severity: "high", security_severity_level: "high" }, tool: { name: "codeql" }, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-05T00:00:00Z", fixed_at: "2024-01-05T00:00:00Z" },
    ] as any);
    const mttr = computeMTTR("org", "mttr-org", "code_scanning", ["ent1"]);
    expect(mttr).toBe(4);
  });

  it("returns null when no fixed alerts", () => {
    const mttr = computeMTTR("org", "empty-org", "code_scanning");
    expect(mttr).toBeNull();
  });
});

describe("updateAlertAutofixStatuses", () => {
  it("batch-updates autofix statuses", () => {
    upsertCodeScanningAlerts("ent1", "org", "autofix-org", [
      { number: 600, repository: { full_name: "org/repo" }, state: "open", rule: { id: "r1", severity: "medium", security_severity_level: "medium" }, tool: { name: "codeql" }, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
    ] as any);
    updateAlertAutofixStatuses("ent1", "org", "autofix-org", [
      { alertNumber: 600, repoFullName: "org/repo", autofixStatus: "available" },
    ]);
    const row = db.prepare("SELECT autofix_status FROM ghas_code_scanning_alerts WHERE alert_number = 600 AND scope_id = 'autofix-org'").get() as any;
    expect(row.autofix_status).toBe("available");
  });
});
