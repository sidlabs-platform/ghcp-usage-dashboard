import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

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
  getPremiumCostCenterBreakdown,
  getPremiumOrgBreakdown,
  getRepositoryBreakdown,
  getPremiumDailyTrend,
  refreshBillingDailyAggregates,
} from "./billing-repo";
import type { BillingPremiumRequestRecord } from "@/lib/types/billing";

/** Factory for premium request records with sensible defaults. */
function makePremiumRecord(overrides: Partial<BillingPremiumRequestRecord> = {}): BillingPremiumRequestRecord {
  // Merge with defaults first
  const merged = {
    date: "2026-06-10", product: "copilot", sku: "prem1", quantity: 100,
    unit_type: "token", applied_cost_per_quantity: 0.01, gross_amount: 1,
    discount_amount: 0, net_amount: 1, username: "dev1", organization: "org1",
    model: "gpt-4", exceeds_quota: "FALSE", total_monthly_quota: 500,
    charge_scope: "user" as const, input_tokens: 0, output_tokens: 0, cached_tokens: 0,
    cost_center_name: "", aic_quantity: 100, aic_gross_amount: 1.6,
    ...overrides,
  };
  
  // If aic_quantity wasn't explicitly set and quantity was, derive aic_quantity from quantity
  if (overrides.aic_quantity === undefined && overrides.quantity !== undefined) {
    merged.aic_quantity = overrides.quantity;
  }
  
  return merged;
}

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
      { date: "2026-06-10", product: "copilot", sku: "sku1", quantity: 5, unit_type: "seat", applied_cost_per_quantity: 2, gross_amount: 10, discount_amount: 1, net_amount: 9, organization: "org1", repository: "repo1", username: "user1", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
    ]);
    const rows = db.prepare("SELECT * FROM billing_usage_records").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].product).toBe("copilot");
    expect(rows[0].net_amount).toBe(9);
  });

  it("upserts on conflict", () => {
    const rec = { date: "2026-06-10", product: "copilot", sku: "sku1", quantity: 5, unit_type: "seat", applied_cost_per_quantity: 2, gross_amount: 10, discount_amount: 1, net_amount: 9, organization: "org1", repository: "repo1", username: "user1", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" };
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
      makePremiumRecord({ input_tokens: 1000, output_tokens: 400, cached_tokens: 250 }),
    ]);
    const rows = db.prepare("SELECT * FROM billing_premium_requests").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("gpt-4");
    expect(rows[0].input_tokens).toBe(1000);
    expect(rows[0].output_tokens).toBe(400);
    expect(rows[0].cached_tokens).toBe(250);
  });
});

describe("getOverviewKPIs", () => {
  it("returns zeros with no data", () => {
    const kpis = getOverviewKPIs("2026-06-01", "2026-06-30");
    expect(kpis.totalNet).toBe(0);
    expect(kpis.totalGross).toBe(0);
  });

  it("sums usage and premium amounts", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 2, net_amount: 8, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", quantity: 50, applied_cost_per_quantity: 0.1, gross_amount: 5, net_amount: 5, username: "u1", total_monthly_quota: 200 }),
    ]);
    const kpis = getOverviewKPIs("2026-06-01", "2026-06-30");
    expect(kpis.totalNet).toBe(13); // 8 + 5
    expect(kpis.totalGross).toBe(15); // 10 + 5
  });

  it("applies billing filters to KPIs", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-14", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 20, gross_amount: 20, discount_amount: 0, net_amount: 20, organization: "filtered-org", repository: "", username: "kpiuser", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
      { date: "2026-06-14", product: "actions", sku: "s2", quantity: 1, unit_type: "min", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "other-org", repository: "", username: "other", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const kpis = getOverviewKPIs("2026-06-14", "2026-06-14", { organization: ["filtered-org"] });
    expect(kpis.totalNet).toBeGreaterThanOrEqual(20);
    expect(kpis.uniqueOrgs).toBeGreaterThanOrEqual(1);
  });

  it("filters by enterprise slug", () => {
    upsertUsageRecords("ent-a", [
      { date: "2026-06-01", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 100, gross_amount: 100, discount_amount: 0, net_amount: 100, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    upsertUsageRecords("ent-b", [
      { date: "2026-06-01", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 50, gross_amount: 50, discount_amount: 0, net_amount: 50, organization: "org2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const kpis = getOverviewKPIs("2026-06-01", "2026-06-01", undefined, ["ent-a"]);
    expect(kpis.totalNet).toBe(100);
  });

  it("applies scopeOrgs filter to premium KPIs", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-05", sku: "p1", quantity: 10, applied_cost_per_quantity: 1, gross_amount: 10, net_amount: 10, username: "u1", organization: "scoped-org", total_monthly_quota: 100 }),
      makePremiumRecord({ date: "2026-06-05", sku: "p2", quantity: 20, applied_cost_per_quantity: 1, gross_amount: 20, net_amount: 20, username: "u2", organization: "other-org", total_monthly_quota: 100 }),
    ]);
    const kpis = getOverviewKPIs("2026-06-05", "2026-06-05", { scopeOrgs: ["scoped-org"] });
    expect(kpis.totalNet).toBeGreaterThanOrEqual(10);
  });
});

describe("getDailyAggregates", () => {
  it("groups by day, product, charge_scope", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-10", product: "copilot", sku: "s2", quantity: 2, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "o2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const aggs = getDailyAggregates("2026-06-01", "2026-06-30");
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
    updateBillingSyncState("detailed", "2026-06-10T00:00:00Z", "2026-06-01", "2026-06-10", "ok", undefined, "ent1");
    const state = getBillingSyncState("detailed", "ent1");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("ok");
    expect(state!.last_report_start).toBe("2026-06-01");
  });

  it("upserts on conflict", () => {
    updateBillingSyncState("detailed", "2026-06-10T00:00:00Z", "2026-06-01", "2026-06-10", "syncing", undefined, "ent1");
    updateBillingSyncState("detailed", "2026-06-11T00:00:00Z", "2026-06-01", "2026-06-11", "ok", undefined, "ent1");
    const state = getBillingSyncState("detailed", "ent1");
    expect(state!.status).toBe("ok");
    expect(state!.last_report_end).toBe("2026-06-11");
  });
});

