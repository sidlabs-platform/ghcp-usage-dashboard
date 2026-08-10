// Shared helpers for licensing-history file-based import adapters (AI-credit
// CSV, audit-log archive, identity map). Centralizes:
//  - The common `ImportResult<T>` contract every import adapter returns.
//  - Deterministic content+metadata fingerprinting, so re-importing the same
//    unchanged source is idempotent and detectable by later orchestration.
//  - Safe local file reading. Callers must only ever pass a path that has
//    already been resolved from server configuration (e.g.
//    `getLicensingConfig().history.auditArchivePath`) — never a path derived
//    from request URL/query input. This module never reads process.argv,
//    req.query, or similar untrusted sources itself; it only validates and
//    reads whatever path it is given.
//  - A quoted/multiline-aware CSV tokenizer shared by aic-csv-import.
//
// No DB access happens here (or in any import adapter built on top of this
// module) — repository writes are a later orchestration concern. This
// module also never logs raw file contents or secrets.

import fs from "fs";
import path from "path";
import crypto from "crypto";

// ── Shared result contract ─────────────────────────────────────────────

/** Result of importing zero or more typed records from an external source. */
export interface ImportResult<T> {
  records: T[];
  /** Human-readable, non-fatal issues encountered while importing (never includes raw file contents). */
  warnings: string[];
  /** Count of input rows/entries that could not be normalized into a record. */
  skippedRows: number;
  /** Deterministic fingerprint of the source content + relevant metadata, for idempotent re-imports. */
  sourceFingerprint: string;
}

// ── Fingerprinting ──────────────────────────────────────────────────────

/** Arbitrary metadata mixed into a fingerprint alongside content (e.g. path, size, mtime). */
export type FingerprintMetadata = Record<string, unknown>;

/**
 * Deterministic content+metadata fingerprint. Sorts metadata keys so
 * insertion order never changes the result — the same logical input always
 * produces the same digest, and any change to content or metadata changes
 * it. Used so callers (later repo orchestration) can detect whether a
 * source file/content has already been imported.
 */
export function computeFingerprint(content: string, metadata: FingerprintMetadata = {}): string {
  const hash = crypto.createHash("sha256");
  hash.update(content);
  const sortedMetaEntries = Object.keys(metadata)
    .sort()
    .map((key) => `${key}=${String(metadata[key])}`)
    .join("&");
  // NUL separator so content can never collide with the metadata suffix.
  hash.update("\u0000" + sortedMetaEntries);
  return hash.digest("hex");
}

// ── Safe local file reading ─────────────────────────────────────────────

/** Distinguishes *why* {@link readImportFile} rejected a configured path — used by import adapters to decide which failures are safe to degrade gracefully (a missing optional source) versus which must remain hard, explicit failures. */
export type ImportFileErrorReason = "not_found" | "is_directory" | "not_a_file" | "too_large" | "invalid_utf8" | "io_error";

/** Thrown for any problem validating or reading a configured import file path. */
export class ImportFileError extends Error {
  constructor(message: string, public readonly reason: ImportFileErrorReason) {
    super(message);
    this.name = "ImportFileError";
  }
}

/**
 * Documented safe default cap on import file size: 50 MiB comfortably fits
 * years of monthly CSV/audit-archive exports while bounding memory use for a
 * single synchronous read.
 */
export const DEFAULT_MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface ReadImportFileOptions {
  /** Maximum allowed file size in bytes. Default: {@link DEFAULT_MAX_IMPORT_BYTES}. */
  maxBytes?: number;
}

export interface ReadImportFileResult {
  content: string;
  fingerprint: string;
}

/** True when re-encoding the decoded string reproduces the original bytes exactly (i.e. valid UTF-8). */
function isValidUtf8(buffer: Buffer): boolean {
  const decoded = buffer.toString("utf-8");
  const reEncoded = Buffer.from(decoded, "utf-8");
  return Buffer.compare(buffer, reEncoded) === 0;
}

/**
 * Read a UTF-8 text file from a path that must already be resolved from
 * server configuration (never raw URL/query input — see module docs).
 * Validates: the path exists and resolves to a regular file, its size is
 * within `maxBytes`, and its content is valid UTF-8. Returns the decoded
 * content plus a fingerprint — never logs raw content.
 *
 * **Fingerprint semantics**: the fingerprint is a pure function of the
 * file's *content* plus its *basename* (a normalized, non-volatile source
 * identity — e.g. distinguishing "the same bytes imported from two
 * differently-named configured sources"). It deliberately excludes every
 * volatile filesystem attribute (mtime, size-on-disk, inode, etc.), so a
 * byte-identical re-export of the same source — even rewritten at a later
 * time — always produces the *same* fingerprint. This is what makes
 * re-imports idempotent: callers can compare fingerprints to detect "this
 * exact source was already imported" without being defeated by a export
 * tool simply touching the file's mtime on every run.
 *
 * Every failure is a typed {@link ImportFileError} whose `reason` lets
 * callers distinguish a missing optional source (`"not_found"`, and for the
 * audit archive path specifically `"is_directory"` — see
 * `audit-archive-import.ts`) — which is safe to degrade to an empty result —
 * from every other failure (`"too_large"`, `"invalid_utf8"`, `"io_error"`,
 * or a non-directory `"not_a_file"`), which must remain an explicit,
 * surfaced failure rather than being silently swallowed.
 */
