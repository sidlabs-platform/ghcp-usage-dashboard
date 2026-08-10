// Audit-log archive import — normalizes a licensing audit-log export
// (JSON array or newline-delimited JSON, e.g. an archived enterprise audit
// log dump) into typed Copilot seat-assignment/revocation events for
// licensing history reconciliation.
//
// The configured path (`getLicensingConfig().history.auditArchivePath`) must
// already be resolved from server configuration — this module never
// accepts a URL/query-derived path itself; see import-shared.ts for the
// file-safety contract (regular file, byte cap, UTF-8) it builds on.
//
// No DB writes happen here — repository persistence is a later
// orchestration concern.

import crypto from "crypto";
import {
  readImportFile,
  computeFingerprint,
  stableStringify,
  emptyImportResult,
  ImportFileError,
  type ImportResult,
} from "./import-shared";

// ── Types ────────────────────────────────────────────────────────────────

export interface NormalizedAuditEvent {
  /** Deterministic ID derived from the event's normalized fields — stable across repeated imports of the same content. */
  eventId: string;
  action: string;
  occurredAt: string; // ISO 8601
  orgLogin: string | null;
  observedLogin: string | null;
  externalIdentity: string | null;
  assignedVia: string | null;
  source: "audit_archive";
  /** Original entry, verbatim, for audit/debugging. */
  raw: unknown;
}

export interface ImportAuditArchiveOptions {
  /** Maximum allowed file size in bytes — forwarded to {@link readImportFile}. */
  maxBytes?: number;
}

/** Thrown when the archive's top-level shape is neither a JSON array, a JSON object with a recognizable entries array, nor NDJSON. */
export class AuditArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditArchiveFormatError";
  }
}

// ── Relevance filtering ───────────────────────────────────────────────────

/**
 * True when an audit action is a Copilot license/seat lifecycle event
 * relevant to reconciliation (assignment/revocation), rather than an
 * unrelated org/repo/team audit action. Deliberately broad (substring
 * match on "copilot" + "seat") since exact GitHub audit action name casing
 * and org/business prefixes vary across enterprise configurations and API
 * versions.
 */
function isRelevantCopilotAction(action: string): boolean {
  const lower = action.toLowerCase();
  return lower.includes("copilot") && lower.includes("seat");
}

// ── Timestamp normalization ───────────────────────────────────────────────

/** Normalize a created_at value (ISO string, epoch ms, or epoch seconds) to ISO 8601, or return null if unparseable/missing. */
function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: values below 1e12 are epoch seconds, at/above are epoch ms.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

// ── String field extraction ───────────────────────────────────────────────

function firstNonEmptyString(entry: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

// ── Per-entry normalization ────────────────────────────────────────────────

type EntryOutcome =
  | { kind: "ok"; record: NormalizedAuditEvent }
  | { kind: "malformed"; warning: string }
  | { kind: "unrelated" };

function normalizeEntry(entry: unknown, index: number): EntryOutcome {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { kind: "malformed", warning: `Entry ${index}: malformed — expected a JSON object, got ${Array.isArray(entry) ? "array" : typeof entry}` };
  }
  const record = entry as Record<string, unknown>;

  const action = typeof record.action === "string" ? record.action.trim() : "";
  if (!action) {
    return { kind: "malformed", warning: `Entry ${index}: malformed — missing required "action" field` };
  }

  if (!isRelevantCopilotAction(action)) {
    return { kind: "unrelated" };
  }

  const occurredAt = normalizeTimestamp(record.created_at ?? record.occurred_at ?? record.timestamp);
  if (!occurredAt) {
    return { kind: "malformed", warning: `Entry ${index}: malformed — missing or unparseable timestamp (checked created_at/occurred_at/timestamp)` };
  }

  const observedLogin = firstNonEmptyString(record, ["user", "user_login", "target_login"]);
  const orgLogin = firstNonEmptyString(record, ["org", "org_login", "organization"]);
  const externalIdentity = firstNonEmptyString(record, ["external_identity", "externalIdentity"]);
  const assignedVia = firstNonEmptyString(record, ["assigned_via", "assignedVia"]);

  const eventId = crypto
    .createHash("sha256")
    .update(stableStringify({ action, occurredAt, orgLogin, observedLogin, externalIdentity }))
    .digest("hex");

  return {
    kind: "ok",
    record: {
      eventId,
      action,
      occurredAt,
      orgLogin,
      observedLogin,
      externalIdentity,
      assignedVia,
      source: "audit_archive",
      raw: entry,
    },
  };
}