describe("getUsageFilterOptions", () => {
  it("returns distinct filter values", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
      { date: "2026-06-10", product: "actions", sku: "s2", quantity: 2, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 2, discount_amount: 0, net_amount: 2, organization: "org2", repository: "", username: "", workflow_path: "", cost_center_name: "cc2", charge_scope: "org" },
    ]);
    const opts = getUsageFilterOptions("2026-06-01", "2026-06-30");
    expect(opts.products).toEqual(["actions", "copilot"]);
    expect(opts.organizations).toEqual(["org1", "org2"]);
    expect(opts.costCenters).toEqual(["cc1", "cc2"]);
  });
});

describe("getPremiumFilterOptions", () => {
  it("returns distinct premium filter values", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1" }),
      makePremiumRecord({ sku: "p2", quantity: 50, applied_cost_per_quantity: 0.02, username: "dev2", organization: "org2", model: "claude-3", total_monthly_quota: 300 }),
    ]);
    const opts = getPremiumFilterOptions("2026-06-01", "2026-06-30");
    expect(opts.models).toEqual(["claude-3", "gpt-4"]);
    expect(opts.organizations).toEqual(["org1", "org2"]);
    expect(opts.users).toEqual(["dev1", "dev2"]);
  });
});

describe("getProductBreakdown", () => {
  it("groups by product and charge_scope", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-10", product: "actions", sku: "s2", quantity: 5, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const breakdown = getProductBreakdown("2026-06-01", "2026-06-30");
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].total_net).toBe(10); // copilot has higher net, sorted DESC
  });
});

describe("getOrgBreakdown", () => {
  it("groups by organization", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-10", product: "copilot", sku: "s2", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org2", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const breakdown = getOrgBreakdown("2026-06-01", "2026-06-30");
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].organization).toBe("org1");
  });
});

describe("getUserBreakdown", () => {
  it("groups by username", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "dev1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const breakdown = getUserBreakdown("2026-06-01", "2026-06-30");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].username).toBe("dev1");
    expect(breakdown[0].total_net).toBe(10);
  });
});

