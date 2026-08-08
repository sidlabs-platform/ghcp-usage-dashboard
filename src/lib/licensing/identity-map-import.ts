// Identity map import — normalizes a persisted login/identity resolution
// map (SAML/SCIM external identity → canonical GitHub login) into typed
// records for licensing history reconciliation.
//
// The configured path (`getLicensingConfig().history.identityMapPath`) must
// already be resolved from server configuration — this module never
// accepts a URL/query-derived path itself; see import-shared.ts for the
// file-safety contract (regular file, byte cap, UTF-8) it builds on.
//
// No DB writes happen here — repository persistence is a later
// orchestration concern.

import { readImportFile, computeFingerprint, emptyImportResult, ImportFileError, type ImportResult } from "./import-shared";

// ── Types ────────────────────────────────────────────────────────────────

export interface NormalizedIdentityRecord {
  /** Raw external identity value (SAML NameID, SCIM external ID, legacy login, etc.) — never used as resolvedLogin. */
  externalIdentity: string;
  /** Canonical GitHub login, always lowercased for consistent joins. */
  resolvedLogin: string;
  accountState: string | null;
  source: "identity_map_import";
  /** Original entry, verbatim, for audit/debugging. */
  raw: unknown;
}

export interface ImportIdentityMapOptions {
  /** Maximum allowed file size in bytes — forwarded to {@link readImportFile}. */
  maxBytes?: number;
}

/** Thrown when the identity map's top-level shape is neither a JSON object mapping nor a JSON array/list. */
export class IdentityMapFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityMapFormatError";
  }
}

// ── Field extraction helpers ──────────────────────────────────────────────

function firstNonEmptyString(entry: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

const EXTERNAL_IDENTITY_KEYS = ["externalIdentity", "external_identity", "externalId"];
const RESOLVED_LOGIN_KEYS = ["resolvedLogin", "resolved_login", "login"];
const ACCOUNT_STATE_KEYS = ["accountState", "account_state"];

// ── Per-entry normalization ────────────────────────────────────────────────

type EntryOutcome =
  | { kind: "ok"; record: NormalizedIdentityRecord }
  | { kind: "malformed"; warning: string };

/** Normalize a single list-form entry: `{ externalIdentity, resolvedLogin, ...metadata }` (or its accepted aliases). */
function normalizeListEntry(entry: unknown, index: number): EntryOutcome {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return {
      kind: "malformed",
      warning: `Entry ${index}: malformed — expected a JSON object, got ${Array.isArray(entry) ? "array" : typeof entry}`,
    };
  }
  const rec = entry as Record<string, unknown>;

  const externalIdentity = firstNonEmptyString(rec, EXTERNAL_IDENTITY_KEYS);
  if (!externalIdentity) {
    return { kind: "malformed", warning: `Entry ${index}: malformed — missing required "externalIdentity" field` };
  }

  const resolvedLoginRaw = firstNonEmptyString(rec, RESOLVED_LOGIN_KEYS);
  if (!resolvedLoginRaw) {
    return {
      kind: "malformed",
      warning: `Entry ${index} (externalIdentity="${externalIdentity}"): malformed — missing or blank "resolvedLogin"`,
    };
  }

  const accountState = firstNonEmptyString(rec, ACCOUNT_STATE_KEYS) ?? null;

  return {
    kind: "ok",
    record: {
      externalIdentity,
      resolvedLogin: resolvedLoginRaw.toLowerCase(),
      accountState,
      source: "identity_map_import",
      raw: entry,
    },
  };
}

/** Normalize a single object-mapping entry: `key -> "login"` or `key -> { resolvedLogin, ...metadata }`. */
function normalizeMappingEntry(key: string, value: unknown, index: number): EntryOutcome {
  const externalIdentity = key.trim();
  if (!externalIdentity) {
    return { kind: "malformed", warning: `Entry ${index}: malformed — mapping key (externalIdentity) is blank` };
  }

  if (typeof value === "string") {
    const resolvedLogin = value.trim();
    if (!resolvedLogin) {
      return {
        kind: "malformed",
        warning: `Entry ${index} (externalIdentity="${externalIdentity}"): malformed — missing or blank resolvedLogin`,
      };
    }
    return {
      kind: "ok",
      record: {
        externalIdentity,
        resolvedLogin: resolvedLogin.toLowerCase(),
        accountState: null,
        source: "identity_map_import",
        raw: { [key]: value },
      },
    };
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const resolvedLoginRaw = firstNonEmptyString(obj, RESOLVED_LOGIN_KEYS);
    if (!resolvedLoginRaw) {
      return {
        kind: "malformed",
        warning: `Entry ${index} (externalIdentity="${externalIdentity}"): malformed — missing or blank resolvedLogin`,
      };
    }
    const accountState = firstNonEmptyString(obj, ACCOUNT_STATE_KEYS) ?? null;
    return {
      kind: "ok",
      record: {
        externalIdentity,
        resolvedLogin: resolvedLoginRaw.toLowerCase(),
        accountState,
        source: "identity_map_import",
        raw: { [key]: value },
      },
    };
  }

  return {
    kind: "malformed",
    warning: `Entry ${index} (externalIdentity="${externalIdentity}"): malformed — mapping value must be a string login or an object with resolvedLogin`,
  };
}

