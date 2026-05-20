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

    it("handles multiline quoted fields (newline inside quotes)", () => {
      const csv = 'date,product,sku\n2024-01-01,copilot,"multi\nline"\n';
      const records = billingClient.parsePremiumRequestCSV(csv);
      expect(records).toHaveLength(1);
      expect((records[0] as unknown as Record<string, string>).sku).toBe("multi\nline");
    });

    it("handles escaped double-quotes inside quoted fields", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name",
        '2024-01-01,copilot,"sku""quoted",1,seat,10,10,0,10,org,,user,,',
      ].join("\n");
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].sku).toBe('sku"quoted');
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

    it("handles missing/empty usage fields with fallback defaults", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name",
        "2024-01-01,,,,,,,,,,,,,"
      ].join("\n");
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].product).toBe("");
      expect(records[0].quantity).toBe(0);
      expect(records[0].net_amount).toBe(0);
      expect(records[0].username).toBe("");
    });

    it("handles short rows (fewer values than headers) via ?? fallback", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name",
        "2024-01-01,copilot,s1"
      ].join("\n");
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].date).toBe("2024-01-01");
      expect(records[0].quantity).toBe(0);
      expect(records[0].username).toBe("");
    });

    it("skips blank lines between data rows", () => {
      const csv = "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name\n\n2024-01-01,copilot,s1,1,seat,10,10,0,10,org,,user,,\n\n";
      const records = billingClient.parseUsageCSV(csv);
      expect(records).toHaveLength(1);
    });
  });

  describe("parsePremiumRequestCSV", () => {
    it("parses premium request CSV", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,username,organization,model,exceeds_quota,total_monthly_quota,input_tokens,output_tokens,cached_tokens",
        "2024-02-01,copilot,premium,3,request,0.1,0.3,0,0.3,bob,org-a,gpt-4,TRUE,100,120,45,30",
      ].join("\n");
      const records = billingClient.parsePremiumRequestCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].model).toBe("gpt-4");
      expect(records[0].exceeds_quota).toBe("TRUE");
      expect(records[0].charge_scope).toBe("user");
      expect(records[0].input_tokens).toBe(120);
      expect(records[0].output_tokens).toBe(45);
      expect(records[0].cached_tokens).toBe(30);
    });

    it("handles missing/empty fields with fallback defaults", () => {
      const csv = [
        "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,username,organization,model,exceeds_quota,total_monthly_quota,input_tokens,output_tokens,cached_tokens",
        "2024-01-01,,,,,,,,,,,,,,,,"
      ].join("\n");
      const records = billingClient.parsePremiumRequestCSV(csv);
      expect(records).toHaveLength(1);
      expect(records[0].product).toBe("");
      expect(records[0].quantity).toBe(0);
      expect(records[0].model).toBe("");
      expect(records[0].exceeds_quota).toBe("FALSE");
      expect(records[0].input_tokens).toBe(0);
      expect(records[0].output_tokens).toBe(0);
      expect(records[0].cached_tokens).toBe(0);
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

  describe("waitForReport", () => {
    it("returns completed report immediately", async () => {
      const { githubFetch } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      mockGF.mockResolvedValue({ id: "r1", status: "completed", download_urls: ["http://dl"] });
      const result = await billingClient.waitForReport("my-ent", "r1");
      expect(result.status).toBe("completed");
    });

    it("throws on failed report", async () => {
      const { githubFetch } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      mockGF.mockResolvedValue({ id: "r1", status: "failed" });
      await expect(billingClient.waitForReport("my-ent", "r1")).rejects.toThrow("failed");
    });

    it("polls and returns after pending→completed", async () => {
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      (sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      mockGF
        .mockResolvedValueOnce({ id: "r1", status: "pending" })
        .mockResolvedValueOnce({ id: "r1", status: "completed", download_urls: ["http://dl"] });
      const progress = vi.fn();
      const result = await billingClient.waitForReport("my-ent", "r1", 60000, progress);
      expect(result.status).toBe("completed");
      expect(progress).toHaveBeenCalledWith(expect.stringContaining("pending"));
    });

    it("throws timeout when report never completes", async () => {
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      (sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      mockGF.mockResolvedValue({ id: "r1", status: "pending" });
      // Use a very short timeout (1ms) to trigger the timeout path
      await expect(billingClient.waitForReport("my-ent", "r1", 1)).rejects.toThrow("timed out");
    });
  });

  describe("downloadReportCSV", () => {
    it("downloads CSV content from URL", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve("col1,col2\nval1,val2"),
      }));
      const csv = await billingClient.downloadReportCSV("https://storage.example.com/report.csv");
      expect(csv).toContain("col1,col2");
    });

    it("throws on failed download", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
      await expect(billingClient.downloadReportCSV("https://storage.example.com/bad")).rejects.toThrow("Failed to download");
    });
  });

  describe("createReport", () => {
    it("creates a report and returns the export object", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "new-report", status: "pending" }),
      }));
      const result = await billingClient.createReport("my-ent", "detailed", "2024-01-01", "2024-01-31");
      expect(result.id).toBe("new-report");
    });

    it("uses enterprise auth when slug is provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "slug-report", status: "pending" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const result = await billingClient.createReport("my-ent", "detailed", "2024-01-01", "2024-01-31", "my-slug");
      expect(result.id).toBe("slug-report");
      expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }));
    });

    it("throws when response is not ok", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve("invalid dates"),
      }));
      await expect(billingClient.createReport("my-ent", "detailed", "bad", "bad")).rejects.toThrow("Failed to create billing report");
    });

    it("throws when no token available", async () => {
      delete process.env.GITHUB_TOKEN;
      const { getEnterpriseAuth } = await import("@/lib/config/enterprise-config");
      (getEnterpriseAuth as ReturnType<typeof vi.fn>).mockReturnValue({ token: "" });
      await expect(billingClient.createReport("my-ent", "detailed", "2024-01-01", "2024-01-31", "slug-no-token")).rejects.toThrow("GitHub token is required");
    });
  });

  describe("fetchUsageReport", () => {
    it("orchestrates create → wait → download → parse", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      const mockSleep = sleep as ReturnType<typeof vi.fn>;
      mockSleep.mockResolvedValue(undefined);
      // createReport mock (uses global fetch)
      const csvContent = "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,organization,repository,username,workflow_path,cost_center_name\n2024-01-01,copilot,s1,1,seat,10,10,0,10,org,,user,,\n";
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "r1", status: "pending" }) })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(csvContent) })
      );
      // waitForReport uses githubFetch (getReport)
      mockGF.mockResolvedValue({ id: "r1", status: "completed", download_urls: ["https://storage.example.com/csv"] });
      const records = await billingClient.fetchUsageReport("my-ent", "detailed", "2024-01-01", "2024-01-31");
      expect(records).toHaveLength(1);
      expect(records[0].product).toBe("copilot");
    });

    it("returns empty when report has no download URLs", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      (sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "r2", status: "pending" }) })
      );
      mockGF.mockResolvedValue({ id: "r2", status: "completed", download_urls: [] });
      const records = await billingClient.fetchUsageReport("my-ent", "detailed", "2024-01-01", "2024-01-31");
      expect(records).toHaveLength(0);
    });

    it("returns empty when report has null download URLs", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      (sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "r4", status: "pending" }) })
      );
      mockGF.mockResolvedValue({ id: "r4", status: "completed", download_urls: null });
      const records = await billingClient.fetchUsageReport("my-ent", "detailed", "2024-01-01", "2024-01-31");
      expect(records).toHaveLength(0);
    });
  });

  describe("fetchPremiumRequestReport", () => {
    it("orchestrates create → wait → download → parse", async () => {
      process.env.GITHUB_TOKEN = "ghp_test";
      const { githubFetch, sleep } = await import("./api-base");
      const mockGF = githubFetch as ReturnType<typeof vi.fn>;
      (sleep as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      const csvContent = "date,product,sku,quantity,unit_type,applied_cost_per_quantity,gross_amount,discount_amount,net_amount,username,organization,model,exceeds_quota,total_monthly_quota\n2024-01-01,copilot,s1,5,request,2,10,0,10,alice,org,gpt-4,FALSE,100\n";
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "r3", status: "pending" }) })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(csvContent) })
      );
      mockGF.mockResolvedValue({ id: "r3", status: "completed", download_urls: ["https://storage.example.com/csv"] });
      const records = await billingClient.fetchPremiumRequestReport("my-ent", "2024-01-01", "2024-01-31");
      expect(records).toHaveLength(1);
      expect(records[0].model).toBe("gpt-4");
    });
  });
});