describe("getUsageRecordsPaginated", () => {
  it("paginates results correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-11", product: "copilot", sku: "s2", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "u2", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const page1 = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 1, "date", "asc");
    expect(page1.total).toBe(2);
    expect(page1.records).toHaveLength(1);
  });

  it("supports search filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "alice", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-10", product: "actions", sku: "s2", quantity: 1, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 1, discount_amount: 0, net_amount: 1, organization: "org1", repository: "", username: "bob", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", "alice");
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("alice");
  });

  it("supports product and charge_scope filters", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "filteruser", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-13", product: "actions", sku: "s2", quantity: 2, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 2, discount_amount: 0, net_amount: 2, organization: "org1", repository: "", username: "filteruser", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { product: ["copilot"], chargeScope: "user" });
    expect(result.records.every(r => r.product === "copilot")).toBe(true);
  });

  it("supports username filter in appendBillingFilters", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "target-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-13", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "other-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { username: "target-user" });
    expect(result.records.every(r => r.username === "target-user")).toBe(true);
    expect(result.total).toBe(1);
  });

  it("supports allowedLogins scope filter", () => {
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { allowedLogins: ["alice"] });
    expect(result.records.every(r => r.username === "alice")).toBe(true);
  });

  it("supports scopeOrgs filter (team/org scope)", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-15", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "scope-org", repository: "", username: "scopeuser", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-15", "2026-06-15", 1, 10, "date", "asc", undefined, { scopeOrgs: ["scope-org"] });
    expect(result.records.every(r => r.organization === "scope-org")).toBe(true);
  });

  it("returns nothing when org+scopeOrgs have no intersection", () => {
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { organization: ["nonexistent"], scopeOrgs: ["also-nonexistent"] });
    expect(result.total).toBe(0);
  });

  it("applies org+scopeOrgs intersection filter when both overlap", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-20", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "shared-org", repository: "", username: "isect-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
      { date: "2026-06-20", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "other-org", repository: "", username: "other-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-20", "2026-06-20", 1, 10, "date", "asc", undefined, { organization: ["shared-org", "other-org"], scopeOrgs: ["shared-org"] });
    expect(result.records.every(r => r.organization === "shared-org")).toBe(true);
    expect(result.total).toBe(1);
  });

  it("supports sku filter", () => {
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { sku: ["s1"] });
    expect(result.records.every(r => r.sku === "s1")).toBe(true);
  });

  it("supports costCenter filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-16", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "ccuser", workflow_path: "", cost_center_name: "engineering", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-16", "2026-06-16", 1, 10, "date", "asc", undefined, { costCenter: "engineering" });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.records[0].cost_center_name).toBe("engineering");
  });

  it("supports combined allowedLogins + scopeOrgs (OR clause)", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "combo-org", repository: "", username: "combo-user", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-10", "2026-06-10", 1, 10, "date", "asc", undefined, { allowedLogins: ["combo-user"], scopeOrgs: ["combo-org"] });
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("returns empty when allowedLogins is empty array with no scopeOrgs", () => {
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { allowedLogins: [] });
    expect(result.total).toBe(0);
  });

  it("falls back to date sort for unknown sort field", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "invalid_col", "desc");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

describe("getPremiumRequestsPaginated", () => {
  it("paginates premium records", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", input_tokens: 1000, output_tokens: 400, cached_tokens: 250 }),
      makePremiumRecord({ date: "2026-06-11", sku: "p2", quantity: 200, gross_amount: 2, net_amount: 2, username: "dev2", model: "claude-3", total_monthly_quota: 300, input_tokens: 2000, output_tokens: 800, cached_tokens: 500 }),
    ]);
    const page1 = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 1, "date", "asc");
    expect(page1.total).toBe(2);
    expect(page1.records).toHaveLength(1);
    expect(page1.records[0].input_tokens).toBe(1000);
    expect(page1.records[0].output_tokens).toBe(400);
    expect(page1.records[0].cached_tokens).toBe(250);
  });

  it("supports search filter", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-12", sku: "p1", quantity: 10, gross_amount: 0.1, net_amount: 0.1, username: "search-user" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", "search-user");
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("search-user");
  });

  it("supports model filter", () => {
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { model: ["gpt-4"] });
    expect(result.records.every(r => r.model === "gpt-4")).toBe(true);
  });

  it("supports exceedsQuota filter", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-13", sku: "p1", quantity: 999, gross_amount: 9.99, net_amount: 9.99, username: "heavy-user", exceeds_quota: "TRUE" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { exceedsQuota: true });
    expect(result.records.every(r => r.exceeds_quota === "TRUE")).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("supports organization filter", () => {
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { organization: ["org1"] });
    expect(result.records.every(r => r.organization === "org1")).toBe(true);
  });

  it("supports allowedLogins scope filter", () => {
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { allowedLogins: ["dev1"] });
    expect(result.records.every(r => r.username === "dev1")).toBe(true);
  });

  it("supports username filter in appendPremiumFilters", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-14", sku: "p1", quantity: 10, gross_amount: 0.1, net_amount: 0.1, username: "prem-target" }),
      makePremiumRecord({ date: "2026-06-14", sku: "p1", quantity: 5, gross_amount: 0.05, net_amount: 0.05, username: "prem-other" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-14", "2026-06-14", 1, 10, "date", "asc", undefined, { username: "prem-target" });
    expect(result.total).toBe(1);
    expect(result.records[0].username).toBe("prem-target");
  });

  it("applies org+scopeOrgs intersection for premium requests", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-20", sku: "p1", quantity: 50, gross_amount: 0.5, net_amount: 0.5, username: "prem-u1", organization: "prem-shared" }),
      makePremiumRecord({ date: "2026-06-20", sku: "p1", quantity: 30, gross_amount: 0.3, net_amount: 0.3, username: "prem-u2", organization: "prem-other" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-20", "2026-06-20", 1, 10, "date", "asc", undefined, { organization: ["prem-shared", "prem-other"], scopeOrgs: ["prem-shared"] });
    expect(result.records.every(r => r.organization === "prem-shared")).toBe(true);
  });

  it("returns empty when org+scopeOrgs intersection is empty", () => {
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { organization: ["no-match"], scopeOrgs: ["other-scope"] });
    expect(result.total).toBe(0);
  });

  it("returns empty when allowedLogins is empty with no active scopeOrgs", () => {
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, { allowedLogins: [] });
    expect(result.total).toBe(0);
  });

  it("falls back to date sort for unknown premium sort field", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord(),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "bad_field", "asc");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by exceedsQuota false", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-01", quantity: 10, gross_amount: 0.1, net_amount: 0.1, username: "q-user" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-01", "2026-06-01", 1, 10, "date", "asc", undefined, { exceedsQuota: false });
    expect(result.records.every(r => r.exceeds_quota === "FALSE")).toBe(true);
  });

  it("filters by scopeOrgs alone without page-level org filter", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ date: "2026-06-02", quantity: 20, gross_amount: 0.2, net_amount: 0.2, username: "scope-u", organization: "scoped-org" }),
    ]);
    const result = getPremiumRequestsPaginated("2026-06-02", "2026-06-02", 1, 10, "date", "asc", undefined, { scopeOrgs: ["scoped-org"] });
    expect(result.total).toBe(1);
  });
});

