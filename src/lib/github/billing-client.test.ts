import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  sleep: vi.fn(),
  GITHUB_API_BASE: "https://api.github.com",
}));
vi.mock("@/lib/config/enterprise-config", () => ({
  getEnterpriseAuth: vi.fn(() => ({ token: "test-token" })),
}));

import { billingClient } from "./billing-client";

describe("billingClient", () => {
  describe("parseUsageCSV", () => {
    it("parses simple CSV into BillingUsageRecord[]", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name",
        "2024-01-01,copilot,premium,10,seat,1.5,15,0,15,my-org,repo-a,alice,,",
      ].join("\n");
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].date).toBe("2024-01-01");
      expect(records[0].product).toBe("copilot");
      expect(records[0].quantity).toBe(10);
      expect(records[0].net_amount).toBe(15);
    });

    it("handles quoted fields with commas", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name",
        '2024-01-01,actions,"sku,special",5,min,0.5,2.5,0,2.5,org,"repo,name",user,,',
      ].join("\n");
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].sku).toBe("sku,special");
    });

    it("handles CRLF line endings", () => {
      const csv = "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name\r\n2024-01-01,copilot,s1,1,seat,10,10,0,10,org,,user,,\r\n";
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
    });

    it("returns empty array for header-only CSV", () => {
      const csv = "date,product,sku";
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toEqual([]);
    });
  });

  describe("parsePremiumRequestCSV", () => {
    it("parses premium request CSV", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,username,organization,model,exceeds_quota,total_monthly_quota",
        "2024-02-01,copilot,premium,3,request,0.1,0.3,0,0.3,bob,org-a,gpt-4,TRUE,100",
      ].join("\n");
      const records = billingClient.parsePremiumRequestCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].model).toBe("gpt-4");
      expect(records[0].exceeds_quota).toBe("TRUE");
      expect(records[0].charge_scope).toBe("user");
    });
  });

  describe("listReports", () => {
    it("calls githubFetch and returns usage_report_exports", async () => {
      const { githubFetch } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      mockGF.mockResolvedValue({ usage_report_exports: [{ id: "r1", status: "completed" }] });
      const reports = await billingClient.listReports("my-ent");
      expect(reports).toHaveLength(1);
      expect(reports[0].id).toBe("r1");
    });
  });
});
