import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "./sqlite-database";
import path from "path";
import fs from "fs";

let db: Database;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import { upsertUsageRecords, upsertPremiumRequests, getCopilotCostBasis } from "./billing-repo";
import type { BillingPremiumRequestRecord, BillingUsageRecord } from "@/lib/types/billing";

function usage(over: Partial<BillingUsageRecord> = {}): BillingUsageRecord {
  return {
    date: "2026-07-10", product: "copilot", sku: "copilot_enterprise", quantity: 1,
    unit_type: "seat", applied_cost_per_quantity: 39, gross_amount: 39, discount_amount: 0,
    net_amount: 39, organization: "org1", repository: "", username: "dev1",
    workflow_path: "", cost_center_name: "", charge_scope: "user",
    ...over,
  } as BillingUsageRecord;
}

function premium(over: Partial<BillingPremiumRequestRecord> = {}): BillingPremiumRequestRecord {
  return {
    date: "2026-07-10", product: "copilot", sku: "copilot_ai_credit", quantity: 100,
    unit_type: "ai-credits", applied_cost_per_quantity: 0.01, gross_amount: 1,
    discount_amount: 1, net_amount: 0, username: "dev1", organization: "org1",
    repository: "", model: "gpt-5", exceeds_quota: "FALSE", total_monthly_quota: 500,
    charge_scope: "user", input_tokens: 0, output_tokens: 0, cached_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, cost_center_name: "",
    aic_quantity: 100, aic_gross_amount: 1,
    ...over,
  } as BillingPremiumRequestRecord;
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(path.join(process.cwd(), "src", "lib", "db", "billing-schema.sql"), "utf-8"));
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM billing_usage_records");
  db.exec("DELETE FROM billing_premium_requests");
});

describe("getCopilotCostBasis", () => {
  it("separates seat cost from credit cost by SKU", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_enterprise", quantity: 10, net_amount: 390, gross_amount: 400 }),
      usage({ sku: "copilot_for_business", quantity: 2, net_amount: 38, gross_amount: 38, username: "dev2" }),
      usage({ sku: "copilot_ai_credit", quantity: 5000, net_amount: 12, gross_amount: 50, username: "dev3" }),
      usage({ sku: "coding_agent_ai_credit", quantity: 1000, net_amount: 3, gross_amount: 10, username: "dev4" }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatCostNet).toBe(428);
    expect(basis.seatQuantity).toBe(12);
    expect(basis.creditsBilled).toBe(6000);
    expect(basis.creditCostNet).toBe(15);
    expect(basis.totalCopilotNet).toBe(443);
  });

  it("classifies legacy premium_request SKUs as credit spend, not seats", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_premium_request", quantity: 900, net_amount: 9, gross_amount: 9 }),
      usage({ sku: "coding_agent_premium_request", quantity: 100, net_amount: 1, gross_amount: 1, username: "dev2" }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatCostNet).toBe(0);
    expect(basis.creditsBilled).toBe(1000);
    expect(basis.creditCostNet).toBe(10);
  });

  it("excludes non-Copilot products so Actions spend never inflates seat cost", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_enterprise", quantity: 1, net_amount: 39 }),
      usage({ product: "actions", sku: "actions_linux", quantity: 500, net_amount: 4000, charge_scope: "org" }),
    ]);

    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").seatCostNet).toBe(39);
  });

  it("reports full coverage when per-user attribution matches billed credits", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", quantity: 300, net_amount: 0 })]);
    upsertPremiumRequests("ent1", [
      premium({ quantity: 200, aic_quantity: 200 }),
      premium({ quantity: 100, aic_quantity: 100, username: "dev2" }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(300);
    expect(basis.creditsAttributed).toBe(300);
    expect(basis.attributedUsers).toBe(2);
    expect(basis.attributionCoveragePct).toBe(100);
    expect(basis.attributionComplete).toBe(true);
  });

  it("surfaces the gap when the per-user report only covers part of the month", () => {
    // This is the real-world case: the ai_credit report is served for a short
    // recent window, so historical months are only partially attributable.
    // Reporting the per-user total as if it were the billed total under-reports
    // consumption — here by 60%.
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", quantity: 1000, net_amount: 0 })]);
    upsertPremiumRequests("ent1", [premium({ quantity: 400, aic_quantity: 400 })]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(1000);
    expect(basis.creditsAttributed).toBe(400);
    expect(basis.attributionCoveragePct).toBe(40);
    expect(basis.attributionComplete).toBe(false);
  });

  it("reports zero coverage rather than zero credits when the per-user report is missing", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", quantity: 5000, net_amount: 0 })]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(5000);
    expect(basis.creditsAttributed).toBe(0);
    expect(basis.attributionCoveragePct).toBe(0);
    expect(basis.attributionComplete).toBe(false);
  });

  it("falls back to quantity when aic_quantity is zero on legacy rows", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_premium_request", quantity: 250, net_amount: 5 })]);
    upsertPremiumRequests("ent1", [
      premium({ sku: "copilot_premium_request", unit_type: "requests", quantity: 250, aic_quantity: 0 }),
    ]);

    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").creditsAttributed).toBe(250);
  });

  it("returns a null coverage rather than a misleading 0% when nothing was billed", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_enterprise", quantity: 1, net_amount: 39 })]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(0);
    expect(basis.attributionCoveragePct).toBeNull();
    expect(basis.attributionComplete).toBe(false);
  });

  it("derives the period only when the window sits inside one month", () => {
    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").period).toBe("2026-07");
    expect(getCopilotCostBasis("2026-06-01", "2026-07-31").period).toBeNull();
  });

  it("honours the date window so a neighbouring month cannot leak in", () => {
    upsertUsageRecords("ent1", [
      usage({ date: "2026-07-15", sku: "copilot_enterprise", quantity: 1, net_amount: 39 }),
      usage({ date: "2026-08-01", sku: "copilot_enterprise", quantity: 1, net_amount: 39, username: "dev2" }),
    ]);

    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").seatCostNet).toBe(39);
  });

  it("scopes to the requested enterprises", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_enterprise", quantity: 1, net_amount: 39 })]);
    upsertUsageRecords("ent2", [usage({ sku: "copilot_enterprise", quantity: 1, net_amount: 100, username: "dev2" })]);

    expect(getCopilotCostBasis("2026-07-01", "2026-07-31", undefined, ["ent1"]).seatCostNet).toBe(39);
    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").seatCostNet).toBe(139);
  });

  it("gives Billing and License & AI Credits identical figures for the same month", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_enterprise", quantity: 40, net_amount: 1560 }),
      usage({ sku: "copilot_ai_credit", quantity: 9000, net_amount: 21, username: "dev9" }),
    ]);
    upsertPremiumRequests("ent1", [premium({ quantity: 3000, aic_quantity: 3000 })]);

    // Billing resolves the month via monthBounds(period); the licensing route
    // resolves the same month from its periods list. Same bounds, same query.
    const fromBilling = getCopilotCostBasis("2026-07-01", "2026-07-31");
    const fromLicensing = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(fromBilling).toEqual(fromLicensing);
    expect(fromBilling.seatCostNet).toBe(1560);
    expect(fromBilling.creditsBilled).toBe(9000);
  });
});