// ── Collision detection ────────────────────────────────────────────────────

/**
 * Detect external identities that map to more than one distinct (already
 * lowercased) resolved login — a genuine conflict, since the same external
 * identity should resolve to exactly one canonical login. Two entries for
 * the same external identity that resolve to the *same* login differing
 * only by case are NOT a conflict (both normalize to one login already).
 */
function detectConflicts(records: NormalizedIdentityRecord[]): string[] {
  const byExternalIdentity = new Map<string, Set<string>>();
  for (const record of records) {
    const set = byExternalIdentity.get(record.externalIdentity) ?? new Set<string>();
    set.add(record.resolvedLogin);
    byExternalIdentity.set(record.externalIdentity, set);
  }

  const warnings: string[] = [];
  for (const [externalIdentity, logins] of byExternalIdentity) {
    if (logins.size > 1) {
      warnings.push(
        `Conflicting identity mapping for external identity "${externalIdentity}": maps to ${logins.size} different resolved logins (${[...logins].join(", ")})`,
      );
    }
  }
  return warnings;
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Import an identity resolution map from a server-config-resolved path.
 * Accepts either:
 *  - An object mapping form: `{ [externalIdentity]: "login" | { resolvedLogin, ... } }`
 *  - A list form: `[{ externalIdentity, resolvedLogin, ... }, ...]` (aliases accepted)
 *
 * Login/resolvedLogin values are always lowercased for consistent joins.
 * `externalIdentity` is never used as a fallback `resolvedLogin` — an entry
 * with a missing/blank resolved login is reported as malformed and skipped
 * rather than silently resolving to the external identity value. Detects
 * and warns about external identities that map to conflicting resolved
 * logins (case-insensitively).
 *
 * `history.identityMapPath` is an *optional* configured source: when the
 * configured path simply doesn't exist, this degrades to a valid empty
 * {@link ImportResult} carrying a structured warning, rather than throwing.
 * Every other failure (the path is a directory, exceeds the byte cap, isn't
 * valid UTF-8, a permission/I/O error, or malformed JSON content) remains an
 * explicit, thrown error — the identity map config is documented as a
 * single file, so a directory there is a genuine misconfiguration, not an
 * "optional source not yet present" case.
 */
export function importIdentityMap(
  configuredPath: string,
  options: ImportIdentityMapOptions = {},
): ImportResult<NormalizedIdentityRecord> {
  let fileResult;
  try {
    fileResult = readImportFile(configuredPath, { maxBytes: options.maxBytes });
  } catch (err) {
    if (err instanceof ImportFileError && err.reason === "not_found") {
      return emptyImportResult(configuredPath, "identity_map_import");
    }
    throw err;
  }
  const { content, fingerprint } = fileResult;
  const trimmed = content.trim();

  let parsed: unknown = {};
  if (trimmed !== "") {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new IdentityMapFormatError(
        `Identity map content is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const records: NormalizedIdentityRecord[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  const applyOutcome = (outcome: EntryOutcome) => {
    if (outcome.kind === "ok") {
      records.push(outcome.record);
    } else {
      skippedRows++;
      warnings.push(outcome.warning);
    }
  };

  if (Array.isArray(parsed)) {
    parsed.forEach((entry, index) => applyOutcome(normalizeListEntry(entry, index)));
  } else if (parsed !== null && typeof parsed === "object") {
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value], index) =>
      applyOutcome(normalizeMappingEntry(key, value, index)),
    );
  } else {
    throw new IdentityMapFormatError(
      "Identity map content must be a JSON object mapping (externalIdentity -> login) or a JSON array of entries — got a JSON primitive value",
    );
  }

  warnings.push(...detectConflicts(records));

  return {
    records,
    warnings,
    skippedRows,
    sourceFingerprint: computeFingerprint(content, { kind: "identity_map_import", fingerprint }),
  };
}