// ── Top-level shape detection (JSON array / wrapped object / NDJSON) ────

/**
 * Determine the archive's shape and return its entries as an array of
 * *unparsed* candidates: already-parsed values for JSON-array/object
 * sources, or raw text lines for NDJSON sources (each line is parsed —
 * and malformed lines reported — individually by the caller).
 */
function extractEntries(content: string): { mode: "parsed" | "ndjson-lines"; items: unknown[] } {
  const trimmed = content.trim();
  if (trimmed === "") return { mode: "parsed", items: [] };

  let wholeParsed: unknown;
  let wholeParseOk = true;
  try {
    wholeParsed = JSON.parse(trimmed);
  } catch {
    wholeParseOk = false;
  }

  if (wholeParseOk) {
    if (Array.isArray(wholeParsed)) return { mode: "parsed", items: wholeParsed };
    if (wholeParsed !== null && typeof wholeParsed === "object") {
      const obj = wholeParsed as Record<string, unknown>;
      for (const key of ["entries", "events", "audit_log_entries", "data"]) {
        if (Array.isArray(obj[key])) return { mode: "parsed", items: obj[key] as unknown[] };
      }
      if (typeof obj.action === "string") return { mode: "parsed", items: [obj] };
      throw new AuditArchiveFormatError(
        "Audit archive JSON object did not contain a recognizable entries array (expected one of: entries, events, audit_log_entries, data) or a single event object with an \"action\" field",
      );
    }
    throw new AuditArchiveFormatError(
      "Audit archive content must be a JSON array, a JSON object containing an entries array, or newline-delimited JSON — got a JSON primitive value",
    );
  }

  // Not a single valid JSON document — treat as NDJSON: one JSON value per line.
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
  return { mode: "ndjson-lines", items: lines };
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Import a licensing audit-log archive from a server-config-resolved path.
 * Accepts a JSON array of entries, a JSON object wrapping an entries array,
 * or newline-delimited JSON (one entry per line). Normalizes relevant
 * Copilot seat-assignment/revocation events, silently-but-countably skips
 * unrelated audit actions (reported once as an aggregate warning), and
 * reports malformed entries/lines as warnings + `skippedRows` rather than
 * broadly swallowing them.
 *
 * `history.auditArchivePath` is an *optional* configured source, and its
 * config documentation describes it as a "Directory/path to write archived
 * audit-log exports to" — so on a fresh setup it may legitimately not exist
 * yet, *or* resolve to a directory with no single archive file inside it
 * yet. Both cases degrade to a valid empty {@link ImportResult} carrying a
 * structured warning, rather than throwing. Every other failure (the file
 * exceeds the byte cap, isn't valid UTF-8, a permission/I/O error, or
 * malformed JSON/NDJSON content) remains an explicit, thrown error.
 */
export function importAuditArchive(
  configuredPath: string,
  options: ImportAuditArchiveOptions = {},
): ImportResult<NormalizedAuditEvent> {
  let fileResult;
  try {
    fileResult = readImportFile(configuredPath, { maxBytes: options.maxBytes });
  } catch (err) {
    if (err instanceof ImportFileError && err.reason === "not_found") {
      return emptyImportResult(configuredPath, "audit_archive_import", "not_found");
    }
    if (err instanceof ImportFileError && err.reason === "is_directory") {
      return emptyImportResult(configuredPath, "audit_archive_import", "is_directory");
    }
    throw err;
  }
  const { content, fingerprint } = fileResult;
  const { mode, items } = extractEntries(content);

  const records: NormalizedAuditEvent[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;
  let unrelatedCount = 0;

  items.forEach((item, index) => {
    let candidate: unknown = item;

    if (mode === "ndjson-lines") {
      try {
        candidate = JSON.parse(item as string);
      } catch (err) {
        skippedRows++;
        warnings.push(
          `Line ${index}: malformed — invalid JSON (${err instanceof Error ? err.message : String(err)}), skipping`,
        );
        return;
      }
    }

    const outcome = normalizeEntry(candidate, index);
    if (outcome.kind === "ok") {
      records.push(outcome.record);
    } else if (outcome.kind === "malformed") {
      skippedRows++;
      warnings.push(outcome.warning);
    } else {
      unrelatedCount++;
    }
  });

  if (unrelatedCount > 0) {
    warnings.push(`Skipped ${unrelatedCount} unrelated (non-Copilot-seat) audit action(s)`);
  }

  return {
    records,
    warnings,
    skippedRows,
    sourceFingerprint: computeFingerprint(content, { kind: "audit_archive_import", fingerprint }),
  };
}
