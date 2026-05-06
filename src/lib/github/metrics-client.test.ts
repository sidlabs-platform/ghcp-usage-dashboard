import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  fetchNDJSON: vi.fn(() => []),
  sleep: vi.fn(),
}));

import { MetricsClient } from "./metrics-client";
import { githubFetch, fetchNDJSON, sleep } from "./api-base";

const mockGithubFetch = githubFetch as ReturnType<typeof vi.fn>;
const mockFetchNDJSON = fetchNDJSON as ReturnType<typeof vi.fn>;
const client = new MetricsClient();

describe("MetricsClient", () => {
  describe("getEnterpriseDailyReport", () => {
    it("returns empty when no download_links", async () => {
      mockGithubFetch.mockResolvedValue(null);
      const result = await client.getEnterpriseDailyReport("ent", "2024-01-01");
      expect(result).toEqual([]);
    });

    it("extracts flat DayTotal records", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ day: "2024-01-01", daily_active_users: 10 }]);
      const result = await client.getEnterpriseDailyReport("ent", "2024-01-01");
      expect(result).toHaveLength(1);
      expect(result[0].day).toBe("2024-01-01");
    });

    it("extracts wrapped day_totals format", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ enterprise_id: "x", day_totals: [{ day: "2024-01-01", daily_active_users: 5 }] }]);
      const result = await client.getEnterpriseDailyReport("ent", "2024-01-01");
      expect(result).toHaveLength(1);
    });

    it("extracts partial DayTotal (day but no daily_active_users)", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ day: "2024-01-01", some_field: 1 }]);
      const result = await client.getEnterpriseDailyReport("ent", "2024-01-01");
      expect(result).toHaveLength(1);
    });
  });

  describe("getEnterpriseUserDailyReport", () => {
    it("returns empty when no download_links", async () => {
      mockGithubFetch.mockResolvedValue({});
      const result = await client.getEnterpriseUserDailyReport("ent", "2024-01-01");
      expect(result).toEqual([]);
    });

    it("returns user records from download", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ login: "alice", day: "2024-01-01" }]);
      const result = await client.getEnterpriseUserDailyReport("ent", "2024-01-01");
      expect(result).toHaveLength(1);
    });
  });

  describe("fetchEnterpriseDateRange", () => {
    it("fetches multiple days with progress callback", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ day: "2024-01-01", daily_active_users: 1 }]);
      const progress = vi.fn();
      const result = await client.fetchEnterpriseDateRange("ent", ["2024-01-01", "2024-01-02"], progress);
      expect(result.size).toBe(2);
      expect(progress).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalled();
    });

    it("handles fetch error gracefully", async () => {
      mockGithubFetch.mockRejectedValue(new Error("fail"));
      const result = await client.fetchEnterpriseDateRange("ent", ["2024-01-01"]);
      expect(result.get("2024-01-01")).toEqual([]);
    });
  });

  describe("getOrgDailyReport", () => {
    it("returns DayTotal from org endpoint", async () => {
      mockGithubFetch.mockResolvedValue({ download_links: ["http://dl"] });
      mockFetchNDJSON.mockResolvedValue([{ day: "2024-01-02", daily_active_users: 3 }]);
      const result = await client.getOrgDailyReport("my-org", "2024-01-02");
      expect(result).toHaveLength(1);
    });
  });
});
