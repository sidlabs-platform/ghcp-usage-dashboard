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