describe("getPremiumUserSummary", () => {
  it("aggregates per user", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", input_tokens: 1000, output_tokens: 400, cached_tokens: 250 }),
      makePremiumRecord({ date: "2026-06-11", sku: "p2", quantity: 50, applied_cost_per_quantity: 0.02, model: "claude-3", input_tokens: 500, output_tokens: 200, cached_tokens: 100 }),
    ]);
    const summary = getPremiumUserSummary("2026-06-01", "2026-06-30");
    expect(summary).toHaveLength(1);
    expect(summary[0].username).toBe("dev1");
    expect(summary[0].total_requests).toBe(150);
    expect(summary[0].total_input_tokens).toBe(1500);
    expect(summary[0].total_output_tokens).toBe(600);
    expect(summary[0].total_cached_tokens).toBe(350);
  });
});

describe("getPremiumModelSummary", () => {
  it("aggregates per model", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", input_tokens: 1000, output_tokens: 400, cached_tokens: 250 }),
      makePremiumRecord({ sku: "p2", quantity: 200, gross_amount: 2, net_amount: 2, username: "dev2", total_monthly_quota: 300, input_tokens: 2000, output_tokens: 900, cached_tokens: 500 }),
    ]);
    const summary = getPremiumModelSummary("2026-06-01", "2026-06-30");
    expect(summary).toHaveLength(1);
    expect(summary[0].model).toBe("gpt-4");
    expect(summary[0].total_requests).toBe(300);
    expect(summary[0].unique_users).toBe(2);
    expect(summary[0].total_input_tokens).toBe(3000);
    expect(summary[0].total_output_tokens).toBe(1300);
    expect(summary[0].total_cached_tokens).toBe(750);
  });
});

describe("getCostCenterBreakdown", () => {
  it("groups by cost center", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "engineering", charge_scope: "org" },
    ]);
    const breakdown = getCostCenterBreakdown("2026-06-01", "2026-06-30");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].cost_center_name).toBe("engineering");
  });
});

