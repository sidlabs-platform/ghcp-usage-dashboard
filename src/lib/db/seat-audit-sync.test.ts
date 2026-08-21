import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuditFetchResult, NormalizedCopilotAuditEvent } from "@/lib/github/copilot-audit-client";
import type { SeatAuditSyncState, SeatLifecycleEventInput } from "./seat-lifecycle-repo";

const recordSeatLifecycleEvents = vi.fn<(slug: string, events: SeatLifecycleEventInput[]) => number>(
  (_slug, events) => events.length,
);
const recordSeatAuditSyncState = vi.fn<(state: SeatAuditSyncState) => void>();
const getSeatAuditSyncStates = vi.fn<(slugs?: string[]) => SeatAuditSyncState[]>(() => []);
const enrichAuditLifecycleFromSeats = vi.fn<() => number>(() => 0);

vi.mock("./seat-lifecycle-repo", () => ({
  recordSeatLifecycleEvents: (...args: [string, SeatLifecycleEventInput[]]) => recordSeatLifecycleEvents(...args),
  recordSeatAuditSyncState: (...args: [SeatAuditSyncState]) => recordSeatAuditSyncState(...args),
  getSeatAuditSyncStates: (...args: [string[]?]) => getSeatAuditSyncStates(...args),
  enrichAuditLifecycleFromSeats: () => enrichAuditLifecycleFromSeats(),
}));

vi.mock("@/lib/config/enterprise-config", () => ({
  getResolvedOrgsForEnterprise: () => [],
  isCopilotSubEnabledForEnterprise: () => true,
}));

vi.mock("@/lib/github/copilot-audit-client", () => ({
  copilotAuditClient: {
    getEnterpriseAuditEvents: vi.fn(),
    getOrgAuditEvents: vi.fn(),
  },
}));

import {
  syncSeatAuditEventsForEnterprise,
  syncSeatAuditEventsSafely,
  resolveAuditCutoff,
  toLifecycleEvents,
  SEAT_AUDIT_LOOKBACK_DAYS,
  SEAT_AUDIT_OVERLAP_HOURS,
  type SeatAuditSyncDeps,
} from "./seat-audit-sync";

const NOW = new Date("2026-06-30T12:00:00.000Z");

function auditEvent(overrides: Partial<NormalizedCopilotAuditEvent> = {}): NormalizedCopilotAuditEvent {
  return {
    eventId: `evt-${Math.random()}`,
    orgLogin: "org1",
    action: "cancel",
    occurredAt: "2026-06-15T09:30:00.000Z",
    githubUserId: 42,
    observedLogin: "dev1",
    externalIdentity: null,
    team: null,
    source: "audit_log",
    raw: {},
    ...overrides,
  };
}

function ok(events: NormalizedCopilotAuditEvent[], truncated = false): AuditFetchResult {
  return { status: "ok", events, truncated, warnings: [] };
}

function makeDeps(overrides: Partial<SeatAuditSyncDeps> = {}): SeatAuditSyncDeps {
  return {
    getEnterpriseAuditEvents: vi.fn(async () => ok([])),
    getOrgAuditEvents: vi.fn(async () => ok([])),
    getOrgs: () => [],
    isEnterpriseScopeEnabled: () => true,
    now: () => NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordSeatLifecycleEvents.mockImplementation((_slug, events) => events.length);
  getSeatAuditSyncStates.mockReturnValue([]);
  enrichAuditLifecycleFromSeats.mockReturnValue(0);
});

