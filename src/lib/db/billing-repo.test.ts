import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

let db: Database.Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  upsertUsageRecords,
  upsertPremiumRequests,
  getOverviewKPIs,
  getDailyAggregates,
  getProductBreakdown,
  getBillingSyncState,
  updateBillingSyncState,
  getUsageFilterOptions,
  getPremiumFilterOptions,
  getOrgBreakdown,
  getUserBreakdown,
  getUsageRecordsPaginated,
  getPremiumRequestsPaginated,
  getPremiumUserSummary,
  getPremiumModelSummary,
  getCostCenterBreakdown,
  getRepositoryBreakdown,
  getPremiumDailyTrend,
  refreshBillingDailyAggregates,
} from "./billing-repo";

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const schemaPath = path.join(process.cwd(), "src", "lib", "db", "billing-schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM billing_usage_records");
  db.exec("DELETE FROM billing_premium_requests");
  db.exec("DELETE FROM billing_daily_aggregate");
  db.exec("DELETE FROM billing_sync_state");
});

describe("upsertUsageRecords", () => {
  it("inserts records and allows retrieval", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "sku1", quantity: 5, unit_type: "seat", applied_cost_per_quantity: 2, gross_amount: 10, discount_amount: 1, net_amount: 9, organization: "org1", repository: "repo1", username: "user1", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
    ]);
    const rows = db.prepare("SELECT * FROM billing_usage_records").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].product).toBe("copilot");
    expect(rows[0].net_amount).toBe(9);
  });

  it("upserts on conflict", () => {
    const rec = { date: "2024-01-10", product: "copilot", sku: "sku1", quantity: 5, unit_type: "seat", applied_cost_per_quantity: 2, gross_amount: 10, discount_amount: 1, net_amount: 9, organization: "org1", repository: "repo1", username: "user1", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" };
    upsertUsageRecords("ent1", [rec]);
    upsertUsageRecords("ent1", [{ ...rec, net_amount: 20 }]);
    const rows = db.prepare("SELECT * FROM billing_usage_records").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].net_amount).toBe(20);
  });
});

describe("upsertPremiumRequests", () => {
  it("inserts premium records", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "prem1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const rows = db.prepare("SELECT * FROM billing_premium_requests").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gpt-4");
  });
});

describe("getOverviewKPIs", () => {
  it("returns zeros with no data", () => {
    const kpis = getOverviewKPIs("2024-01-01", "2024-01-31");
    expect(kpis.totalNet).toBe(0);
    expect(kpis.totalGross).toBe(0);
  });

  it("sums usage and premium amounts", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 2, net_amount: 8, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 50, unit_type: "token", applied_cost_per_quantity: 0.1, gross_amount: 5, discount_amount: 0, net_amount: 5, username: "u1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 200, charge_scope: "user" },
    ]);
    const kpis = getOverviewKPIs("2024-01-01", "2024-01-31");
    expect(kpis.totalNet).toBe(13); // 8 + 5
    expect(kpis.totalGross).toBe(15); // 10 + 5
  });

  it("applies billing filters to KPIs", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-14", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 20, gross_amount: 20, discount_amount: 0, net_amount: 20, organization: "filtered-org", repository: "", username: "kpiuser", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
      { date: "2024-01-14", product: "actions", sku: "s2", quantity: 1, unit_type: "min", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "other-org", repository: "", username: "other", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const kpis = getOverviewKPIs("2024-01-14", "2024-01-14", { organization: ["filtered-org"] });
    expect(kpis.totalNet).toBeGreaterThanOrEqual(20);
    expect(kpis.uniqueOrgs).toBeGreaterThanOrEqual(1);
  });

  it("filters by enterprise slug", () => {
    upsertUsageRecords("ent-a", [
      { date: "2024-02-01", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 100, gross_amount: 100, discount_amount: 0, net_amount: 100, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    upsertUsageRecords("ent-b", [
      { date: "2024-02-01", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 50, gross_amount: 50, discount_amount: 0, net_amount: 50, organization: "org2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const kpis = getOverviewKPIs("2024-02-01", "2024-02-01", undefined, ["ent-a"]);
    expect(kpis.totalNet).toBe(100);
  });

  it("applies scopeOrgs filter to premium KPIs", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-02-05", product: "copilot", sku: "p1", quantity: 10, unit_type: "token", applied_cost_per_quantity: 1, gross_amount: 10, discount_amount: 0, net_amount: 10, username: "u1", organization: "scoped-org", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 100, charge_scope: "user" },
      { date: "2024-02-05", product: "copilot", sku: "p2", quantity: 20, unit_type: "token", applied_cost_per_quantity: 1, gross_amount: 20, discount_amount: 0, net_amount: 20, username: "u2", organization: "other-org", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 100, charge_scope: "user" },
    ]);
    const kpis = getOverviewKPIs("2024-02-05", "2024-02-05", { scopeOrgs: ["scoped-org"] });
    expect(kpis.totalNet).toBeGreaterThanOrEqual(10);
  });
});

describe("getDailyAggregates", () => {
  it("groups by day, product, charge_scope", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-10", product: "copilot", sku: "s2", quantity: 2, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "o2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const aggs = getDailyAggregates("2024-01-01", "2024-01-31");
    expect(aggs).toHaveLength(1);
    expect(aggs[0].total_net).toBe(20);
    expect(aggs[0].record_count).toBe(2);
  });
});

