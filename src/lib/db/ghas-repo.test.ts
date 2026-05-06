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
  getCodeScanningDaily,
  getSecretScanningDaily,
  getSecurityOverview,
  getOpenCodeScanningAlerts,
  promoteAutofixCommitted,
  updateGhasSyncState,
  getGhasSyncState,
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
});
