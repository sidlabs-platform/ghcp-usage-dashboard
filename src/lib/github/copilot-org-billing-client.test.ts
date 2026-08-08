import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", async () => {
  const actual = await vi.importActual<typeof import("./api-base")>("./api-base");
  return {
    ...actual,
    githubFetchWithMeta: vi.fn(),
  };
});

import { githubFetchWithMeta, GitHubApiError } from "./api-base";
import { CopilotOrgBillingClient } from "./copilot-org-billing-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotOrgBillingClient();

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

describe("CopilotOrgBillingClient", () => {
  describe("getOrgBilling — success", () => {
    it("normalizes plan and seat_breakdown totals/pending cancellation", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({
        data: {
          plan_type: "business",
          seat_breakdown: { total: 25, pending_cancellation: 3, active_this_cycle: 22 },
        },
        status: 200,
        headers: {},
      });

      const result = await client.getOrgBilling("acme");
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot.orgLogin).toBe("acme");
      expect(result.snapshot.planType).toBe("business");
      expect(result.snapshot.totalSeats).toBe(25);
      expect(result.snapshot.pendingCancellation).toBe(3);
      expect(result.snapshot.billingPeriod).toMatch(/^\d{4}-\d{2}$/);
      expect(() => new Date(result.snapshot.observedAt).toISOString()).not.toThrow();
      expect(result.snapshot.raw).toEqual({
        plan_type: "business",
        seat_breakdown: { total: 25, pending_cancellation: 3, active_this_cycle: 22 },
      });
    });

    it("defaults totals to 0 when seat_breakdown is absent", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: {}, status: 200, headers: {} });
      const result = await client.getOrgBilling("acme");
      if (result.status !== "ok") throw new Error("expected ok");
      expect(result.snapshot.totalSeats).toBe(0);
      expect(result.snapshot.pendingCancellation).toBe(0);
      expect(result.snapshot.planType).toBeNull();
    });
  });

  describe("getOrgBilling — optional-source (non-success-shaped) outcomes", () => {
    it("returns a typed unavailable/not_found result on 404, not an empty success", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(404, "/orgs/acme/copilot/billing", "Not Found", false));
      const result = await client.getOrgBilling("acme");
      expect(result).toEqual({ status: "unavailable", reason: "not_found", orgLogin: "acme" });
    });

    it("returns a typed unavailable/forbidden result on 403, not an empty success", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/orgs/acme/copilot/billing", "Forbidden", false));
      const result = await client.getOrgBilling("acme");
      expect(result).toEqual({ status: "unavailable", reason: "forbidden", orgLogin: "acme" });
    });

    it("returns a typed unknown result for other GitHubApiError statuses", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(500, "/orgs/acme/copilot/billing", "boom", true));
      const result = await client.getOrgBilling("acme");
      expect(result.status).toBe("unknown");
      if (result.status !== "unknown") throw new Error("expected unknown");
      expect(result.orgLogin).toBe("acme");
      expect(result.message).toContain("500");
    });

    it("returns a typed unknown result when the response body is empty", async () => {
      mockFetchWithMeta.mockResolvedValueOnce({ data: null, status: 204, headers: {} });
      const result = await client.getOrgBilling("acme");
      expect(result.status).toBe("unknown");
    });

    it("rethrows non-GitHubApiError failures instead of swallowing them", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new Error("network exploded"));
      await expect(client.getOrgBilling("acme")).rejects.toThrow("network exploded");
    });
  });

  it("passes enterpriseSlug through to the request", async () => {
    mockFetchWithMeta.mockResolvedValueOnce({ data: {}, status: 200, headers: {} });
    await client.getOrgBilling("acme", "my-ent");
    expect(mockFetchWithMeta).toHaveBeenCalledWith(
      "/orgs/acme/copilot/billing",
      expect.objectContaining({ enterpriseSlug: "my-ent" }),
    );
  });
});