describe("getPremiumCostCenterBreakdown", () => {
  it("returns empty array with no data", () => {
    expect(getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30")).toEqual([]);
  });

  it("groups AI credits by cost center and keeps an unattributed bucket", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", cost_center_name: "engineering", aic_quantity: 100, aic_gross_amount: 2 }),
      makePremiumRecord({ sku: "p2", username: "dev2", cost_center_name: "engineering", aic_quantity: 50, aic_gross_amount: 1 }),
      makePremiumRecord({ sku: "p3", username: "dev3", cost_center_name: "", aic_quantity: 30, aic_gross_amount: 0.5 }),
    ]);
    const rows = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30");
    expect(rows).toHaveLength(2);

    const eng = rows.find((r) => r.cost_center_name === "engineering")!;
    expect(eng.total_aic_quantity).toBe(150);
    expect(eng.total_aic_gross).toBeCloseTo(3, 5);
    expect(eng.unique_users).toBe(2);
    expect(eng.record_count).toBe(2);

    const unattributed = rows.find((r) => r.cost_center_name === "")!;
    expect(unattributed).toBeDefined();
    expect(unattributed.total_aic_quantity).toBe(30);
    expect(unattributed.total_aic_gross).toBeCloseTo(0.5, 5);
    expect(unattributed.unique_users).toBe(1);
  });

  it("orders rows by AI credits descending", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", cost_center_name: "small", aic_quantity: 10, aic_gross_amount: 0.1 }),
      makePremiumRecord({ sku: "p2", username: "dev2", cost_center_name: "large", aic_quantity: 500, aic_gross_amount: 5 }),
    ]);
    const rows = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30");
    expect(rows[0].cost_center_name).toBe("large");
    expect(rows[1].cost_center_name).toBe("small");
  });

  it("breaks ties by cost_center_name ascending", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", cost_center_name: "beta", aic_quantity: 100, aic_gross_amount: 2 }),
      makePremiumRecord({ sku: "p2", username: "dev2", cost_center_name: "alpha", aic_quantity: 100, aic_gross_amount: 2 }),
    ]);
    const rows = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30");
    expect(rows.map((r) => r.total_aic_quantity)).toEqual([100, 100]);
    expect(rows.map((r) => r.total_aic_gross)).toEqual([2, 2]);
    expect(rows.map((r) => r.cost_center_name)).toEqual(["alpha", "beta"]);
  });

  it("respects model filter", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", cost_center_name: "cc", model: "gpt-4", aic_quantity: 100, aic_gross_amount: 2 }),
      makePremiumRecord({ sku: "p2", username: "dev2", cost_center_name: "cc", model: "gpt-5", aic_quantity: 40, aic_gross_amount: 1 }),
    ]);
    const rows = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30", { model: ["gpt-4"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].total_aic_quantity).toBe(100);
    expect(rows[0].unique_users).toBe(1);
  });

  it("filters by enterprise slug", () => {
    upsertPremiumRequests("ent1", [makePremiumRecord({ sku: "p1", username: "u1", cost_center_name: "cc" })]);
    upsertPremiumRequests("ent2", [makePremiumRecord({ sku: "p1", username: "u2", cost_center_name: "cc" })]);
    const rows = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].unique_users).toBe(1);
    const none = getPremiumCostCenterBreakdown("2026-06-01", "2026-06-30", undefined, ["no-match"]);
    expect(none).toEqual([]);
  });
});

describe("getPremiumOrgBreakdown", () => {
  it("returns empty array with no data", () => {
    expect(getPremiumOrgBreakdown("2026-06-01", "2026-06-30")).toEqual([]);
  });

  it("groups AI credits by org and keeps an org-less unattributed bucket", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", organization: "org1", aic_quantity: 100, aic_gross_amount: 2 }),
      makePremiumRecord({ sku: "p2", username: "dev2", organization: "org1", aic_quantity: 25, aic_gross_amount: 0.5 }),
      makePremiumRecord({ sku: "p3", username: "dev3", organization: "", aic_quantity: 70, aic_gross_amount: 1.2 }),
    ]);
    const rows = getPremiumOrgBreakdown("2026-06-01", "2026-06-30");
    expect(rows).toHaveLength(2);

    const org1 = rows.find((r) => r.organization === "org1")!;
    expect(org1.total_aic_quantity).toBe(125);
    expect(org1.total_aic_gross).toBeCloseTo(2.5, 5);
    expect(org1.unique_users).toBe(2);
    expect(org1.record_count).toBe(2);

    const orgless = rows.find((r) => r.organization === "")!;
    expect(orgless).toBeDefined();
    expect(orgless.total_aic_quantity).toBe(70);
    expect(orgless.unique_users).toBe(1);
  });

  it("orders rows by AI credits descending", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", organization: "small", aic_quantity: 5, aic_gross_amount: 0.1 }),
      makePremiumRecord({ sku: "p2", username: "dev2", organization: "big", aic_quantity: 900, aic_gross_amount: 9 }),
    ]);
    const rows = getPremiumOrgBreakdown("2026-06-01", "2026-06-30");
    expect(rows[0].organization).toBe("big");
    expect(rows[1].organization).toBe("small");
  });

  it("breaks ties by organization ascending", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "dev1", organization: "beta", aic_quantity: 100, aic_gross_amount: 2 }),
      makePremiumRecord({ sku: "p2", username: "dev2", organization: "alpha", aic_quantity: 100, aic_gross_amount: 2 }),
    ]);
    const rows = getPremiumOrgBreakdown("2026-06-01", "2026-06-30");
    expect(rows.map((r) => r.total_aic_quantity)).toEqual([100, 100]);
    expect(rows.map((r) => r.total_aic_gross)).toEqual([2, 2]);
    expect(rows.map((r) => r.organization)).toEqual(["alpha", "beta"]);
  });

  it("filters by enterprise slug", () => {
    upsertPremiumRequests("ent1", [makePremiumRecord({ sku: "p1", username: "u1", organization: "org1" })]);
    upsertPremiumRequests("ent2", [makePremiumRecord({ sku: "p1", username: "u2", organization: "org2" })]);
    const rows = getPremiumOrgBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization).toBe("org1");
    const none = getPremiumOrgBreakdown("2026-06-01", "2026-06-30", undefined, ["no-match"]);
    expect(none).toEqual([]);
  });
});