describe("billing sync state", () => {
  it("returns null when no state", () => {
    expect(getBillingSyncState("detailed")).toBeNull();
  });

  it("updates and retrieves sync state", () => {
    updateBillingSyncState("detailed", "2024-01-10T00:00:00Z", "2024-01-01", "2024-01-10", "ok", undefined, "ent1");
    const state = getBillingSyncState("detailed", "ent1");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("ok");
    expect(state!.last_report_start).toBe("2024-01-01");
  });

  it("upserts on conflict", () => {
    updateBillingSyncState("detailed", "2024-01-10T00:00:00Z", "2024-01-01", "2024-01-10", "syncing", undefined, "ent1");
    updateBillingSyncState("detailed", "2024-01-11T00:00:00Z", "2024-01-01", "2024-01-11", "ok", undefined, "ent1");
    const state = getBillingSyncState("detailed", "ent1");
    expect(state!.status).toBe("ok");
    expect(state!.last_report_end).toBe("2024-01-11");
  });
});

describe("getUsageFilterOptions", () => {
  it("returns distinct filter values", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
      { date: "2024-01-10", product: "actions", sku: "s2", quantity: 2, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 2, discount_amount: 0, net_amount: 2, organization: "org2", repository: "", username: "", workflow_path: "", cost_center_name: "cc2", charge_scope: "org" },
    ]);
    const opts = getUsageFilterOptions("2024-01-01", "2024-01-31");
    expect(opts.products).toEqual(["actions", "copilot"]);
    expect(opts.organizations).toEqual(["org1", "org2"]);
    expect(opts.costCenters).toEqual(["cc1", "cc2"]);
  });
});

describe("getPremiumFilterOptions", () => {
  it("returns distinct premium filter values", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-10", product: "copilot", sku: "p2", quantity: 50, unit_type: "token", applied_cost_per_quantity: 0.02, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev2", organization: "org2", model: "claude-3", exceeds_quota: "FALSE", total_monthly_quota: 300, charge_scope: "user" },
    ]);
    const opts = getPremiumFilterOptions("2024-01-01", "2024-01-31");
    expect(opts.models).toEqual(["claude-3", "gpt-4"]);
    expect(opts.organizations).toEqual(["org1", "org2"]);
    expect(opts.users).toEqual(["dev1", "dev2"]);
  });
});

describe("getProductBreakdown", () => {
  it("groups by product and charge_scope", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-10", product: "actions", sku: "s2", quantity: 5, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const breakdown = getProductBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].total_net).toBe(10); // copilot has higher net, sorted DESC
  });
});

describe("getOrgBreakdown", () => {
  it("groups by organization", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-10", product: "copilot", sku: "s2", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const breakdown = getOrgBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].organization).toBe("org1");
  });
});

