import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  githubFetchPaginated: vi.fn(),
}));

import { SeatsClient } from "./seats-client";
import { githubFetch } from "./api-base";

const mockFetch = githubFetch as ReturnType<typeof vi.fn>;
const client = new SeatsClient();

describe("SeatsClient", () => {
  describe("getOrgSeats", () => {
    it("returns empty when API returns null", async () => {
      mockFetch.mockResolvedValue(null);
      const result = await client.getOrgSeats("my-org");
      expect(result).toEqual({ totalSeats: 0, seats: [] });
    });

    it("returns seats from single page", async () => {
      mockFetch.mockResolvedValue({ total_seats: 2, seats: [{ login: "a" }, { login: "b" }] });
      const result = await client.getOrgSeats("my-org");
      expect(result.totalSeats).toBe(2);
      expect(result.seats).toHaveLength(2);
    });

    it("paginates when total_seats > 100", async () => {
      const page1Seats = Array.from({ length: 100 }, (_, i) => ({ login: `u${i}` }));
      mockFetch
        .mockResolvedValueOnce({ total_seats: 150, seats: page1Seats })
        .mockResolvedValueOnce({ seats: Array.from({ length: 50 }, (_, i) => ({ login: `u${100 + i}` })) });
      const result = await client.getOrgSeats("my-org");
      expect(result.totalSeats).toBe(150);
      expect(result.seats).toHaveLength(150);
    });

    it("stops paginating when empty page returned", async () => {
      const page1Seats = Array.from({ length: 100 }, (_, i) => ({ login: `u${i}` }));
      mockFetch
        .mockResolvedValueOnce({ total_seats: 200, seats: page1Seats })
        .mockResolvedValueOnce({ seats: [] });
      const result = await client.getOrgSeats("my-org");
      expect(result.seats).toHaveLength(100);
    });

    it("handles response with no seats field", async () => {
      mockFetch.mockResolvedValue({ total_seats: 0 });
      const result = await client.getOrgSeats("my-org");
      expect(result.seats).toEqual([]);
    });
  });

  describe("getEnterpriseSeats", () => {
    it("returns empty when API returns null", async () => {
      mockFetch.mockResolvedValue(null);
      const result = await client.getEnterpriseSeats("my-ent");
      expect(result).toEqual({ totalSeats: 0, seats: [] });
    });

    it("handles response with no seats field", async () => {
      mockFetch.mockResolvedValue({ total_seats: 0 });
      const result = await client.getEnterpriseSeats("my-ent");
      expect(result.seats).toEqual([]);
    });

    it("returns seats with pagination", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ login: `e${i}` }));
      mockFetch
        .mockResolvedValueOnce({ total_seats: 120, seats: page1 })
        .mockResolvedValueOnce({ seats: Array.from({ length: 20 }, (_, i) => ({ login: `e${100 + i}` })) });
      const result = await client.getEnterpriseSeats("my-ent");
      expect(result.totalSeats).toBe(120);
      expect(result.seats).toHaveLength(120);
    });

    it("stops paginating when null response", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ login: `e${i}` }));
      mockFetch
        .mockResolvedValueOnce({ total_seats: 200, seats: page1 })
        .mockResolvedValueOnce(null);
      const result = await client.getEnterpriseSeats("my-ent");
      expect(result.seats).toHaveLength(100);
    });
  });
});