describe("resolveAuditCutoff", () => {
  it("reaches back the full lookback on a first run", () => {
    const cutoff = resolveAuditCutoff(null, NOW);
    expect(cutoff).toBe(NOW.getTime() - SEAT_AUDIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  });

  it("resumes just before the watermark so late-indexed events are not skipped", () => {
    const watermark = "2026-06-29T00:00:00.000Z";
    const cutoff = resolveAuditCutoff(watermark, NOW);
    expect(cutoff).toBe(Date.parse(watermark) - SEAT_AUDIT_OVERLAP_HOURS * 60 * 60 * 1000);
  });

  it("never reads further back than the lookback allows", () => {
    const cutoff = resolveAuditCutoff("2020-01-01T00:00:00.000Z", NOW);
    expect(cutoff).toBe(NOW.getTime() - SEAT_AUDIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  });

  it("falls back to the lookback for an unparseable watermark", () => {
    const cutoff = resolveAuditCutoff("not-a-date", NOW);
    expect(cutoff).toBe(NOW.getTime() - SEAT_AUDIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("toLifecycleEvents", () => {
  it("maps cancel to offboarded and assign to onboarded", () => {
    const mapped = toLifecycleEvents([
      auditEvent({ action: "cancel", observedLogin: "leaver" }),
      auditEvent({ action: "assign", observedLogin: "joiner" }),
    ]);
    expect(mapped.map((e) => [e.userLogin, e.eventType])).toEqual([
      ["leaver", "offboarded"],
      ["joiner", "onboarded"],
    ]);
    expect(mapped.every((e) => e.source === "audit_log")).toBe(true);
  });

  it("falls back to a user-id placeholder when the login is obfuscated away", () => {
    const [mapped] = toLifecycleEvents([auditEvent({ observedLogin: null, githubUserId: 77 })]);
    expect(mapped.userLogin).toBe("user-77");
    expect(mapped.userId).toBe(77);
  });

  it("drops events with no usable identity rather than colliding on the ledger key", () => {
    expect(toLifecycleEvents([auditEvent({ observedLogin: "  ", githubUserId: null })])).toEqual([]);
  });
});

describe("syncSeatAuditEventsForEnterprise", () => {
  it("persists audit events as lifecycle rows and advances the watermark", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async () => ok([auditEvent(), auditEvent({ action: "assign" })])),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.status).toBe("ok");
    expect(result.target).toBe("enterprise");
    expect(result.eventsWritten).toBe(2);
    expect(recordSeatLifecycleEvents).toHaveBeenCalledWith("acme", expect.arrayContaining([
      expect.objectContaining({ source: "audit_log", eventType: "offboarded" }),
    ]));
    expect(recordSeatAuditSyncState).toHaveBeenCalledWith(expect.objectContaining({
      enterpriseSlug: "acme",
      status: "ok",
      target: "enterprise",
      coveredThrough: NOW.toISOString(),
    }));
  });

  it("backfills seat metadata onto the audit rows it just wrote", async () => {
    const deps = makeDeps({ getEnterpriseAuditEvents: vi.fn(async () => ok([auditEvent()])) });
    await syncSeatAuditEventsForEnterprise("acme", deps);
    expect(enrichAuditLifecycleFromSeats).toHaveBeenCalled();
  });

  it("falls back to org audit logs when the enterprise endpoint is unavailable", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({
        status: "unavailable",
        reason: "not_found",
        target: "acme",
      })),
      getOrgAuditEvents: vi.fn(async () => ok([auditEvent({ orgLogin: "org1" })])),
      getOrgs: () => ["org1"],
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.status).toBe("ok");
    expect(result.target).toBe("org");
    expect(result.eventsWritten).toBe(1);
  });

  it("records a forbidden audit log as unavailable with an actionable reason", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({
        status: "unavailable",
        reason: "forbidden",
        target: "acme",
      })),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.status).toBe("unavailable");
    expect(result.reason).toMatch(/read:audit_log/);
    expect(recordSeatLifecycleEvents).not.toHaveBeenCalled();
    expect(recordSeatAuditSyncState).toHaveBeenCalledWith(expect.objectContaining({
      status: "unavailable",
      coveredFrom: null,
      coveredThrough: null,
    }));
  });

  it("reports a transient failure as an error, not a missing capability", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({
        status: "unknown",
        target: "acme",
        message: "GitHub API error 502 fetching Copilot audit log events.",
      })),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.status).toBe("error");
    expect(result.reason).toMatch(/502/);
  });

  it("does not claim coverage of the unread tail when the fetch was truncated", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async () =>
        ok([
          auditEvent({ occurredAt: "2026-06-20T00:00:00.000Z" }),
          auditEvent({ occurredAt: "2026-06-25T00:00:00.000Z" }),
        ], true),
      ),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.truncated).toBe(true);
    // The audit log paginates newest-first, so the pagination cap cut off the
    // OLDEST part of the window — coverage must start at the oldest event
    // actually seen, not at the requested cutoff, or snapshot-derived rows for
    // an unread range would be wrongly suppressed.
    expect(result.coveredFrom).toBe("2026-06-20T00:00:00.000Z");
    // The newest end WAS read, so the watermark still advances.
    expect(result.coveredThrough).toBe(NOW.toISOString());
  });

  it("claims the full requested window when the fetch was complete", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async () => ok([auditEvent({ occurredAt: "2026-06-20T00:00:00.000Z" })])),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.coveredFrom).toBe(
      new Date(NOW.getTime() - SEAT_AUDIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(result.coveredThrough).toBe(NOW.toISOString());
  });

  it("resumes from the stored watermark instead of refetching the whole lookback", async () => {
    getSeatAuditSyncStates.mockReturnValue([{
      enterpriseSlug: "acme",
      status: "ok",
      reason: null,
      target: "enterprise",
      coveredFrom: "2026-05-01T00:00:00.000Z",
      coveredThrough: "2026-06-29T00:00:00.000Z",
      lastEventAt: "2026-06-28T00:00:00.000Z",
      lastSyncedAt: "2026-06-29T00:00:00.000Z",
      eventsWritten: 3,
      truncated: false,
    }]);
    const getEnterpriseAuditEvents = vi.fn(async () => ok([]));

    await syncSeatAuditEventsForEnterprise("acme", makeDeps({ getEnterpriseAuditEvents }));

    const [, cutoffMs] = getEnterpriseAuditEvents.mock.calls[0] as unknown as [string, number];
    expect(cutoffMs).toBe(
      Date.parse("2026-06-29T00:00:00.000Z") - SEAT_AUDIT_OVERLAP_HOURS * 60 * 60 * 1000,
    );
  });

  it("skips the enterprise endpoint when enterprise scope is disabled", async () => {
    const getEnterpriseAuditEvents = vi.fn(async () => ok([]));
    const deps = makeDeps({
      getEnterpriseAuditEvents,
      isEnterpriseScopeEnabled: () => false,
      getOrgs: () => ["org1"],
      getOrgAuditEvents: vi.fn(async () => ok([auditEvent()])),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(getEnterpriseAuditEvents).not.toHaveBeenCalled();
    expect(result.target).toBe("org");
  });

  it("keeps partial org coverage when only some orgs answer", async () => {
    const deps = makeDeps({
      isEnterpriseScopeEnabled: () => false,
      getOrgs: () => ["good", "bad"],
      getOrgAuditEvents: vi.fn(async (org: string): Promise<AuditFetchResult> =>
        org === "good"
          ? ok([auditEvent({ orgLogin: "good" })])
          : { status: "unavailable", reason: "forbidden", target: org },
      ),
    });

    const result = await syncSeatAuditEventsForEnterprise("acme", deps);

    expect(result.status).toBe("ok");
    expect(result.eventsWritten).toBe(1);
    expect(result.warnings.join(" ")).toMatch(/1 organization/);
  });
});

describe("syncSeatAuditEventsSafely", () => {
  it("never throws into the caller and records the failure", async () => {
    const deps = makeDeps({
      getEnterpriseAuditEvents: vi.fn(async () => {
        throw new Error("network exploded");
      }),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await syncSeatAuditEventsSafely("acme", deps);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("network exploded");
    expect(recordSeatAuditSyncState).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    errorSpy.mockRestore();
  });
});