describe("getUserBreakdown", () => {
  it("groups by username", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "dev1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const breakdown = getUserBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].username).toBe("dev1");
    expect(breakdown[0].total_net).toBe(10);
  });
});

describe("getUsageRecordsPaginated", () => {
  it("paginates results correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-11", product: "copilot", sku: "s2", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const page1 = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 1, "date", "asc");
    expect(page1.total).toBe(2);
    expect(page1.records).toHaveLength(1);
  });

  it("supports search filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "alice", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-10", product: "actions", sku: "s2", quantity: 1, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 1, discount_amount: 0, net_amount: 1, organization: "org1", repository: "", username: "bob", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", "alice");
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("alice");
  });

  it("supports product and charge_scope filters", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "filteruser", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-13", product: "actions", sku: "s2", quantity: 2, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 2, discount_amount: 0, net_amount: 2, organization: "org1", repository: "", username: "filteruser", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { product: ["copilot"], chargeScope: "user" });
    expect(result.records.every(r => r.product === "copilot")).toBe(true);
  });

  it("supports username filter in appendBillingFilters", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "target-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-01-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "other-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { username: "target-user" });
    expect(result.records.every(r => r.username === "target-user")).toBe(true);
    expect(result.total).toBe(1);
  });

  it("supports allowedLogins scope filter", () => {
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { allowedLogins: ["alice"] });
    expect(result.records.every(r => r.username === "alice")).toBe(true);
  });

  it("supports scopeOrgs filter (team/org scope)", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-15", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "scope-org", repository: "", username: "scopeuser", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-15", "2024-01-15", 1, 10, "date", "asc", undefined, { scopeOrgs: ["scope-org"] });
    expect(result.records.every(r => r.organization === "scope-org")).toBe(true);
  });

  it("returns nothing when org+scopeOrgs have no intersection", () => {
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { organization: ["nonexistent"], scopeOrgs: ["also-nonexistent"] });
    expect(result.total).toBe(0);
  });

  it("applies org+scopeOrgs intersection filter when both overlap", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-02-20", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "shared-org", repository: "", username: "isect-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2024-02-20", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "other-org", repository: "", username: "other-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2024-02-20", "2024-02-20", 1, 10, "date", "asc", undefined, { organization: ["shared-org", "other-org"], scopeOrgs: ["shared-org"] });
    expect(result.records.every(r => r.organization === "shared-org")).toBe(true);
    expect(result.total).toBe(1);
  });

  it("supports sku filter", () => {
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { sku: ["s1"] });
    expect(result.records.every(r => r.sku === "s1")).toBe(true);
  });

  it("supports costCenter filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-16", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "ccuser", workflow_path: "", cost_center_name: "engineering", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-16", "2024-01-16", 1, 10, "date", "asc", undefined, { costCenter: "engineering" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records[0].cost_center_name).toBe("engineering");
  });

  it("supports combined allowedLogins + scopeOrgs (OR clause)", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-02-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "combo-org", repository: "", username: "combo-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2024-02-10", "2024-02-10", 1, 10, "date", "asc", undefined, { allowedLogins: ["combo-user"], scopeOrgs: ["combo-org"] });
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when allowedLogins is empty array with no scopeOrgs", () => {
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { allowedLogins: [] });
    expect(result.total).toBe(0);
  });

  it("falls back to date sort for unknown sort field", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2024-01-01", "2024-01-31", 1, 10, "invalid_col", "desc");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

describe("getPremiumRequestsPaginated", () => {
  it("paginates premium records", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-11", product: "copilot", sku: "p2", quantity: 200, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 2, discount_amount: 0, net_amount: 2, username: "dev2", organization: "org1", model: "claude-3", exceeds_quota: "FALSE", total_monthly_quota: 300, charge_scope: "user" },
    ]);
    const page1 = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 1, "date", "asc");
    expect(page1.total).toBe(2);
    expect(page1.records).toHaveLength(1);
  });

  it("supports search filter", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-12", product: "copilot", sku: "p1", quantity: 10, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.1, discount_amount: 0, net_amount: 0.1, username: "search-user", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", "search-user");
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("search-user");
  });

  it("supports model filter", () => {
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { model: ["gpt-4"] });
    expect(result.records.every(r => r.model === "gpt-4")).toBe(true);
  });

  it("supports exceedsQuota filter", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-13", product: "copilot", sku: "p1", quantity: 999, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 9.99, discount_amount: 0, net_amount: 9.99, username: "heavy-user", organization: "org1", model: "gpt-4", exceeds_quota: "TRUE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { exceedsQuota: true });
    expect(result.records.every(r => r.exceeds_quota === "TRUE")).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("supports organization filter", () => {
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { organization: ["org1"] });
    expect(result.records.every(r => r.organization === "org1")).toBe(true);
  });

  it("supports allowedLogins scope filter", () => {
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { allowedLogins: ["dev1"] });
    expect(result.records.every(r => r.username === "dev1")).toBe(true);
  });

  it("supports username filter in appendPremiumFilters", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-14", product: "copilot", sku: "p1", quantity: 10, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.1, discount_amount: 0, net_amount: 0.1, username: "prem-target", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-14", product: "copilot", sku: "p1", quantity: 5, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.05, discount_amount: 0, net_amount: 0.05, username: "prem-other", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-01-14", "2024-01-14", 1, 10, "date", "asc", undefined, { username: "prem-target" });
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("prem-target");
  });

  it("applies org+scopeOrgs intersection for premium requests", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-02-20", product: "copilot", sku: "p1", quantity: 50, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.5, discount_amount: 0, net_amount: 0.5, username: "prem-u1", organization: "prem-shared", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-02-20", product: "copilot", sku: "p1", quantity: 30, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.3, discount_amount: 0, net_amount: 0.3, username: "prem-u2", organization: "prem-other", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-02-20", "2024-02-20", 1, 10, "date", "asc", undefined, { organization: ["prem-shared", "prem-other"], scopeOrgs: ["prem-shared"] });
    expect(result.records.every(r => r.organization === "prem-shared")).toBe(true);
  });

  it("returns empty when org+scopeOrgs intersection is empty", () => {
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { organization: ["no-match"], scopeOrgs: ["other-scope"] });
    expect(result.total).toBe(0);
  });

  it("returns empty when allowedLogins is empty with no active scopeOrgs", () => {
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "date", "asc", undefined, { allowedLogins: [] });
    expect(result.total).toBe(0);
  });

  it("falls back to date sort for unknown premium sort field", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-01-01", "2024-01-31", 1, 10, "bad_field", "asc");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by exceedsQuota false", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-03-01", product: "copilot", sku: "p1", quantity: 10, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.1, discount_amount: 0, net_amount: 0.1, username: "q-user", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-03-01", "2024-03-01", 1, 10, "date", "asc", undefined, { exceedsQuota: false });
    expect(result.records.every(r => r.exceeds_quota === "FALSE")).toBe(true);
  });

  it("filters by scopeOrgs alone without page-level org filter", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-03-02", product: "copilot", sku: "p1", quantity: 20, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 0.2, discount_amount: 0, net_amount: 0.2, username: "scope-u", organization: "scoped-org", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const result = getPremiumRequestsPaginated("2024-03-02", "2024-03-02", 1, 10, "date", "asc", undefined, { scopeOrgs: ["scoped-org"] });
    expect(result.total).toBe(1);
  });
});

