import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

import { importAuditArchive } from "./audit-archive-import";
import { ImportFileError } from "./import-shared";

const FIXTURE_DIR = path.join(process.cwd(), ".test-fixtures-audit-archive-import");

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("importAuditArchive — JSON array form", () => {
  it("normalizes relevant Copilot seat-assignment events from a JSON array", () => {
    const p = writeFixture(
      "array.json",
      JSON.stringify([
        {
          action: "business.copilot_seat_management.assign_seat",
          actor: "admin1",
          user: "alice",
          org: "acme-org",
          created_at: 1735689600000, // ms epoch
        },
        {
          action: "business.copilot_seat_management.remove_seat",
          actor: "admin1",
          user: "bob",
          org: "acme-org",
          created_at: 1735776000000,
        },
      ]),
    );

    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].action).toBe("business.copilot_seat_management.assign_seat");
    expect(result.records[0].observedLogin).toBe("alice");
    expect(result.records[0].orgLogin).toBe("acme-org");
    expect(result.records[0].source).toBe("audit_archive");
    expect(result.records[0].eventId).toMatch(/^[0-9a-f]{16,}$/);
    expect(result.records[0].raw).toBeDefined();
  });

  it("produces deterministic, stable event IDs across repeated imports of the same content", () => {
    const p = writeFixture(
      "stable-ids.json",
      JSON.stringify([
        { action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" },
      ]),
    );
    const r1 = importAuditArchive(p);
    const r2 = importAuditArchive(p);
    expect(r1.records[0].eventId).toBe(r2.records[0].eventId);
  });

  it("produces different event IDs for events with different content", () => {
    const p = writeFixture(
      "distinct-ids.json",
      JSON.stringify([
        { action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" },
        { action: "copilot.seat_assignment_created", user: "bob", org: "acme", created_at: "2026-01-01T00:00:00Z" },
      ]),
    );
    const result = importAuditArchive(p);
    expect(result.records[0].eventId).not.toBe(result.records[1].eventId);
  });
});

describe("importAuditArchive — NDJSON form", () => {
  it("normalizes relevant events from newline-delimited JSON", () => {
    const lines = [
      JSON.stringify({ action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" }),
      JSON.stringify({ action: "copilot.seat_assignment_deleted", user: "bob", org: "acme", created_at: "2026-01-02T00:00:00Z" }),
    ].join("\n");
    const p = writeFixture("archive.ndjson", lines + "\n");

    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.observedLogin)).toEqual(["alice", "bob"]);
  });

  it("reports a malformed NDJSON line instead of failing the whole import", () => {
    const lines = [
      JSON.stringify({ action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" }),
      "{not valid json",
      JSON.stringify({ action: "copilot.seat_assignment_created", user: "carol", org: "acme", created_at: "2026-01-03T00:00:00Z" }),
    ].join("\n");
    const p = writeFixture("archive-malformed.ndjson", lines + "\n");

    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.observedLogin)).toEqual(["alice", "carol"]);
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /malformed|invalid json/i.test(w))).toBe(true);
  });
});

describe("importAuditArchive — skipping unrelated actions", () => {
  it("skips non-Copilot-licensing actions and reports a count, without treating them as malformed", () => {
    const p = writeFixture(
      "unrelated.json",
      JSON.stringify([
        { action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" },
        { action: "repo.create", actor: "alice", org: "acme", created_at: "2026-01-01T00:00:01Z" },
        { action: "team.add_member", actor: "bob", org: "acme", created_at: "2026-01-01T00:00:02Z" },
      ]),
    );

    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].action).toBe("copilot.seat_assignment_created");
    expect(result.skippedRows).toBe(0); // unrelated actions are not "skipped rows" (they're not malformed)
    expect(result.warnings.some((w) => /skipped 2 unrelated/i.test(w))).toBe(true);
  });
});

describe("importAuditArchive — malformed rows and file errors", () => {
  it("reports a malformed entry (missing required action) instead of broadly swallowing it", () => {
    const p = writeFixture(
      "missing-action.json",
      JSON.stringify([
        { user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" },
        { action: "copilot.seat_assignment_created", user: "bob", org: "acme", created_at: "2026-01-02T00:00:00Z" },
      ]),
    );
    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /action/i.test(w))).toBe(true);
  });

  it("reports a malformed entry (missing/invalid timestamp) instead of broadly swallowing it", () => {
    const p = writeFixture(
      "missing-timestamp.json",
      JSON.stringify([
        { action: "copilot.seat_assignment_created", user: "alice", org: "acme" },
        { action: "copilot.seat_assignment_created", user: "bob", org: "acme", created_at: "2026-01-02T00:00:00Z" },
      ]),
    );
    const result = importAuditArchive(p);
    expect(result.records).toHaveLength(1);
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /timestamp|created_at|occurred/i.test(w))).toBe(true);
  });

  it("throws for content that is neither a JSON array nor a JSON object", () => {
    const p = writeFixture("bad-top-level.json", JSON.stringify("just a string"));
    expect(() => importAuditArchive(p)).toThrow();
  });

  it("returns a valid empty ImportResult with a structured warning when the configured archive path does not exist (optional source)", () => {
    const missingPath = path.join(FIXTURE_DIR, "nope.json");
    const result = importAuditArchive(missingPath);
    expect(result.records).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not found/i);
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a valid empty ImportResult (not a hard error) when the configured archive path is a directory — auditArchivePath is documented as directory-or-path", () => {
    const dirPath = path.join(FIXTURE_DIR, "archive-as-directory");
    fs.mkdirSync(dirPath, { recursive: true });
    const result = importAuditArchive(dirPath);
    expect(result.records).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.warnings.some((w) => /directory|not found/i.test(w))).toBe(true);
  });

  it("still throws ImportFileError for an oversized configured archive file (not degraded to empty)", () => {
    const p = writeFixture(
      "too-big.json",
      JSON.stringify(
        Array.from({ length: 50 }, (_, i) => ({
          action: "copilot.seat_assignment_created",
          user: `user${i}`,
          org: "acme",
          created_at: "2026-01-01T00:00:00Z",
        })),
      ),
    );
    expect(() => importAuditArchive(p, { maxBytes: 50 })).toThrow(ImportFileError);
  });
});

describe("importAuditArchive — fingerprint", () => {
  it("is stable for unchanged content and changes when content changes", () => {
    const p = writeFixture(
      "fp.json",
      JSON.stringify([{ action: "copilot.seat_assignment_created", user: "alice", org: "acme", created_at: "2026-01-01T00:00:00Z" }]),
    );
    const r1 = importAuditArchive(p);
    const r2 = importAuditArchive(p);
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);

    fs.writeFileSync(
      p,
      JSON.stringify([{ action: "copilot.seat_assignment_created", user: "alice2", org: "acme", created_at: "2026-01-01T00:00:00Z" }]),
      "utf-8",
    );
    const r3 = importAuditArchive(p);
    expect(r3.sourceFingerprint).not.toBe(r1.sourceFingerprint);
  });
});
