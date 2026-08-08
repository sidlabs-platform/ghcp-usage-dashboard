import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", () => ({
  githubFetchWithMeta: vi.fn(),
}));

import { githubFetchWithMeta } from "./api-base";
import { CopilotAuditClient, type RawCopilotAuditEvent } from "./copilot-audit-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotAuditClient();

function page(events: RawCopilotAuditEvent[], nextUrl?: string) {
  return {
    data: events,
    status: 200,
    headers: nextUrl ? { link: `<${nextUrl}>; rel="next"` } : {},
  };
}

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

describe("CopilotAuditClient", () => {
  describe("action normalization", () => {
    it("normalizes modern assign/cancel actions", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", "@timestamp": 1_700_000_000_000, _document_id: "doc-1" },
          { action: "cfb_seat_cancelled", user: "hubot", user_id: 2, org: "acme", "@timestamp": 1_700_000_001_000, _document_id: "doc-2" },
        ]),
      );
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ action: "assign", observedLogin: "octocat", githubUserId: 1, orgLogin: "acme", eventId: "doc-1" });
      expect(events[1]).toMatchObject({ action: "cancel", observedLogin: "hubot", githubUserId: 2, eventId: "doc-2" });
    });

    it("normalizes legacy assign/cancel action aliases", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_assignment_created", user: "a", user_id: 10, "@timestamp": 1_700_000_000_000, _document_id: "d1" },
          { action: "seat_assigned", user: "b", user_id: 11, "@timestamp": 1_700_000_000_000, _document_id: "d2" },
          { action: "seat_refresh", user: "c", user_id: 12, "@timestamp": 1_700_000_000_000, _document_id: "d3" },
          { action: "cfb_seat_assignment_unassigned", user: "d", user_id: 13, "@timestamp": 1_700_000_000_000, _document_id: "d4" },
          { action: "access_revoked", user: "e", user_id: 14, "@timestamp": 1_700_000_000_000, _document_id: "d5" },
          { action: "seat_cancelled", user: "f", user_id: 15, "@timestamp": 1_700_000_000_000, _document_id: "d6" },
        ]),
      );
      const events = await client.getOrgAuditEvents("acme");
      expect(events.map((e) => e.action)).toEqual(["assign", "assign", "assign", "cancel", "cancel", "cancel"]);
    });

    it("drops unrecognized actions", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "org.update_member", user: "octocat", user_id: 1, "@timestamp": 1_700_000_000_000, _document_id: "doc-1" },
        ]),
      );
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(0);
    });

    it("drops events with no usable timestamp", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, _document_id: "doc-1" }]),
      );
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(0);
    });

    it("preserves user id/login/external identity/org/team/source/raw JSON", async () => {
      const raw: RawCopilotAuditEvent = {
        action: "cfb_seat_added",
        user: "octocat",
        user_id: 1,
        org: "acme",
        team: "engineering",
        external_identity_nameid: "octocat@example.com",
        "@timestamp": 1_700_000_000_000,
        _document_id: "doc-1",
      };
      mockFetchWithMeta.mockResolvedValueOnce(page([raw]));
      const [event] = await client.getOrgAuditEvents("acme");
      expect(event).toMatchObject({
        githubUserId: 1,
        observedLogin: "octocat",
        externalIdentity: "octocat@example.com",
        orgLogin: "acme",
        team: "engineering",
        source: "audit_log",
      });
      expect(event.raw).toEqual(raw);
    });

    it("falls back to external_identity_username when nameid is absent", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, external_identity_username: "scim-user", "@timestamp": 1_700_000_000_000, _document_id: "doc-1" }]),
      );
      const [event] = await client.getOrgAuditEvents("acme");
      expect(event.externalIdentity).toBe("scim-user");
    });

    it("uses the legacy created_at timestamp field when @timestamp is absent", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "seat_assigned", user: "octocat", user_id: 1, created_at: 1_700_000_000_000, _document_id: "doc-1" }]),
      );
      const [event] = await client.getOrgAuditEvents("acme");
      expect(event.occurredAt).toBe(new Date(1_700_000_000_000).toISOString());
    });
  });

  describe("deterministic event ids", () => {
    it("uses _document_id when present", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, "@timestamp": 1, _document_id: "stable-id" }]),
      );
      const [event] = await client.getOrgAuditEvents("acme");
      expect(event.eventId).toBe("stable-id");
    });

    it("derives a stable hash-based id when _document_id is absent, reproducible across separate fetches", async () => {
      const raw: RawCopilotAuditEvent = { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", actor: "admin", "@timestamp": 1_700_000_000_000 };
      mockFetchWithMeta.mockResolvedValueOnce(page([raw]));
      const [first] = await client.getOrgAuditEvents("acme");

      mockFetchWithMeta.mockReset();
      mockFetchWithMeta.mockResolvedValueOnce(page([raw]));
      const [second] = await client.getOrgAuditEvents("acme");

      expect(first.eventId).toBe(second.eventId);
      expect(first.eventId).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("de-duplicates events sharing the same eventId within/across fetched pages", async () => {
      const raw: RawCopilotAuditEvent = { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", "@timestamp": 1_700_000_000_000, _document_id: "dup" };
      mockFetchWithMeta.mockResolvedValueOnce(page([raw, { ...raw }], "https://api.github.com/orgs/acme/audit-log?per_page=100&after=cursor1"));
      mockFetchWithMeta.mockResolvedValueOnce(page([{ ...raw }]));
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(1);
    });
  });

  describe("cutoff / range support", () => {
    it("excludes events observed before cutoffMs", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_added", user: "new", user_id: 1, "@timestamp": 2000, _document_id: "new" },
          { action: "cfb_seat_added", user: "old", user_id: 2, "@timestamp": 1000, _document_id: "old" },
        ]),
      );
      const events = await client.getOrgAuditEvents("acme", { cutoffMs: 1500 });
      expect(events.map((e) => e.eventId)).toEqual(["new"]);
    });

    it("stops paginating once an older-than-cutoff event is observed (newest-first assumption)", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page(
          [{ action: "cfb_seat_added", user: "new", user_id: 1, "@timestamp": 2000, _document_id: "new" },
           { action: "cfb_seat_added", user: "old", user_id: 2, "@timestamp": 500, _document_id: "old" }],
          "https://api.github.com/orgs/acme/audit-log?per_page=100&after=cursor1",
        ),
      );
      const events = await client.getOrgAuditEvents("acme", { cutoffMs: 1000 });
      expect(events.map((e) => e.eventId)).toEqual(["new"]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1); // did not follow the next-page link
    });

    it("excludes events observed after untilMs", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_added", user: "future", user_id: 1, "@timestamp": 5000, _document_id: "future" },
          { action: "cfb_seat_added", user: "inrange", user_id: 2, "@timestamp": 1000, _document_id: "inrange" },
        ]),
      );
      const events = await client.getOrgAuditEvents("acme", { untilMs: 2000 });
      expect(events.map((e) => e.eventId)).toEqual(["inrange"]);
    });
  });

  describe("pagination", () => {
    it("follows the Link header's next-page URL", async () => {
      mockFetchWithMeta
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "a", user_id: 1, "@timestamp": 1, _document_id: "a" }], "https://api.github.com/orgs/acme/audit-log?after=c1"))
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "b", user_id: 2, "@timestamp": 2, _document_id: "b" }]));
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(2);
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(2, "https://api.github.com/orgs/acme/audit-log?after=c1", expect.anything());
    });

    it("stops when a page returns no events", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      const events = await client.getOrgAuditEvents("acme");
      expect(events).toHaveLength(0);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("respects the maxPages safety guard", async () => {
      mockFetchWithMeta.mockImplementation(async () =>
        page([{ action: "cfb_seat_added", user: "x", user_id: 1, "@timestamp": Date.now(), _document_id: `id-${Math.random()}` }], "https://api.github.com/orgs/acme/audit-log?after=next"),
      );
      const events = await client.getOrgAuditEvents("acme", { maxPages: 3 });
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
      expect(events).toHaveLength(3);
    });

    it("throws when maxPages is not a positive integer", async () => {
      await expect(client.getOrgAuditEvents("acme", { maxPages: 0 })).rejects.toThrow(/maxPages/);
    });
  });

  describe("enterprise vs org endpoints", () => {
    it("targets the enterprise audit-log endpoint and always passes enterpriseSlug through", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      await client.getEnterpriseAuditEvents("my-ent", { enterpriseSlug: "my-ent" });
      expect(mockFetchWithMeta).toHaveBeenCalledWith(
        expect.stringContaining("/enterprises/my-ent/audit-log"),
        expect.objectContaining({ enterpriseSlug: "my-ent" }),
      );
    });

    it("targets the org audit-log endpoint", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      await client.getOrgAuditEvents("acme");
      expect(mockFetchWithMeta).toHaveBeenCalledWith(
        expect.stringContaining("/orgs/acme/audit-log"),
        expect.anything(),
      );
    });

    it("falls back to the org param for orgLogin when the raw event carries none", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, "@timestamp": 1, _document_id: "doc" }]),
      );
      const [event] = await client.getOrgAuditEvents("acme");
      expect(event.orgLogin).toBe("acme");
    });
  });
});