describe("getPremiumUserSummary", () => {
  it("aggregates per user", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-11", product: "copilot", sku: "p2", quantity: 50, unit_type: "token", applied_cost_per_quantity: 0.02, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "claude-3", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const summary = getPremiumUserSummary("2024-01-01", "2024-01-31");
    expect(summary).toHaveLength(1);
    expect(summary[0].username).toBe("dev1");
    expect(summary[0].total_requests).toBe(150);
  });
});

describe("getPremiumModelSummary", () => {
  it("aggregates per model", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-10", product: "copilot", sku: "p2", quantity: 200, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 2, discount_amount: 0, net_amount: 2, username: "dev2", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 300, charge_scope: "user" },
    ]);
    const summary = getPremiumModelSummary("2024-01-01", "2024-01-31");
    expect(summary).toHaveLength(1);
    expect(summary[0].model).toBe("gpt-4");
    expect(summary[0].total_requests).toBe(300);
    expect(summary[0].unique_users).toBe(2);
  });
});

describe("getCostCenterBreakdown", () => {
  it("groups by cost center", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "engineering", charge_scope: "org" },
    ]);
    const breakdown = getCostCenterBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].cost_center_name).toBe("engineering");
  });
});

describe("getRepositoryBreakdown", () => {
  it("groups by repository", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "actions", sku: "s1", quantity: 100, unit_type: "min", applied_cost_per_quantity: 0.1, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "org1/repo-a", username: "", workflow_path: ".github/workflows/ci.yml", cost_center_name: "", charge_scope: "org" },
    ]);
    const breakdown = getRepositoryBreakdown("2024-01-01", "2024-01-31");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].repository).toBe("org1/repo-a");
  });
});