describe("getRepositoryBreakdown", () => {
  it("groups by repository", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "actions", sku: "s1", quantity: 100, unit_type: "min", applied_cost_per_quantity: 0.1, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "org1/repo-a", username: "", workflow_path: ".github/workflows/ci.yml", cost_center_name: "", charge_scope: "org" },
    ]);
    const breakdown = getRepositoryBreakdown("2026-06-01", "2026-06-30");
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].repository).toBe("org1/repo-a");
  });
});

describe("getPremiumDailyTrend", () => {
  it("groups by day", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", input_tokens: 1000, output_tokens: 400, cached_tokens: 250 }),
      makePremiumRecord({ date: "2026-06-11", sku: "p2", quantity: 200, gross_amount: 2, net_amount: 2, input_tokens: 2000, output_tokens: 800, cached_tokens: 500 }),
    ]);
    const trend = getPremiumDailyTrend("2026-06-01", "2026-06-30");
    expect(trend).toHaveLength(2);
    expect(trend[0].day).toBe("2026-06-10");
    expect(trend[0].total_input_tokens).toBe(1000);
    expect(trend[0].total_output_tokens).toBe(400);
    expect(trend[0].total_cached_tokens).toBe(250);
  });
});

describe("refreshBillingDailyAggregates", () => {
  it("populates daily aggregate table from usage records", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    refreshBillingDailyAggregates("ent1");
    const rows = db.prepare("SELECT * FROM billing_daily_aggregate WHERE enterprise_slug = 'ent1'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].total_net).toBe(10);
  });

  it("refreshes all enterprises when no slug provided", () => {
    upsertUsageRecords("ent2", [
      { date: "2026-06-17", product: "actions", sku: "s2", quantity: 5, unit_type: "min", applied_cost_per_quantity: 1, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org2", repository: "", username: "", workflow_path: "", cost_center_name: "", charge_scope: "org" },
    ]);
    refreshBillingDailyAggregates();
    const rows = db.prepare("SELECT * FROM billing_daily_aggregate").all() as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("appendBillingFilters edge cases", () => {
  it("returns nothing when org+scopeOrgs have empty intersection", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2026-06-01", "2026-06-30", { organization: ["org1"], scopeOrgs: ["different-org"] });
    expect(result.totalNet).toBe(0);
  });

  it("returns nothing when allowedLogins is empty array", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2026-06-01", "2026-06-30", { allowedLogins: [] });
    expect(result.totalNet).toBe(0);
  });

  it("filters by scopeOrgs alone without page-level org filter", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const result = getOverviewKPIs("2026-06-01", "2026-06-30", { scopeOrgs: ["org1"] });
    expect(result.totalNet).toBe(10);
  });

  it("getOverviewKPIs with enterpriseSlugs triggers enterprise filter + premium ?? 0 fallback", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 5, gross_amount: 5, discount_amount: 0, net_amount: 5, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    // No premium requests → premium query returns undefined → ?? 0 fallbacks fire
    const result = getOverviewKPIs("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(result.totalNet).toBe(5);
    // Non-matching enterprise returns 0
    const empty = getOverviewKPIs("2026-06-01", "2026-06-30", undefined, ["no-match"]);
    expect(empty.totalNet).toBe(0);
  });

  it("getDailyAggregates with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getDailyAggregates("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
    const empty = getDailyAggregates("2026-06-01", "2026-06-30", undefined, ["no-match"]);
    expect(empty.length).toBe(0);
  });

  it("getProductBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getProductBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getOrgBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getOrgBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getUserBreakdown with enterpriseSlugs filters correctly", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getUserBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getUsageRecordsPaginated with enterpriseSlugs", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const r = getUsageRecordsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, undefined, ["ent1"]);
    expect(r.total).toBe(1);
  });

  it("getPremiumRequestsPaginated with enterpriseSlugs", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "u1" }),
    ]);
    const r = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 10, "date", "asc", undefined, undefined, ["ent1"]);
    expect(r.total).toBe(1);
  });

  it("getPremiumUserSummary with enterpriseSlugs", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "u1" }),
    ]);
    const rows = getPremiumUserSummary("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getPremiumModelSummary with enterpriseSlugs", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "u1" }),
    ]);
    const rows = getPremiumModelSummary("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getCostCenterBreakdown with enterpriseSlugs", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "", username: "u1", workflow_path: "", cost_center_name: "cc1", charge_scope: "user" },
    ]);
    const rows = getCostCenterBreakdown("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getRepositoryBreakdown with enterpriseSlugs", () => {
    upsertUsageRecords("ent1", [
      { date: "2026-06-10", product: "copilot", sku: "s1", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 10, gross_amount: 10, discount_amount: 0, net_amount: 10, organization: "org1", repository: "org1/repo1", username: "u1", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);
    const rows = getRepositoryBreakdown("2026-06-01", "2026-06-30", undefined, 20, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("getPremiumDailyTrend with enterpriseSlugs", () => {
    upsertPremiumRequests("ent1", [
      makePremiumRecord({ sku: "p1", username: "u1" }),
    ]);
    const rows = getPremiumDailyTrend("2026-06-01", "2026-06-30", undefined, ["ent1"]);
    expect(rows.length).toBe(1);
  });

  it("updateBillingSyncState without enterpriseSlug uses empty string fallback", () => {
    updateBillingSyncState("detailed", "2026-06-10T00:00:00Z", "2026-06-01", "2026-06-10", "ok");
    const state = getBillingSyncState("detailed", "");
    expect(state).not.toBeNull();
    expect(state!.status).toBe("ok");
  });
});

describe("premium requests — multi-enterprise isolation", () => {
  const entA = "enterprise-alpha";
  const entB = "enterprise-beta";
  const premRecA = {
    date: "2026-06-15", product: "copilot", sku: "prem1", quantity: 100, unit_type: "token",
    applied_cost_per_quantity: 0.04, gross_amount: 4, discount_amount: 0, net_amount: 4,
    username: "alice", organization: "org-shared", model: "gpt-4",
    exceeds_quota: "FALSE", total_monthly_quota: 500, charge_scope: "user" as const,
    input_tokens: 2000, output_tokens: 800, cached_tokens: 500,
    cost_center_name: "", aic_quantity: 100, aic_gross_amount: 6.4,
  };
  const premRecB = {
    date: "2026-06-15", product: "copilot", sku: "prem1", quantity: 60, unit_type: "token",
    applied_cost_per_quantity: 0.04, gross_amount: 2.4, discount_amount: 0, net_amount: 2.4,
    username: "alice", organization: "org-shared", model: "claude-3",
    exceeds_quota: "FALSE", total_monthly_quota: 300, charge_scope: "user" as const,
    input_tokens: 1200, output_tokens: 400, cached_tokens: 200,
    cost_center_name: "", aic_quantity: 60, aic_gross_amount: 3.84,
  };

  beforeEach(() => {
    upsertPremiumRequests(entA, [premRecA]);
    upsertPremiumRequests(entB, [premRecB]);
  });

  it("getPremiumRequestsPaginated isolates by enterprise", () => {
    const a = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 50, "date", "desc", undefined, undefined, [entA]);
    expect(a.total).toBe(1);
    expect(a.records[0].model).toBe("gpt-4");
    expect(a.records[0].input_tokens).toBe(2000);

    const b = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 50, "date", "desc", undefined, undefined, [entB]);
    expect(b.total).toBe(1);
    expect(b.records[0].model).toBe("claude-3");
    expect(b.records[0].input_tokens).toBe(1200);

    // No enterprise filter → both
    const all = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 50, "date", "desc");
    expect(all.total).toBe(2);
  });

  it("getPremiumUserSummary aggregates correctly per enterprise", () => {
    const a = getPremiumUserSummary("2026-06-01", "2026-06-30", undefined, [entA]);
    expect(a).toHaveLength(1);
    expect(a[0].total_requests).toBe(100);
    expect(a[0].total_input_tokens).toBe(2000);
    expect(a[0].total_output_tokens).toBe(800);
    expect(a[0].total_cached_tokens).toBe(500);

    // Aggregate (no filter): same user in both enterprises → merges into one row
    const all = getPremiumUserSummary("2026-06-01", "2026-06-30");
    expect(all).toHaveLength(1); // same username+org → grouped
    expect(all[0].total_requests).toBe(160); // 100 + 60
    expect(all[0].total_input_tokens).toBe(3200); // 2000 + 1200
  });

  it("getPremiumModelSummary isolates by enterprise with token sums", () => {
    const a = getPremiumModelSummary("2026-06-01", "2026-06-30", undefined, [entA]);
    expect(a).toHaveLength(1);
    expect(a[0].model).toBe("gpt-4");
    expect(a[0].total_input_tokens).toBe(2000);

    const b = getPremiumModelSummary("2026-06-01", "2026-06-30", undefined, [entB]);
    expect(b).toHaveLength(1);
    expect(b[0].model).toBe("claude-3");
    expect(b[0].total_input_tokens).toBe(1200);

    // No filter → two models
    const all = getPremiumModelSummary("2026-06-01", "2026-06-30");
    expect(all).toHaveLength(2);
  });

  it("getPremiumDailyTrend aggregates by enterprise with tokens", () => {
    const a = getPremiumDailyTrend("2026-06-01", "2026-06-30", undefined, [entA]);
    expect(a).toHaveLength(1);
    expect(a[0].total_requests).toBe(100);
    expect(a[0].total_input_tokens).toBe(2000);
    expect(a[0].total_cached_tokens).toBe(500);

    // Aggregate: same day → merged
    const all = getPremiumDailyTrend("2026-06-01", "2026-06-30");
    expect(all).toHaveLength(1);
    expect(all[0].total_requests).toBe(160);
    expect(all[0].total_input_tokens).toBe(3200);
  });

  it("getPremiumFilterOptions scoped to enterprise", () => {
    const a = getPremiumFilterOptions("2026-06-01", "2026-06-30", [entA]);
    expect(a.models).toEqual(["gpt-4"]);

    const b = getPremiumFilterOptions("2026-06-01", "2026-06-30", [entB]);
    expect(b.models).toEqual(["claude-3"]);

    const all = getPremiumFilterOptions("2026-06-01", "2026-06-30");
    expect(all.models).toEqual(expect.arrayContaining(["claude-3", "gpt-4"]));
  });

  it("getOverviewKPIs includes premium totals scoped by enterprise", () => {
    // Enterprise A has usage + premium
    upsertUsageRecords(entA, [
      { date: "2026-06-15", product: "copilot", sku: "seat", quantity: 1, unit_type: "seat", applied_cost_per_quantity: 19, gross_amount: 19, discount_amount: 0, net_amount: 19, organization: "org-shared", repository: "", username: "alice", workflow_path: "", cost_center_name: "", charge_scope: "user" },
    ]);

    const a = getOverviewKPIs("2026-06-01", "2026-06-30", undefined, [entA]);
    expect(a.totalNet).toBe(19 + 4); // usage net + premium net
    expect(a.userChargesNet).toBe(19 + 4);

    const b = getOverviewKPIs("2026-06-01", "2026-06-30", undefined, [entB]);
    expect(b.totalNet).toBe(2.4); // only premium, no usage in ent-b
  });

  it("non-matching enterprise returns empty results", () => {
    const r = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 50, "date", "desc", undefined, undefined, ["no-such-enterprise"]);
    expect(r.total).toBe(0);

    const summary = getPremiumUserSummary("2026-06-01", "2026-06-30", undefined, ["no-such-enterprise"]);
    expect(summary).toHaveLength(0);

    const trend = getPremiumDailyTrend("2026-06-01", "2026-06-30", undefined, ["no-such-enterprise"]);
    expect(trend).toHaveLength(0);
  });

  it("multi-enterprise selection returns combined data", () => {
    const both = getPremiumRequestsPaginated("2026-06-01", "2026-06-30", 1, 50, "date", "desc", undefined, undefined, [entA, entB]);
    expect(both.total).toBe(2);

    const summary = getPremiumUserSummary("2026-06-01", "2026-06-30", undefined, [entA, entB]);
    expect(summary).toHaveLength(1); // same user/org → grouped
    expect(summary[0].total_requests).toBe(160);
  });
});
