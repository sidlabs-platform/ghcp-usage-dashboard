import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";

import {
  computeFingerprint,
  readImportFile,
  parseDelimitedText,
  stableStringify,
  emptyImportResult,
  ImportFileError,
  DEFAULT_MAX_IMPORT_BYTES,
} from "./import-shared";

const FIXTURE_DIR = path.join(process.cwd(), ".test-fixtures-import-shared");

beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function writeFixture(name: string, content: string | Buffer): string {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, content);
  return p;
}

describe("computeFingerprint", () => {
  it("is stable for identical content + metadata", () => {
    const a = computeFingerprint("hello world", { size: 11, mtimeMs: 12345 });
    const b = computeFingerprint("hello world", { size: 11, mtimeMs: 12345 });
    expect(a).toBe(b);
  });

  it("is stable regardless of metadata key insertion order", () => {
    const a = computeFingerprint("hello world", { size: 11, mtimeMs: 12345, path: "f.csv" });
    const b = computeFingerprint("hello world", { path: "f.csv", mtimeMs: 12345, size: 11 });
    expect(a).toBe(b);
  });

  it("changes when content changes", () => {
    const a = computeFingerprint("hello world", { size: 11 });
    const b = computeFingerprint("hello world!", { size: 11 });
    expect(a).not.toBe(b);
  });

  it("changes when metadata changes", () => {
    const a = computeFingerprint("hello world", { size: 11, mtimeMs: 1 });
    const b = computeFingerprint("hello world", { size: 11, mtimeMs: 2 });
    expect(a).not.toBe(b);
  });

  it("produces a hex digest string", () => {
    const a = computeFingerprint("x", {});
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stableStringify", () => {
  it("produces the same string regardless of key insertion order", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("sorts nested object keys recursively", () => {
    const a = stableStringify({ z: { y: 1, x: 2 }, a: 1 });
    const b = stableStringify({ a: 1, z: { x: 2, y: 1 } });
    expect(a).toBe(b);
  });

  it("preserves array element order", () => {
    const a = stableStringify({ list: [3, 1, 2] });
    expect(a).toBe(JSON.stringify({ list: [3, 1, 2] }));
  });

  it("differs when values differ", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("readImportFile", () => {
  it("reads a valid UTF-8 text file and returns content + fingerprint", () => {
    const p = writeFixture("valid.txt", "line1\nline2\n");
    const result = readImportFile(p);
    expect(result.content).toBe("line1\nline2\n");
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws ImportFileError for a missing file", () => {
    const p = path.join(FIXTURE_DIR, "does-not-exist.txt");
    expect(() => readImportFile(p)).toThrow(ImportFileError);
  });

  it("throws ImportFileError when the path is a directory, not a regular file", () => {
    const dirPath = path.join(FIXTURE_DIR, "a-directory");
    fs.mkdirSync(dirPath, { recursive: true });
    expect(() => readImportFile(dirPath)).toThrow(ImportFileError);
  });

  it("throws ImportFileError when the file exceeds the configured max byte size", () => {
    const p = writeFixture("too-big.txt", "a".repeat(1000));
    expect(() => readImportFile(p, { maxBytes: 100 })).toThrow(ImportFileError);
  });

  it("uses DEFAULT_MAX_IMPORT_BYTES when no explicit maxBytes is given", () => {
    expect(DEFAULT_MAX_IMPORT_BYTES).toBeGreaterThan(0);
    const p = writeFixture("small.txt", "small content");
    expect(() => readImportFile(p)).not.toThrow();
  });

  it("throws ImportFileError for content that is not valid UTF-8", () => {
    // 0xFF 0xFE is not a valid UTF-8 sequence on its own.
    const p = writeFixture("invalid-utf8.bin", Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(() => readImportFile(p)).toThrow(ImportFileError);
  });

  it("produces different fingerprints for files with identical content but different paths (fingerprint retains path as normalized source identity)", () => {
    const p1 = writeFixture("dup1.txt", "same content");
    const p2 = writeFixture("dup2.txt", "same content");
    const r1 = readImportFile(p1);
    const r2 = readImportFile(p2);
    // Different file names factor into metadata, so fingerprints differ even
    // though the byte content is identical.
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
  });

  it("produces the same fingerprint when re-reading the same unchanged file (idempotence)", () => {
    const p = writeFixture("stable.txt", "stable content");
    const r1 = readImportFile(p);
    const r2 = readImportFile(p);
    expect(r1.fingerprint).toBe(r2.fingerprint);
  });

  it("produces a stable fingerprint when the same path is rewritten with byte-identical content at a different mtime (content-stable, not volatile-metadata-stable)", () => {
    const p = writeFixture("rewrite-same-bytes.txt", "identical content");
    const r1 = readImportFile(p);

    // Rewrite the exact same bytes, then force an unambiguously different
    // mtime (re-writing alone may not reliably change mtime at typical
    // filesystem timestamp resolution) — this simulates a byte-identical
    // re-export at a later time, which must be idempotent.
    fs.writeFileSync(p, "identical content", "utf-8");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(p, future, future);

    const r2 = readImportFile(p);
    expect(r2.fingerprint).toBe(r1.fingerprint);
  });

  it("changes the fingerprint when the same path's content changes, independent of mtime", () => {
    const p = writeFixture("rewrite-different-bytes.txt", "version one");
    const r1 = readImportFile(p);
    fs.writeFileSync(p, "version two", "utf-8");
    const r2 = readImportFile(p);
    expect(r2.fingerprint).not.toBe(r1.fingerprint);
  });
});

describe("readImportFile — typed error reason classification", () => {
  it("classifies a missing file as reason 'not_found'", () => {
    const p = path.join(FIXTURE_DIR, "reason-missing.txt");
    try {
      readImportFile(p);
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("not_found");
    }
  });

  it("classifies a directory path as reason 'is_directory'", () => {
    const dirPath = path.join(FIXTURE_DIR, "reason-directory");
    fs.mkdirSync(dirPath, { recursive: true });
    try {
      readImportFile(dirPath);
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("is_directory");
    }
  });

  it("classifies an oversized file as reason 'too_large'", () => {
    const p = writeFixture("reason-too-big.txt", "a".repeat(1000));
    try {
      readImportFile(p, { maxBytes: 100 });
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("too_large");
    }
  });

  it("classifies invalid UTF-8 content as reason 'invalid_utf8'", () => {
    const p = writeFixture("reason-invalid-utf8.bin", Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    try {
      readImportFile(p);
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("invalid_utf8");
    }
  });

  it("classifies a non-ENOENT stat failure (e.g. permission denied) as reason 'io_error', distinct from 'not_found'", () => {
    const p = writeFixture("reason-io-error.txt", "content");
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    try {
      readImportFile(p);
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("io_error");
    } finally {
      statSpy.mockRestore();
    }
  });

  it("classifies a non-ENOENT readFileSync failure as reason 'io_error'", () => {
    const p = writeFixture("reason-read-io-error.txt", "content");
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    try {
      readImportFile(p);
      expect.unreachable("expected readImportFile to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportFileError);
      expect((err as ImportFileError).reason).toBe("io_error");
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe("emptyImportResult", () => {
  it("returns an empty result with a structured warning naming the missing file", () => {
    const p = path.join(FIXTURE_DIR, "missing-optional.csv");
    const result = emptyImportResult(p, "test_kind");
    expect(result.records).toEqual([]);
    expect(result.skippedRows).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/missing-optional\.csv/);
    expect(result.warnings[0]).toMatch(/not found/i);
  });

  it("produces a stable fingerprint across repeated calls for the same missing path", () => {
    const p = path.join(FIXTURE_DIR, "missing-stable.csv");
    const r1 = emptyImportResult(p, "test_kind");
    const r2 = emptyImportResult(p, "test_kind");
    expect(r1.sourceFingerprint).toBe(r2.sourceFingerprint);
  });

  it("produces a different fingerprint for a different missing path or kind", () => {
    const base = emptyImportResult(path.join(FIXTURE_DIR, "missing-a.csv"), "test_kind");
    const otherPath = emptyImportResult(path.join(FIXTURE_DIR, "missing-b.csv"), "test_kind");
    const otherKind = emptyImportResult(path.join(FIXTURE_DIR, "missing-a.csv"), "other_kind");
    expect(base.sourceFingerprint).not.toBe(otherPath.sourceFingerprint);
    expect(base.sourceFingerprint).not.toBe(otherKind.sourceFingerprint);
  });
});

describe("parseDelimitedText", () => {
  it("parses a simple CSV into headers + row objects", () => {
    const csv = "a,b,c\n1,2,3\n4,5,6\n";
    const parsed = parseDelimitedText(csv);
    expect(parsed.headers).toEqual(["a", "b", "c"]);
    expect(parsed.rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
    expect(parsed.malformedRowNumbers).toEqual([]);
  });

  it("handles quoted fields containing commas", () => {
    const csv = 'a,b\n"x,y",z\n';
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows[0]).toEqual({ a: "x,y", b: "z" });
  });

  it("handles multiline quoted fields (newline inside quotes)", () => {
    const csv = 'a,b\n"multi\nline",z\n';
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows[0]).toEqual({ a: "multi\nline", b: "z" });
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const csv = 'a,b\n"say ""hi""",z\n';
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows[0].a).toBe('say "hi"');
  });

  it("handles CRLF line endings", () => {
    const csv = "a,b\r\n1,2\r\n";
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("flags rows with a different column count than the header as malformed", () => {
    const csv = "a,b,c\n1,2\n4,5,6\n7,8,9,10\n";
    const parsed = parseDelimitedText(csv);
    // Row indices are 0-based relative to the data rows (header excluded).
    expect(parsed.malformedRowNumbers).toEqual([0, 2]);
    expect(parsed.rows).toHaveLength(3);
  });

  it("returns no rows for header-only input", () => {
    const parsed = parseDelimitedText("a,b,c");
    expect(parsed.rows).toEqual([]);
    expect(parsed.headers).toEqual(["a", "b", "c"]);
  });

  it("returns empty headers/rows for empty input", () => {
    const parsed = parseDelimitedText("");
    expect(parsed.headers).toEqual([]);
    expect(parsed.rows).toEqual([]);
  });

  it("treats a quoted all-empty row as real data, not a blank line to silently drop", () => {
    // Every field is explicitly quoted (`""`) — a deliberate empty-value
    // row, not an accidental blank line — so it must survive tokenization
    // as a data row (downstream row-level validation, e.g. in
    // aic-csv-import.ts, is what should flag/skip it as malformed).
    const csv = 'a,b,c\n"","",""\n1,2,3\n';
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({ a: "", b: "", c: "" });
    expect(parsed.rows[1]).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("still treats a truly blank line (no quotes, no commas) as a non-data line to skip", () => {
    const csv = "a,b,c\n1,2,3\n\n4,5,6\n";
    const parsed = parseDelimitedText(csv);
    expect(parsed.rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });
});