describe("getPremiumDailyTrend", () => {
  it("groups by day", () => {
    upsertPremiumRequests("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "p1", quantity: 100, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1, discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
      { date: "2024-01-11", product: "copilot", sku: "p2", quantity: 200, unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 2, discount_amount: 0, net_amount: 2, username: "dev1", organization: "org1", model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" },
    ]);
    const trend = getPremiumDailyTrend("2024-01-01", "2024-01-31");
    expect(trend).toHaveLength(2);
    expect(trend[0].day).toBe("2024-01-10");
  });
});

describe("refreshBillingDailyAggregates", () => {
  it("populates daily aggregate table from usage records", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    refreshBillingDailyAggregates("ent1");
    const rows = db.prepare("SELECT * FROM billing_daily_aggregate WHERE enterprise_slug = 'ent1'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].total_net).toBe(10);
  });

  it("refreshes all enterprises when no slug provided", () => {
    upsertUsageRecords("ent2", [
      { date: "2024-01-17", product: "actions", sku: "s2", quantity: 5, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org2", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    refreshBillingDailyAggregates();
    const rows = db.prepare("SELECT * FROM billing_daily_aggregate").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("appendBillingFilters edge cases", () => {
  it("returns nothing when org+scopeOrgs have empty intersection", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2024-01-01", "2024-01-31", { organization: ["org1"], scopeOrgs: ["different-org"] });
    expect(result.totalNet).toBe(0);
  });

  it("returns nothing when allowedLogins is empty array", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2024-01-01", "2024-01-31", { allowedLogins: [] });
    expect(result.totalNet).toBe(0);
  });

  it("filters by scopeOrgs alone without page-level org filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2024-01-01", "2024-01-31", { scopeOrgs: ["org1"] });
    expect(result.totalNet).toBe(10);
  });

  it("getOverviewKPIs with enterpriseSlugs triggers enterprise filter + premium ?? 0 fallback", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    // No premium requests → premium query returns undefined → ?? 0 fallbacks fire
    const result = getOverviewKPIs("2024-01-01", "2024-01-31", undefined, ["ent1"]);
    expect(result.totalNet).toBe(5);
    // Non-matching enterprise returns 0
    const empty = getOverviewKPIs("2024-01-01", "2024-01-31", undefined, ["no-match"]);
    expect(empty.totalNet).toBe(0);
  });

  it("getDailyAggregates with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getDailyAggregates("2024-01-01", "2024-01-31", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
    const empty = getDailyAggregates("2024-01-01", "2024-01-31", undefined, ["no-match"]);
    expect(empty.length).toBe(0);
  });

  it("getProductBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getProductBreakdown("2024-01-01", "2024-01-31", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getOrgBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getOrgBreakdown("2024-01-01", "2024-01-31", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getUserBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2024-01-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getUserBreakdown("2024-01-01", "2024-01-31", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });
});