export function readImportFile(configuredPath: string, options: ReadImportFileOptions = {}): ReadImportFileResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES;
  const displayName = path.basename(configuredPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configuredPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new ImportFileError(`Import file not found: ${displayName}`, "not_found");
    }
    throw new ImportFileError(`Import file is not accessible: ${displayName}`, "io_error");
  }

  if (!stat.isFile()) {
    if (stat.isDirectory()) {
      throw new ImportFileError(`Import path is a directory, not a file: ${displayName}`, "is_directory");
    }
    throw new ImportFileError(`Import path is not a regular file: ${displayName}`, "not_a_file");
  }

  if (stat.size > maxBytes) {
    throw new ImportFileError(
      `Import file exceeds maximum allowed size of ${maxBytes} bytes (actual: ${stat.size} bytes): ${displayName}`,
      "too_large",
    );
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(configuredPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new ImportFileError(`Import file not found: ${displayName}`, "not_found");
    }
    throw new ImportFileError(`Import file could not be read: ${displayName}`, "io_error");
  }

  if (!isValidUtf8(buffer)) {
    throw new ImportFileError(`Import file is not valid UTF-8: ${displayName}`, "invalid_utf8");
  }

  const content = buffer.toString("utf-8");
  // Deliberately content-stable: only `path` (the basename) is mixed in as
  // normalized source identity. No volatile filesystem metadata (mtime,
  // stat.size, inode, etc.) is ever included — see the docstring above.
  const fingerprint = computeFingerprint(content, { path: displayName });

  return { content, fingerprint };
}

// ── Optional-source graceful degradation ─────────────────────────────────

/**
 * Build the empty {@link ImportResult} an import adapter should return when
 * its configured source path is optional and simply not present yet (e.g. a
 * fresh setup before any archive/CSV/identity-map file has been written).
 * Never used for any other failure — file-size, invalid-UTF-8,
 * permission/I/O, and malformed-content failures all remain explicit typed
 * errors/warnings surfaced by the adapter itself.
 *
 * `reason` distinguishes a genuinely missing path (`"not_found"`, the
 * default) from a configured path that resolves to a directory
 * (`"is_directory"`) — used by the audit-archive importer, whose
 * `history.auditArchivePath` config is documented as a directory-or-path
 * and therefore legitimately has no single archive file yet on a fresh
 * setup. The message and fingerprint both reflect which case occurred.
 */
export function emptyImportResult<T>(
  configuredPath: string,
  kind: string,
  reason: "not_found" | "is_directory" = "not_found",
): ImportResult<T> {
  const displayName = path.basename(configuredPath);
  const warning =
    reason === "is_directory"
      ? `Optional import source path is a directory (no archive file present yet) — skipping: ${displayName}`
      : `Optional import source not found — skipping: ${displayName}`;
  return {
    records: [],
    warnings: [warning],
    skippedRows: 0,
    sourceFingerprint: computeFingerprint("", { kind, path: displayName, missing: true, reason }),
  };
}

// ── Deterministic stable JSON stringify ──────────────────────────────────

/**
 * Serialize a value to JSON with object keys sorted recursively, so the
 * same logical payload always produces the same byte-for-byte string
 * (array element order is preserved as-is). Used by import adapters that
 * need deterministic IDs (e.g. an audit event ID) or dedup keys derived
 * from otherwise-unordered JSON input.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? "null";
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortKeysDeep(input[key]);
    }
    return sorted;
  }
  return value;
}

// ── Delimited text (CSV) tokenizer ──────────────────────────────────────

export interface ParsedDelimitedText {
  headers: string[];
  rows: Record<string, string>[];
  /** 0-based indices (relative to data rows, header excluded) whose column count didn't match the header. */
  malformedRowNumbers: number[];
}

/**
 * Tokenize CSV content into rows, handling:
 *  - Quoted fields with embedded commas
 *  - Escaped quotes (doubled "")
 *  - Multiline quoted fields (newlines inside quotes)
 *  - CRLF and LF line endings
 * A truly blank line (no characters at all between newlines — not even an
 * empty quoted field) is skipped rather than treated as data. A row whose
 * field(s) were *explicitly quoted* (e.g. `"","",""`) is always kept as
 * real data, even when every quoted value happens to be empty — that's a
 * deliberate empty-value row, not an accidental blank line, and callers
 * (e.g. `aic-csv-import.ts`'s row-level validation) are responsible for
 * reporting/skipping it as malformed rather than the tokenizer silently
 * discarding it.
 */
function tokenizeCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  // True when any field in the row-in-progress was wrapped in quotes, even
  // if it ended up empty — distinguishes a deliberate empty *value* from an
  // accidental blank *line*.
  let rowHasQuotedField = false;

  const flushRow = () => {
    currentRow.push(currentField);
    currentField = "";
    const isBlankLine = currentRow.length === 1 && currentRow[0].length === 0 && !rowHasQuotedField;
    if (!isBlankLine) {
      rows.push(currentRow);
    }
    currentRow = [];
    rowHasQuotedField = false;
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      rowHasQuotedField = true;
    } else if (ch === ",") {
      currentRow.push(currentField);
      currentField = "";
    } else if (ch === "\r") {
      // skip CR, handle LF next
    } else if (ch === "\n") {
      flushRow();
    } else {
      currentField += ch;
    }
  }

  flushRow();

  return rows;
}

/**
 * Parse delimited (CSV) text into a header list and row objects, tracking
 * which data rows had a mismatched column count (still best-effort mapped
 * via positional index) so callers can surface them as warnings instead of
 * silently accepting misaligned data.
 */
export function parseDelimitedText(content: string): ParsedDelimitedText {
  const rawRows = tokenizeCsv(content);
  if (rawRows.length === 0) {
    return { headers: [], rows: [], malformedRowNumbers: [] };
  }

  const headers = rawRows[0];
  const rows: Record<string, string>[] = [];
  const malformedRowNumbers: number[] = [];

  for (let i = 1; i < rawRows.length; i++) {
    const values = rawRows[i];
    if (values.length !== headers.length) {
      malformedRowNumbers.push(i - 1);
    }
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows, malformedRowNumbers };
}
