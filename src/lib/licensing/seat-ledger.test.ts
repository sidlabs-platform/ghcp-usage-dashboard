import { describe, it, expect } from "vitest";
import {
  buildSeatLedger,
  type SeatLedgerAuditEventInput,
  type SeatLedgerSnapshotInput,
  type SeatLedgerLiveSeatInput,
} from "./seat-ledger";

function auditEvent(overrides: Partial<SeatLedgerAuditEventInput>): SeatLedgerAuditEventInput {
  return {
    eventId: "evt-default",
    source: "audit_log",
    orgLogin: "acme",
    holderKey: "id:1",
    githubUserId: 1,
    action: "assign",
    occurredAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildSeatLedger — modern/legacy action normalization", () => {
  it("opens an assignment interval on assign and closes it on cancel", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-05T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const row = result.rows.find((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(row).toBeDefined();
    expect(row?.confidence).toBe("audit_reconstructed");
    expect(row?.assignedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(row?.revokedAt).toBe("2026-01-20T00:00:00.000Z");
  });

  it("treats a refresh event as retaining activity rather than opening a duplicate interval", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "refresh", occurredAt: "2026-01-15T00:00:00Z" }),
        auditEvent({ eventId: "e3", action: "cancel", occurredAt: "2026-01-25T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(1);
    expect(rows[0].assignedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(rows[0].revokedAt).toBe("2026-01-25T00:00:00.000Z");
  });
});

describe("buildSeatLedger — repeated assignment / cancellation / missing cancellation", () => {
  it("does not create duplicate intervals for repeated assign events while already active", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "assign", occurredAt: "2026-01-10T00:00:00Z" }),
        auditEvent({ eventId: "e3", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(1);
    expect(rows[0].assignedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("ignores a cancel event with nothing currently active (no negative interval)", () => {
    const result = buildSeatLedger({
      auditEvents: [auditEvent({ eventId: "e1", action: "cancel", occurredAt: "2026-01-05T00:00:00Z" })],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(0);
  });

  it("leaves an interval open through the current period when cancellation is missing", () => {
    const result = buildSeatLedger({
      auditEvents: [auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" })],
      periods: ["2026-01", "2026-02"],
      currentPeriod: "2026-02",
    });
    const jan = result.rows.find((r) => r.billingPeriod === "2026-01" && r.holderKey === "id:1");
    const feb = result.rows.find((r) => r.billingPeriod === "2026-02" && r.holderKey === "id:1");
    expect(jan?.confidence).toBe("audit_reconstructed");
    expect(jan?.revokedAt).toBeNull();
    expect(feb?.confidence).toBe("audit_reconstructed");
    expect(feb?.revokedAt).toBeNull();
  });

  it("does not extend an open interval (missing cancellation) into periods beyond the current period", () => {
    const result = buildSeatLedger({
      auditEvents: [auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" })],
      periods: ["2026-03"],
      currentPeriod: "2026-02",
    });
    const mar = result.rows.find((r) => r.billingPeriod === "2026-03" && r.holderKey === "id:1");
    expect(mar).toBeUndefined();
    const coverage = result.coverage.find((c) => c.billingPeriod === "2026-03" && c.orgLogin === "acme");
    expect(coverage?.confidence).toBe("unrecoverable");
  });
});

describe("buildSeatLedger — same-day / same-instant deterministic ordering", () => {
  it("processes a same-instant assign+cancel conservatively, ending inactive", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-10T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "cancel", occurredAt: "2026-01-10T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(1);
    expect(rows[0].revokedAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("produces the same result regardless of input array order for same-instant events", () => {
    const events = [
      auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-10T00:00:00Z" }),
      auditEvent({ eventId: "e2", action: "cancel", occurredAt: "2026-01-10T00:00:00Z" }),
    ];
    const a = buildSeatLedger({ auditEvents: events, periods: ["2026-01"], currentPeriod: "2026-02" });
    const b = buildSeatLedger({ auditEvents: [...events].reverse(), periods: ["2026-01"], currentPeriod: "2026-02" });
    expect(a.rows).toEqual(b.rows);
  });
});

describe("buildSeatLedger — archive/API dedupe", () => {
  it("collapses an exact duplicate event_id+source pair from re-ingesting the same archive", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", source: "audit_archive", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e1", source: "audit_archive", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", source: "audit_archive", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(1);
  });

  it("does not create a duplicate transition when the same logical assign is seen from both archive and live API sources", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "archive-1", source: "audit_archive", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "api-1", source: "audit_log", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "api-2", source: "audit_log", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.holderKey === "id:1" && r.billingPeriod === "2026-01");
    expect(rows.length).toBe(1);
  });

  it("is deterministic across repeated calls with the same (possibly duplicated) input", () => {
    const events = [
      auditEvent({ eventId: "e1", source: "audit_archive", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
      auditEvent({ eventId: "e1", source: "audit_archive", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
    ];
    const first = buildSeatLedger({ auditEvents: events, periods: ["2026-01"], currentPeriod: "2026-02" });
    const second = buildSeatLedger({ auditEvents: events, periods: ["2026-01"], currentPeriod: "2026-02" });
    expect(first).toEqual(second);
  });
});

describe("buildSeatLedger — seat source precedence", () => {
  const snapshot: SeatLedgerSnapshotInput = {
    billingPeriod: "2026-01",
    orgLogin: "acme",
    holderKey: "id:1",
    githubUserId: 1,
    observedLogin: "octocat",
    snapshotAt: "2026-01-31T23:59:59Z",
  };

  it("prefers a stored authoritative monthly snapshot over a reconstructed audit interval for the same period/key", () => {
    const result = buildSeatLedger({
      snapshots: [snapshot],
      auditEvents: [auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" })],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const row = result.rows.find((r) => r.billingPeriod === "2026-01" && r.holderKey === "id:1");
    expect(row?.confidence).toBe("exact_snapshot");
  });

  it("falls back to an audit-reconstructed interval when no snapshot exists for that period/key", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const row = result.rows.find((r) => r.billingPeriod === "2026-01" && r.holderKey === "id:1");
    expect(row?.confidence).toBe("audit_reconstructed");
  });

  it("falls back to the current live snapshot only for the current period when nothing else covers it", () => {
    const live: SeatLedgerLiveSeatInput = {
      orgLogin: "acme",
      holderKey: "id:1",
      githubUserId: 1,
      observedLogin: "octocat",
      observedAt: "2026-02-15T00:00:00Z",
    };
    const result = buildSeatLedger({
      liveSeats: [live],
      periods: ["2026-02"],
      currentPeriod: "2026-02",
    });
    const row = result.rows.find((r) => r.billingPeriod === "2026-02" && r.holderKey === "id:1");
    expect(row?.confidence).toBe("live_snapshot_only");
  });

  it("does not apply the live-snapshot fallback to non-current periods", () => {
    const live: SeatLedgerLiveSeatInput = {
      orgLogin: "acme",
      holderKey: "id:1",
      githubUserId: 1,
      observedLogin: "octocat",
      observedAt: "2026-02-15T00:00:00Z",
    };
    const result = buildSeatLedger({
      liveSeats: [live],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const row = result.rows.find((r) => r.billingPeriod === "2026-01" && r.holderKey === "id:1");
    expect(row).toBeUndefined();
    const coverage = result.coverage.find((c) => c.billingPeriod === "2026-01" && c.orgLogin === "acme");
    expect(coverage?.confidence).toBe("unrecoverable");
  });

  it("marks a period/org as unrecoverable (never a fabricated row) when no source covers it", () => {
    const result = buildSeatLedger({
      periods: ["2025-06"],
      currentPeriod: "2026-02",
      auditEvents: [auditEvent({ eventId: "e1", orgLogin: "other-org", action: "assign", occurredAt: "2026-01-01T00:00:00Z" })],
    });
    expect(result.rows.length).toBe(0);
    const coverage = result.coverage.find((c) => c.billingPeriod === "2025-06");
    expect(coverage?.confidence).toBe("unrecoverable");
    expect(result.warnings.length + coverage!.warnings.length).toBeGreaterThan(0);
  });
});

describe("buildSeatLedger — period overlap and month materialization", () => {
  it("materializes only the requested months using UTC period boundaries", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", action: "assign", occurredAt: "2026-01-15T00:00:00Z" }),
        auditEvent({ eventId: "e2", action: "cancel", occurredAt: "2026-03-15T00:00:00Z" }),
      ],
      periods: ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04"],
      currentPeriod: "2026-04",
    });
    const byPeriod = new Map(result.rows.filter((r) => r.holderKey === "id:1").map((r) => [r.billingPeriod, r]));
    expect(byPeriod.has("2025-12")).toBe(false);
    expect(byPeriod.has("2026-01")).toBe(true);
    expect(byPeriod.has("2026-02")).toBe(true);
    expect(byPeriod.has("2026-03")).toBe(true);
    expect(byPeriod.has("2026-04")).toBe(false);
  });

  it("throws for a malformed requested period rather than silently ignoring it", () => {
    expect(() => buildSeatLedger({ periods: ["not-a-period"], currentPeriod: "2026-02" })).toThrow();
  });
});

describe("buildSeatLedger — canonical org separation for multi-org users", () => {
  it("does not collapse or copy the same holderKey's assignment across different orgs", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", orgLogin: "acme", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", orgLogin: "acme", action: "cancel", occurredAt: "2026-01-20T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const acmeRow = result.rows.find((r) => r.orgLogin === "acme" && r.holderKey === "id:1");
    const otherOrgRow = result.rows.find((r) => r.orgLogin === "beta-corp" && r.holderKey === "id:1");
    expect(acmeRow).toBeDefined();
    expect(otherOrgRow).toBeUndefined();
  });

  it("tracks independent assignment intervals per org for the same holder", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", orgLogin: "acme", action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", orgLogin: "beta-corp", action: "assign", occurredAt: "2026-01-10T00:00:00Z" }),
        auditEvent({ eventId: "e3", orgLogin: "acme", action: "cancel", occurredAt: "2026-01-15T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const acmeRow = result.rows.find((r) => r.orgLogin === "acme" && r.holderKey === "id:1");
    const betaRow = result.rows.find((r) => r.orgLogin === "beta-corp" && r.holderKey === "id:1");
    expect(acmeRow?.revokedAt).toBe("2026-01-15T00:00:00.000Z");
    expect(betaRow?.revokedAt).toBeNull();
  });
});

describe("buildSeatLedger — confidence classification", () => {
  it("classifies exactly exact_snapshot | audit_reconstructed | live_snapshot_only | unrecoverable", () => {
    const validValues = new Set(["exact_snapshot", "audit_reconstructed", "live_snapshot_only", "unrecoverable"]);
    const result = buildSeatLedger({
      snapshots: [
        { billingPeriod: "2026-01", orgLogin: "acme", holderKey: "id:1", githubUserId: 1, observedLogin: "octocat", snapshotAt: "2026-01-31T00:00:00Z" },
      ],
      auditEvents: [auditEvent({ eventId: "e1", orgLogin: "acme", holderKey: "id:2", githubUserId: 2, action: "assign", occurredAt: "2026-01-01T00:00:00Z" })],
      liveSeats: [{ orgLogin: "acme", holderKey: "id:3", githubUserId: 3, observedLogin: "live-user", observedAt: "2026-02-01T00:00:00Z" }],
      periods: ["2025-01", "2026-01", "2026-02"],
      currentPeriod: "2026-02",
    });
    for (const row of result.rows) {
      expect(validValues.has(row.confidence)).toBe(true);
    }
    for (const c of result.coverage) {
      expect(validValues.has(c.confidence)).toBe(true);
    }
  });

  it("never fabricates an assignment row for unrecoverable coverage", () => {
    const result = buildSeatLedger({ periods: ["2025-01"], currentPeriod: "2026-02" });
    expect(result.rows.length).toBe(0);
  });
});

describe("buildSeatLedger — deterministic output sorting", () => {
  it("sorts rows by billingPeriod, orgLogin, then holderKey", () => {
    const result = buildSeatLedger({
      auditEvents: [
        auditEvent({ eventId: "e1", orgLogin: "zeta", holderKey: "id:2", githubUserId: 2, action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
        auditEvent({ eventId: "e2", orgLogin: "acme", holderKey: "id:1", githubUserId: 1, action: "assign", occurredAt: "2026-01-01T00:00:00Z" }),
      ],
      periods: ["2026-01"],
      currentPeriod: "2026-02",
    });
    const rows = result.rows.filter((r) => r.billingPeriod === "2026-01");
    const sorted = [...rows].sort((a, b) =>
      a.billingPeriod === b.billingPeriod
        ? a.orgLogin === b.orgLogin
          ? a.holderKey.localeCompare(b.holderKey)
          : a.orgLogin.localeCompare(b.orgLogin)
        : a.billingPeriod.localeCompare(b.billingPeriod),
    );
    expect(rows).toEqual(sorted);
  });
});
