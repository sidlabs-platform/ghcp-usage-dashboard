import { describe, it, expect, vi } from "vitest";

vi.mock("./api-base", () => ({
  githubFetch: vi.fn(),
  githubFetchPaginated: vi.fn(),
}));

import { SeatsClient, normalizeSeat, normalizeSeats } from "./seats-client";
import { githubFetch } from "./api-base";
import type { CopilotSeat } from "@/lib/types/seats";

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

  // ── Historical-pipeline normalization ────────────────────────────────

  function makeSeat(overrides: Partial<CopilotSeat> = {}): CopilotSeat {
    return {
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      pending_cancellation_date: null,
      last_activity_at: "2026-01-05T00:00:00Z",
      last_activity_editor: "vscode",
      last_authenticated_at: null,
      plan_type: "business",
      assignee: {
        login: "octocat",
        id: 42,
        node_id: "MDQ6VXNlcjQy",
        avatar_url: "https://avatars.example/octocat.png",
        url: "https://api.github.com/users/octocat",
        html_url: "https://github.com/octocat",
        type: "User",
        site_admin: false,
      },
      ...overrides,
    };
  }

  describe("normalizeSeat", () => {
    it("prefers the numeric user id as holderKey when present", () => {
      const seat = makeSeat();
      const normalized = normalizeSeat(seat, "my-org");
      expect(normalized.holderKey).toBe("id:42");
      expect(normalized.githubUserId).toBe(42);
      expect(normalized.observedLogin).toBe("octocat");
      expect(normalized.unresolved).toBe(false);
      expect(normalized.orgLogin).toBe("my-org");
      expect(normalized.assignedVia).toBe("direct");
    });

    it("falls back to a login-based holderKey when no numeric id is present", () => {
      const seat = makeSeat({
        assignee: {
          login: "Renamed-User",
          id: undefined as unknown as number,
          node_id: "abc",
          avatar_url: "",
          url: "",
          html_url: "",
          type: "User",
          site_admin: false,
        },
      });
      const normalized = normalizeSeat(seat, "my-org");
      expect(normalized.holderKey).toBe("login:renamed-user");
      expect(normalized.githubUserId).toBeNull();
      expect(normalized.unresolved).toBe(false);
    });

    it("preserves an unresolved seat (no id, no login) via a deterministic internal holderKey", () => {
      const seat = makeSeat({
        assignee: {
          login: "" as unknown as string,
          id: undefined as unknown as number,
          node_id: "node-xyz",
          avatar_url: "https://avatars.example/deleted.png",
          url: "https://api.github.com/users/deleted",
          html_url: "https://github.com/deleted",
          type: "User",
          site_admin: false,
        },
      });
      const first = normalizeSeat(seat, "my-org");
      const second = normalizeSeat(seat, "my-org");
      expect(first.unresolved).toBe(true);
      expect(first.githubUserId).toBeNull();
      expect(first.observedLogin).toBeNull();
      expect(first.holderKey).toMatch(/^internal:[0-9a-f]{64}$/);
      // Deterministic: same raw identifiers always produce the same key.
      expect(second.holderKey).toBe(first.holderKey);
    });

    it("produces different internal holderKeys for different orgs given identical unresolved identifiers", () => {
      const seat = makeSeat({
        assignee: {
          login: "" as unknown as string,
          id: undefined as unknown as number,
          node_id: "node-xyz",
          avatar_url: "",
          url: "",
          html_url: "",
          type: "User",
          site_admin: false,
        },
      });
      const orgA = normalizeSeat(seat, "org-a");
      const orgB = normalizeSeat(seat, "org-b");
      expect(orgA.holderKey).not.toBe(orgB.holderKey);
    });

    it("marks team-assigned seats via assigning_team", () => {
      const seat = makeSeat({ assigning_team: { id: 1, node_id: "t", name: "Team", slug: "team", description: "", privacy: "closed", permission: "pull", url: "", html_url: "" } });
      const normalized = normalizeSeat(seat, "my-org");
      expect(normalized.assignedVia).toBe("team");
    });

    it("retains the raw seat payload for auditability", () => {
      const seat = makeSeat();
      const normalized = normalizeSeat(seat, "my-org");
      expect(normalized.raw).toBe(seat);
    });
  });

  describe("normalizeSeats", () => {
    it("normalizes a batch, preserving unresolved seats instead of dropping them", () => {
      const resolved = makeSeat();
      const unresolved = makeSeat({
        assignee: {
          login: "" as unknown as string,
          id: undefined as unknown as number,
          node_id: "node-missing",
          avatar_url: "",
          url: "",
          html_url: "",
          type: "User",
          site_admin: false,
        },
      });
      const result = normalizeSeats([resolved, unresolved], "my-org");
      expect(result).toHaveLength(2);
      expect(result[0].unresolved).toBe(false);
      expect(result[1].unresolved).toBe(true);
    });
  });

  describe("getOrgSeatsNormalized", () => {
    it("normalizes seats returned by the live seats endpoint, including unresolved ones", async () => {
      mockFetch.mockResolvedValue({
        total_seats: 2,
        seats: [
          makeSeat(),
          makeSeat({
            assignee: {
              login: "" as unknown as string,
              id: undefined as unknown as number,
              node_id: "node-2",
              avatar_url: "",
              url: "",
              html_url: "",
              type: "User",
              site_admin: false,
            },
          }),
        ],
      });
      const result = await client.getOrgSeatsNormalized("my-org");
      expect(result.totalSeats).toBe(2);
      expect(result.seats).toHaveLength(2);
      expect(result.seats[0].holderKey).toBe("id:42");
      expect(result.seats[1].unresolved).toBe(true);
      expect(result.seats[1].orgLogin).toBe("my-org");
    });

    it("returns an empty normalized result when the API returns null (existing behavior unaffected)", async () => {
      mockFetch.mockResolvedValue(null);
      const result = await client.getOrgSeatsNormalized("my-org");
      expect(result).toEqual({ totalSeats: 0, seats: [] });
    });
  });

  describe("getEnterpriseSeatsNormalized", () => {
    it("derives orgLogin per-seat from the seat's own organization field", async () => {
      mockFetch.mockResolvedValue({
        total_seats: 2,
        seats: [
          makeSeat({ organization: { login: "org-a", id: 1 } }),
          makeSeat({ organization: { login: "org-b", id: 2 }, assignee: { ...makeSeat().assignee, id: 99, login: "other" } }),
        ],
      });
      const result = await client.getEnterpriseSeatsNormalized("my-ent");
      expect(result.seats.map((s) => s.orgLogin)).toEqual(["org-a", "org-b"]);
    });

    it("falls back to an empty orgLogin when the seat has no organization attribution", async () => {
      mockFetch.mockResolvedValue({ total_seats: 1, seats: [makeSeat({ organization: null })] });
      const result = await client.getEnterpriseSeatsNormalized("my-ent");
      expect(result.seats[0].orgLogin).toBe("");
    });
  });
});
