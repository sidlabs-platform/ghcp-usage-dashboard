import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";

import { importIdentityMap } from "./identity-map-import";
import { ImportFileError } from "./import-shared";

const FIXTURE_DIR = path.join(process.cwd(), ".test-fixtures-identity-map-import");

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

describe("importIdentityMap — object mapping form", () => {
  it("normalizes a simple login -> resolvedLogin mapping object", () => {
    const p = writeFixture("mapping.json", JSON.stringify({ "old-alice": "alice", "old-bob": "bob" }));
    const result = importIdentityMap(p);
    expect(result.records).toHaveLength(2);
    const byExternal = new Map(result.records.map((r) => [r.externalIdentity, r]));
    expect(byExternal.get("old-alice")?.resolvedLogin).toBe("alice");
    expect(byExternal.get("old-bob")?.resolvedLogin).toBe("bob");
  });

  it("normalizes an object mapping with rich value objects (resolvedLogin + metadata)", () => {
    const p = writeFixture(
      "mapping-rich.json",
      JSON.stringify({
        "saml-alice-123": { resolvedLogin: "alice", accountState: "active" },
      }),
    );
    const result = importIdentityMap(p);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].resolvedLogin).toBe("alice");
    expect(result.records[0].accountState).toBe("active");
  });
});

describe("importIdentityMap — list form", () => {
  it("normalizes a list of { externalIdentity, resolvedLogin } entries", () => {
    const p = writeFixture(
      "list.json",
      JSON.stringify([
        { externalIdentity: "ext-1", resolvedLogin: "alice" },
        { externalIdentity: "ext-2", resolvedLogin: "bob" },
      ]),
    );
    const result = importIdentityMap(p);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.resolvedLogin)).toEqual(["alice", "bob"]);
  });

  it("accepts alias field names (externalId/external_identity, login/resolved_login)", () => {
    const p = writeFixture(
      "list-aliases.json",
      JSON.stringify([
        { external_identity: "ext-1", login: "alice" },
        { externalId: "ext-2", resolved_login: "bob" },
      ]),
    );
    const result = importIdentityMap(p);
    expect(result.records.map((r) => r.resolvedLogin)).toEqual(["alice", "bob"]);
  });
});

describe("importIdentityMap — case-insensitive normalization", () => {
  it("normalizes resolvedLogin to lowercase for consistent joins", () => {
    const p = writeFixture("case.json", JSON.stringify({ "ext-1": "Alice" }));
    const result = importIdentityMap(p);
    expect(result.records[0].resolvedLogin).toBe("alice");
  });

  it("treats logins differing only by case as the same identity when detecting collisions", () => {
    const p = writeFixture(
      "case-collision.json",
      JSON.stringify([
        { externalIdentity: "ext-1", resolvedLogin: "Alice" },
        { externalIdentity: "ext-2", resolvedLogin: "alice" },
      ]),
    );
    const result = importIdentityMap(p);
    // Both map to the same normalized login from two different external
    // identities — not itself an error (many-to-one is valid), but should
    // not silently produce two unrelated identities without normalization.
    expect(result.records.map((r) => r.resolvedLogin)).toEqual(["alice", "alice"]);
  });
});

describe("importIdentityMap — conflicting mappings / collisions", () => {
  it("warns when the same external identity maps to two different resolved logins", () => {
    const p = writeFixture(
      "conflict.json",
      JSON.stringify([
        { externalIdentity: "ext-1", resolvedLogin: "alice" },
        { externalIdentity: "ext-1", resolvedLogin: "alice2" },
      ]),
    );
    const result = importIdentityMap(p);
    expect(result.warnings.some((w) => /conflict/i.test(w))).toBe(true);
  });

  it("does not warn when the same external identity maps to the same resolved login twice (case-insensitive)", () => {
    const p = writeFixture(
      "no-conflict-case.json",
      JSON.stringify([
        { externalIdentity: "ext-1", resolvedLogin: "Alice" },
        { externalIdentity: "ext-1", resolvedLogin: "alice" },
      ]),
    );
    const result = importIdentityMap(p);
    expect(result.warnings.some((w) => /conflict/i.test(w))).toBe(false);
  });
});

describe("importIdentityMap — never puts an external identity into resolvedLogin", () => {
  it("skips and warns on an entry with a missing/blank resolvedLogin rather than falling back to the external identity", () => {
    const p = writeFixture(
      "missing-resolved.json",
      JSON.stringify([{ externalIdentity: "ext-1", resolvedLogin: "" }, { externalIdentity: "ext-2", resolvedLogin: "bob" }]),
    );
    const result = importIdentityMap(p);
    expect(result.records).toHaveLength(1);
    expect(result.records[0].resolvedLogin).toBe("bob");
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /resolvedLogin/i.test(w))).toBe(true);
    // Guard against the exact regression this test targets: no record's
    // resolvedLogin should ever equal the raw external identity value.
    expect(result.records.every((r) => r.resolvedLogin !== r.externalIdentity)).toBe(true);
  });
});

describe("importIdentityMap — malformed entries and file errors", () => {
  it("skips and warns on an entry missing externalIdentity", () => {
    const p = writeFixture("missing-external.json", JSON.stringify([{ resolvedLogin: "alice" }]));
    const result = importIdentityMap(p);
    expect(result.records).toHaveLength(0);
    expect(result.skippedRows).toBe(1);
    expect(result.warnings.some((w) => /externalIdentity/i.test(w))).toBe(true);
  });

  it("gracefully skips every entry (reporting them as malformed) for a top-level array of primitives, rather than throwing", () => {
    const p = writeFixture("wrong-shape.json", JSON.stringify([1, 2, 3]));
    const result = importIdentityMap(p);
    // Every entry is malformed (not an object) — reported, not crashed.
    expect(result.records).toHaveLength(0);
    expect(result.skippedRows).toBe(3);
  });

  it("throws for content that is a JSON primitive at the top level", () => {
    const p = writeFixture("primitive.json", JSON.stringify("just a string"));
    expect(() => importIdentityMap(p)).toThrow();
  });

  it("returns a valid empty ImportResult with a structured warning when the configured identity map path does not exist (optional source)", () => {
    const missingPath = path.join(FIXTURE_DIR, "nope.json");
    const result = importIdentityMap(missingPath);
    expect(result.records).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/not found/i);
    expect(result.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still throws ImportFileError when the configured identity map path is a directory (not degraded to empty — identity map config is single-file only)", () => {
    const dirPath = path.join(FIXTURE_DIR, "identity-map-as-directory");
    fs.mkdirSync(dirPath, { recursive: true });
    expect(() => importIdentityMap(dirPath)).toThrow(ImportFileError);
  });

  it("still throws ImportFileError for an oversized configured identity map file (not degraded to empty)", () => {
    const p = writeFixture(
      "too-big.json",
      JSON.stringify(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`ext-${i}`, `user${i}`]))),
    );
    expect(() => importIdentityMap(p, { maxBytes: 50 })).toThrow(ImportFileError);
  });
});

describe("importIdentityMap — fingerprint", () => {
  it("is stable for unchanged content and changes when content changes", () => {
    const p = writeFixture("fp.json", JSON.stringify({ "ext-1": "alice" }));
    const r1 = importIdentityMap(p);
    const r2 = importIdentityMap(p);
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);

    fs.writeFileSync(p, JSON.stringify({ "ext-1": "alice2" }), "utf-8");
    const r3 = importIdentityMap(p);
    expect(r3.sourceFingerprint).not.toBe(r1.sourceFingerprint);
  });
});
