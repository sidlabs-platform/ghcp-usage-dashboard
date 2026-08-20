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

/**
 * Usage-report row. `unit_type` defaults to `user-months` (the unit GitHub
 * reports Copilot seats in) because the cost basis classifies rows by unit
 * type, per the billing reporting docs, not by SKU name.
 */
function usage(over: Partial<BillingUsageRecord> = {}): BillingUsageRecord {
  return {
    date: "2026-07-10", product: "copilot", sku: "copilot_enterprise", quantity: 1,
    unit_type: "user-months", applied_cost_per_quantity: 39, gross_amount: 39, discount_amount: 0,
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
  it("separates seat cost from consumption cost by unit type", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_enterprise", quantity: 10, net_amount: 390, gross_amount: 400 }),
      usage({ sku: "copilot_for_business", quantity: 2, net_amount: 38, gross_amount: 38, username: "dev2" }),
      usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 5000, net_amount: 12, gross_amount: 50, username: "dev3" }),
      usage({ sku: "coding_agent_ai_credit", unit_type: "ai-credits", quantity: 1000, net_amount: 3, gross_amount: 10, username: "dev4" }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatCostNet).toBe(428);
    expect(basis.seatQuantity).toBe(12);
    expect(basis.creditsBilled).toBe(6000);
    expect(basis.creditCostNet).toBe(15);
    expect(basis.totalCopilotNet).toBe(443);
  });

  it("reports premium requests under their own unit instead of adding them to credits", () => {
    // Different unit types are never summed: GitHub's reporting guidance is to
    // filter by product *and* unit type before aggregating. Adding 1,000
    // requests to 5,000 credits yields a figure that reproduces no report.
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 5000, net_amount: 12, gross_amount: 50 }),
      usage({ sku: "copilot_premium_request", unit_type: "requests", quantity: 900, net_amount: 9, gross_amount: 9 }),
      usage({ sku: "coding_agent_premium_request", unit_type: "requests", quantity: 100, net_amount: 1, gross_amount: 1, username: "dev2" }),
      usage({ sku: "copilot_ai_credit", unit_type: "token-units", quantity: 700, net_amount: 4, gross_amount: 7 }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatCostNet).toBe(0);
    expect(basis.creditsBilled).toBe(5000);
    expect(basis.requestsBilled).toBe(1000);
    expect(basis.tokenUnitsBilled).toBe(700);
    // Amounts are USD, so they *are* additive across every consumption unit.
    expect(basis.creditCostNet).toBe(26);
  });

  it("counts only credit rows as attributed, so a requests-only window reports zero credits", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_premium_request", unit_type: "requests", quantity: 900, net_amount: 9, gross_amount: 9 }),
    ]);
    upsertPremiumRequests("ent1", [
      premium({ sku: "copilot_premium_request", unit_type: "requests", quantity: 900, aic_quantity: 0 }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(0);
    expect(basis.creditsAttributed).toBe(0);
    expect(basis.requestsBilled).toBe(900);
    expect(basis.requestsAttributed).toBe(900);
    // Null, not 0%: nothing was billed in credits, so credit coverage is undefined.
    expect(basis.attributionCoveragePct).toBeNull();
  });

  it("reports the seat population billed in the window, not today's snapshot", () => {
    // The headline "licensed users" figure must describe the selected period.
    // `copilot_seats` only knows who holds a seat *now*, so for a past period
    // it is the wrong population entirely — observed as 1,215 against 1,646
    // actually billed for July 2026.
    upsertUsageRecords("ent1", [
      usage({ date: "2026-07-10", username: "alice", organization: "org1", quantity: 0.032 }),
      usage({ date: "2026-07-11", username: "alice", organization: "org1", quantity: 0.032 }),
      // Same user, second org: two seat assignments, one user.
      usage({ date: "2026-07-10", username: "alice", organization: "org2", quantity: 0.032 }),
      usage({ date: "2026-07-10", username: "bob", organization: "org1", quantity: 0.032 }),
      // Org-level aggregate row: billed, but names nobody.
      usage({ date: "2026-07-12", username: "", organization: "org1", quantity: 40 }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatUsers).toBe(2);
    expect(basis.seatAssignments).toBe(3);
    // Coverage is visible, so a partially-named month reads as a lower bound
    // rather than a precise count.
    expect(basis.seatNamedDays).toBe(2);
    expect(basis.seatDays).toBe(3);
    // Every named day's seats are fully named here, so this is a real census.
    expect(basis.seatPopulationComplete).toBe(true);
  });

  it("flags the seat population as incomplete when only some orgs name users", () => {
    // Observed in 2026-03: half the billed seats arrive as org-level aggregate
    // rows with no username. Headlining the named count would under-report the
    // period by ~330 seats — swapping one contradiction for another.
    upsertUsageRecords("ent1", [
      usage({ date: "2026-07-10", username: "alice", organization: "org1", quantity: 0.5 }),
      usage({ date: "2026-07-10", username: "", organization: "org2", quantity: 0.5 }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.seatUsers).toBe(1);
    expect(basis.seatPopulationComplete).toBe(false);
  });

  it("excludes non-Copilot products so Actions spend never inflates seat cost", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_enterprise", quantity: 1, net_amount: 39 }),
      usage({ product: "actions", sku: "actions_linux", quantity: 500, net_amount: 4000, charge_scope: "org" }),
    ]);

    expect(getCopilotCostBasis("2026-07-01", "2026-07-31").seatCostNet).toBe(39);
  });

  it("reports full coverage when per-user attribution matches billed credits", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 300, net_amount: 0 })]);
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
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 1000, net_amount: 0 })]);
    upsertPremiumRequests("ent1", [premium({ quantity: 400, aic_quantity: 400 })]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(1000);
    expect(basis.creditsAttributed).toBe(400);
    expect(basis.attributionCoveragePct).toBe(40);
    expect(basis.attributionComplete).toBe(false);
  });

  it("reports zero coverage rather than zero credits when the per-user report is missing", () => {
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 5000, net_amount: 0 })]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsBilled).toBe(5000);
    expect(basis.creditsAttributed).toBe(0);
    expect(basis.attributionCoveragePct).toBe(0);
    expect(basis.attributionComplete).toBe(false);
  });

  it("excludes credits with no username from the attributed total and reports them separately", () => {
    // The per-user report carries org/enterprise-scoped rows with no username.
    // Counting those as "attributed" claimed a coverage no per-user table could
    // reproduce, which made this strip contradict the per-user tiles beside it.
    upsertUsageRecords("ent1", [usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 1000, net_amount: 0 })]);
    upsertPremiumRequests("ent1", [
      premium({ quantity: 400, aic_quantity: 400 }),
      premium({ quantity: 300, aic_quantity: 300, username: "" }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    expect(basis.creditsAttributed).toBe(400);
    expect(basis.creditsUnattributed).toBe(300);
    expect(basis.attributedUsers).toBe(1);
    expect(basis.attributionCoveragePct).toBe(40);
  });

  it("counts only credit rows toward attributed users, so a requests-only window reports no attributed users", () => {
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_premium_request", unit_type: "requests", quantity: 900, net_amount: 9 }),
    ]);
    upsertPremiumRequests("ent1", [
      premium({ sku: "copilot_premium_request", unit_type: "requests", quantity: 900, aic_quantity: 0 }),
    ]);

    const basis = getCopilotCostBasis("2026-07-01", "2026-07-31");

    // 0 credits beside a non-zero user count would read as a contradiction.
    expect(basis.creditsAttributed).toBe(0);
    expect(basis.attributedUsers).toBe(0);
    expect(basis.requestsAttributed).toBe(900);
  });

  it("falls back to quantity when aic_quantity is a literal zero on credit rows", () => {
    // GitHub sometimes reports the credit amount in `quantity` and leaves 0 in
    // the aic_ columns; the row is still `ai-credits` and must still count.
    upsertUsageRecords("ent1", [
      usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 250, net_amount: 5 }),
    ]);
    upsertPremiumRequests("ent1", [
      premium({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 250, aic_quantity: 0 }),
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
      usage({ sku: "copilot_ai_credit", unit_type: "ai-credits", quantity: 9000, net_amount: 21, username: "dev9" }),
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
