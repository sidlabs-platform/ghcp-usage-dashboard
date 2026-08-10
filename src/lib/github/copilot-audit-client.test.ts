import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api-base", async () => {
  const actual = await vi.importActual<typeof import("./api-base")>("./api-base");
  return {
    ...actual,
    githubFetchWithMeta: vi.fn(),
  };
});

import { githubFetchWithMeta, GitHubApiError } from "./api-base";
import { CopilotAuditClient, type RawCopilotAuditEvent, type AuditFetchResult } from "./copilot-audit-client";

const mockFetchWithMeta = githubFetchWithMeta as unknown as ReturnType<typeof vi.fn>;
const client = new CopilotAuditClient();

function page(events: RawCopilotAuditEvent[], nextUrl?: string) {
  return {
    data: events,
    status: 200,
    headers: nextUrl ? { link: `<${nextUrl}>; rel="next"` } : {},
  };
}

function expectOk(result: AuditFetchResult): asserts result is AuditFetchResult & { status: "ok" } {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
}

beforeEach(() => {
  mockFetchWithMeta.mockReset();
});

describe("CopilotAuditClient", () => {
  describe("request shape", () => {
    it("includes phrase=action:copilot on the org audit-log request", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      await client.getOrgAuditEvents("acme");
      const [url] = mockFetchWithMeta.mock.calls[0];
      expect(url).toContain("/orgs/acme/audit-log");
      expect(url).toContain(`phrase=${encodeURIComponent("action:copilot")}`);
    });

    it("includes phrase=action:copilot on the enterprise audit-log request", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      await client.getEnterpriseAuditEvents("my-ent");
      const [url] = mockFetchWithMeta.mock.calls[0];
      expect(url).toContain("/enterprises/my-ent/audit-log");
      expect(url).toContain(`phrase=${encodeURIComponent("action:copilot")}`);
    });
  });

  describe("action normalization", () => {
    it("normalizes modern assign/cancel actions", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", "@timestamp": 1_700_000_000_000, _document_id: "doc-1" },
          { action: "cfb_seat_cancelled", user: "hubot", user_id: 2, org: "acme", "@timestamp": 1_700_000_001_000, _document_id: "doc-2" },
        ]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toMatchObject({ action: "assign", observedLogin: "octocat", githubUserId: 1, orgLogin: "acme", eventId: "doc-1" });
      expect(result.events[1]).toMatchObject({ action: "cancel", observedLogin: "hubot", githubUserId: 2, eventId: "doc-2" });
      expect(result.truncated).toBe(false);
      expect(result.warnings).toEqual([]);
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
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events.map((e) => e.action)).toEqual(["assign", "assign", "assign", "cancel", "cancel", "cancel"]);
    });

    it("drops unrecognized actions", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "org.update_member", user: "octocat", user_id: 1, "@timestamp": 1_700_000_000_000, _document_id: "doc-1" },
        ]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(0);
    });

    it("drops events with no usable timestamp and surfaces a structured warning (not a silent drop)", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, _document_id: "doc-1" }]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/timestamp/i);
      expect(result.warnings[0]).toContain("doc-1");
      expect(result.warnings[0]).toContain("assign");
    });

    it("surfaces a per-event timestamp warning while retaining other valid events, without leaking sensitive raw content into the warning", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          {
            action: "cfb_seat_added",
            user: "no-timestamp-user",
            user_id: 1,
            external_identity_nameid: "no-timestamp-user@example.com",
            _document_id: "doc-missing-ts",
          },
          { action: "cfb_seat_added", user: "octocat", user_id: 2, "@timestamp": 1_700_000_000_000, _document_id: "doc-valid" },
        ]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events.map((e) => e.eventId)).toEqual(["doc-valid"]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("doc-missing-ts");
      // Must not leak sensitive raw content (login/email/external identity) into the warning.
      expect(result.warnings[0]).not.toContain("no-timestamp-user");
      expect(result.warnings[0]).not.toContain("example.com");
    });

    it("does not warn for unrecognized (non seat-lifecycle) actions lacking a timestamp — only relevant assign/cancel actions warn", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "org.update_member", user: "octocat", user_id: 1, _document_id: "doc-1" }]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(0);
      expect(result.warnings).toEqual([]);
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
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      const [event] = result.events;
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
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events[0].externalIdentity).toBe("scim-user");
    });

    it("uses the legacy created_at timestamp field when @timestamp is absent", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "seat_assigned", user: "octocat", user_id: 1, created_at: 1_700_000_000_000, _document_id: "doc-1" }]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events[0].occurredAt).toBe(new Date(1_700_000_000_000).toISOString());
    });
  });

  describe("deterministic event ids", () => {
    it("uses _document_id when present", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([{ action: "cfb_seat_added", user: "octocat", user_id: 1, "@timestamp": 1, _document_id: "stable-id" }]),
      );
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events[0].eventId).toBe("stable-id");
    });

    it("derives a stable hash-based id when _document_id is absent, reproducible across separate fetches", async () => {
      const raw: RawCopilotAuditEvent = { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", actor: "admin", "@timestamp": 1_700_000_000_000 };
      mockFetchWithMeta.mockResolvedValueOnce(page([raw]));
      const first = await client.getOrgAuditEvents("acme");
      expectOk(first);

      mockFetchWithMeta.mockReset();
      mockFetchWithMeta.mockResolvedValueOnce(page([raw]));
      const second = await client.getOrgAuditEvents("acme");
      expectOk(second);

      expect(first.events[0].eventId).toBe(second.events[0].eventId);
      expect(first.events[0].eventId).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("de-duplicates events sharing the same eventId within/across fetched pages", async () => {
      const raw: RawCopilotAuditEvent = { action: "cfb_seat_added", user: "octocat", user_id: 1, org: "acme", "@timestamp": 1_700_000_000_000, _document_id: "dup" };
      mockFetchWithMeta.mockResolvedValueOnce(page([raw, { ...raw }], "https://api.github.com/orgs/acme/audit-log?per_page=100&after=cursor1"));
      mockFetchWithMeta.mockResolvedValueOnce(page([{ ...raw }]));
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(1);
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
      const result = await client.getOrgAuditEvents("acme", { cutoffMs: 1500 });
      expectOk(result);
      expect(result.events.map((e) => e.eventId)).toEqual(["new"]);
    });

    it("stops paginating once an older-than-cutoff event is observed (newest-first assumption)", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page(
          [{ action: "cfb_seat_added", user: "new", user_id: 1, "@timestamp": 2000, _document_id: "new" },
           { action: "cfb_seat_added", user: "old", user_id: 2, "@timestamp": 500, _document_id: "old" }],
          "https://api.github.com/orgs/acme/audit-log?per_page=100&after=cursor1",
        ),
      );
      const result = await client.getOrgAuditEvents("acme", { cutoffMs: 1000 });
      expectOk(result);
      expect(result.events.map((e) => e.eventId)).toEqual(["new"]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1); // did not follow the next-page link
      expect(result.truncated).toBe(false); // stopping due to cutoff is not truncation
    });

    it("excludes events observed after untilMs", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page([
          { action: "cfb_seat_added", user: "future", user_id: 1, "@timestamp": 5000, _document_id: "future" },
          { action: "cfb_seat_added", user: "inrange", user_id: 2, "@timestamp": 1000, _document_id: "inrange" },
        ]),
      );
      const result = await client.getOrgAuditEvents("acme", { untilMs: 2000 });
      expectOk(result);
      expect(result.events.map((e) => e.eventId)).toEqual(["inrange"]);
    });
  });

  describe("pagination", () => {
    it("follows the Link header's next-page URL", async () => {
      mockFetchWithMeta
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "a", user_id: 1, "@timestamp": 1, _document_id: "a" }], "https://api.github.com/orgs/acme/audit-log?after=c1"))
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "b", user_id: 2, "@timestamp": 2, _document_id: "b" }]));
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(2);
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(2, "/orgs/acme/audit-log?after=c1", expect.anything());
    });

    it("rejects a next-page link from an untrusted origin before another request", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page(
          [{ action: "cfb_seat_added", user: "a", user_id: 1, "@timestamp": 1, _document_id: "a" }],
          "https://evil.example/orgs/acme/audit-log?after=c1",
        ),
      );

      await expect(client.getOrgAuditEvents("acme")).rejects.toThrow(/origin/i);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("stops when a page returns no events", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events).toHaveLength(0);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
    });

    it("marks the org fetch as complete (not truncated) for a single-page pagination run", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(page([]));
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.truncated).toBe(false);
    });

    it("respects the maxPages safety guard for org pagination", async () => {
      mockFetchWithMeta.mockImplementation(async () =>
        page([{ action: "cfb_seat_added", user: "x", user_id: 1, "@timestamp": Date.now(), _document_id: `id-${Math.random()}` }], "https://api.github.com/orgs/acme/audit-log?after=next"),
      );
      const result = await client.getOrgAuditEvents("acme", { maxPages: 3 });
      expectOk(result);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(3);
      expect(result.events).toHaveLength(3);
    });

    it("surfaces org maxPages truncation as a typed flag + warning instead of silently returning partial data", async () => {
      mockFetchWithMeta.mockImplementation(async () =>
        page([{ action: "cfb_seat_added", user: "x", user_id: 1, "@timestamp": Date.now(), _document_id: `id-${Math.random()}` }], "https://api.github.com/orgs/acme/audit-log?after=next"),
      );
      const result = await client.getOrgAuditEvents("acme", { maxPages: 3 });
      expectOk(result);
      expect(result.truncated).toBe(true);
      expect(result.warnings.some((w) => /truncated/i.test(w) && /3-page/.test(w))).toBe(true);
    });

    it("does not mark truncated when the last page fetched has no further next link", async () => {
      mockFetchWithMeta
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "a", user_id: 1, "@timestamp": 1, _document_id: "a" }], "https://api.github.com/orgs/acme/audit-log?after=c1"))
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "b", user_id: 2, "@timestamp": 2, _document_id: "b" }])); // no next link — naturally complete
      const result = await client.getOrgAuditEvents("acme", { maxPages: 2 });
      expectOk(result);
      expect(result.truncated).toBe(false);
      expect(result.warnings).toEqual([]);
    });

    it("throws when maxPages is not a positive integer", async () => {
      await expect(client.getOrgAuditEvents("acme", { maxPages: 0 })).rejects.toThrow(/maxPages/);
    });
  });

  describe("enterprise pagination", () => {
    it("follows the Link header's next-page URL for enterprise audit events", async () => {
      mockFetchWithMeta
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "a", user_id: 1, org: "org-a", "@timestamp": 1, _document_id: "a" }], "https://api.github.com/enterprises/my-ent/audit-log?after=c1"))
        .mockResolvedValueOnce(page([{ action: "cfb_seat_added", user: "b", user_id: 2, org: "org-b", "@timestamp": 2, _document_id: "b" }]));
      const result = await client.getEnterpriseAuditEvents("my-ent");
      expectOk(result);
      expect(result.events).toHaveLength(2);
      expect(mockFetchWithMeta).toHaveBeenNthCalledWith(2, "/enterprises/my-ent/audit-log?after=c1", expect.anything());
    });

    it("respects the maxPages safety guard for enterprise pagination and surfaces truncation", async () => {
      mockFetchWithMeta.mockImplementation(async () =>
        page([{ action: "cfb_seat_added", user: "x", user_id: 1, org: "org-a", "@timestamp": Date.now(), _document_id: `ent-${Math.random()}` }], "https://api.github.com/enterprises/my-ent/audit-log?after=next"),
      );
      const result = await client.getEnterpriseAuditEvents("my-ent", { maxPages: 4 });
      expectOk(result);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(4);
      expect(result.events).toHaveLength(4);
      expect(result.truncated).toBe(true);
      expect(result.warnings.some((w) => /truncated/i.test(w) && /4-page/.test(w))).toBe(true);
    });

    it("stops enterprise pagination once an older-than-cutoff event is observed", async () => {
      mockFetchWithMeta.mockResolvedValueOnce(
        page(
          [
            { action: "cfb_seat_added", user: "new", user_id: 1, org: "org-a", "@timestamp": 2000, _document_id: "new" },
            { action: "cfb_seat_added", user: "old", user_id: 2, org: "org-a", "@timestamp": 500, _document_id: "old" },
          ],
          "https://api.github.com/enterprises/my-ent/audit-log?after=cursor1",
        ),
      );
      const result = await client.getEnterpriseAuditEvents("my-ent", { cutoffMs: 1000 });
      expectOk(result);
      expect(result.events.map((e) => e.eventId)).toEqual(["new"]);
      expect(mockFetchWithMeta).toHaveBeenCalledTimes(1);
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
      const result = await client.getOrgAuditEvents("acme");
      expectOk(result);
      expect(result.events[0].orgLogin).toBe("acme");
    });
  });

  describe("optional-source outcomes (missing/forbidden must not throw or look success-shaped)", () => {
    it("returns a typed unavailable/not_found result on 404 for org events", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(404, "/orgs/acme/audit-log", "Not Found", false));
      const result = await client.getOrgAuditEvents("acme");
      expect(result).toEqual({ status: "unavailable", reason: "not_found", target: "acme" });
    });

    it("returns a typed unavailable/forbidden result on 403 for org events", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/orgs/acme/audit-log", "Forbidden", false));
      const result = await client.getOrgAuditEvents("acme");
      expect(result).toEqual({ status: "unavailable", reason: "forbidden", target: "acme" });
    });

    it("returns a typed unavailable/not_found result on 404 for enterprise events", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(404, "/enterprises/my-ent/audit-log", "Not Found", false));
      const result = await client.getEnterpriseAuditEvents("my-ent");
      expect(result).toEqual({ status: "unavailable", reason: "not_found", target: "my-ent" });
    });

    it("returns a typed unavailable/forbidden result on 403 for enterprise events", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/enterprises/my-ent/audit-log", "Forbidden", false));
      const result = await client.getEnterpriseAuditEvents("my-ent");
      expect(result).toEqual({ status: "unavailable", reason: "forbidden", target: "my-ent" });
    });

    it("returns a typed unknown result for a rate-limited/retryable GitHubApiError rather than treating it as unavailable", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(429, "/orgs/acme/audit-log", "rate limited", true));
      const result = await client.getOrgAuditEvents("acme");
      expect(result.status).toBe("unknown");
      if (result.status !== "unknown") throw new Error("expected unknown");
      expect(result.target).toBe("acme");
      expect(result.message).toContain("429");
    });

    it("returns a typed unknown result for a 403 with retryable=true (primary/secondary rate limit), not unavailable/forbidden", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/orgs/acme/audit-log", "secondary rate limit", true));
      const result = await client.getOrgAuditEvents("acme");
      expect(result.status).toBe("unknown");
      if (result.status !== "unknown") throw new Error("expected unknown");
      expect(result.target).toBe("acme");
      expect(result.message).toContain("403");
    });

    it("returns a typed unknown result for an enterprise 403 with retryable=true (primary/secondary rate limit), not unavailable/forbidden", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(403, "/enterprises/my-ent/audit-log", "secondary rate limit", true));
      const result = await client.getEnterpriseAuditEvents("my-ent");
      expect(result.status).toBe("unknown");
      if (result.status !== "unknown") throw new Error("expected unknown");
      expect(result.target).toBe("my-ent");
      expect(result.message).toContain("403");
    });

    it("returns a typed unknown result for other GitHubApiError statuses (e.g. 500)", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new GitHubApiError(500, "/orgs/acme/audit-log", "boom", true));
      const result = await client.getOrgAuditEvents("acme");
      expect(result.status).toBe("unknown");
    });

    it("rethrows non-GitHubApiError failures instead of swallowing them (no broad catch)", async () => {
      mockFetchWithMeta.mockRejectedValueOnce(new Error("network exploded"));
      await expect(client.getOrgAuditEvents("acme")).rejects.toThrow("network exploded");
    });
  });
});
