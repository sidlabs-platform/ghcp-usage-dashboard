// AI-Credit consumption CSV import — normalizes a CSV export (billing
// export from GitHub, or a manually curated backfill file) into typed
// consumption records for licensing history reconciliation.
//
// The configured path (`getLicensingConfig().aicConsumption.csvPath`) must
// already be resolved from server configuration — this module never accepts
// a URL/query-derived path itself; see import-shared.ts for the file-safety
// contract (regular file, byte cap, UTF-8) it builds on.
//
// No DB writes happen here — repository persistence is a later
// orchestration concern.

import {
  parseDelimitedText,
  readImportFile,
  computeFingerprint,
  emptyImportResult,
  ImportFileError,
  type ImportResult,
} from "./import-shared";

// ── Types ────────────────────────────────────────────────────────────────

export interface AicCsvConsumptionRecord {
  /** "YYYY-MM" billing period. */
  billingPeriod: string;
  orgLogin: string;
  /** Lowercased login, for consistent joins against seat/identity data. */
  userLogin: string;
  credits: number;
  grossUsd: number;
  netUsd: number | null;
  source: "csv_import";
  /** Original row values, verbatim, for audit/debugging. */
  raw: Record<string, string>;
}

export interface ImportAicConsumptionCsvOptions {
  /** USD-per-credit fallback rate, used only when the row has no explicit USD column. Default: 0.01. */
  creditToUsd?: number;
  /** Maximum allowed file size in bytes — forwarded to {@link readImportFile}. */
  maxBytes?: number;
}

// ── Column alias resolution ──────────────────────────────────────────────

// Priority order matters: the first alias present in a row wins when more
// than one credits-like column is present.
const CREDITS_ALIASES = ["premium_requests", "credits", "credits_consumed", "ai_credits", "quantity"] as const;
const GROSS_USD_ALIASES = ["gross_usd", "gross_amount_usd", "grossAmountUsd", "gross_amount"] as const;
const NET_USD_ALIASES = ["net_usd", "net_amount_usd", "netAmountUsd", "net_amount"] as const;
const PERIOD_ALIASES = ["period", "billing_period", "month"] as const;
const ORG_ALIASES = ["org", "org_login", "organization"] as const;
const USER_ALIASES = ["user", "user_login", "username", "login"] as const;

/** Find the first alias (in priority order) present with a non-empty value in `row`. */
function firstPresentAlias(row: Record<string, string>, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    const value = row[alias];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** Validate a "YYYY-MM" period string, rejecting an out-of-range month. */
function isValidPeriod(value: string): boolean {
  if (!PERIOD_RE.test(value)) return false;
  const month = Number(value.slice(5, 7));
  return month >= 1 && month <= 12;
}

/** Parse a numeric string, tolerating surrounding whitespace and thousands separators; returns undefined if unparseable. */
function parseNumeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/,/g, "");
  if (trimmed === "") return undefined;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : undefined;
}

// ── Row-level normalization ───────────────────────────────────────────────

interface RowOutcome {
  record?: AicCsvConsumptionRecord;
  warning?: string;
}

function normalizeRow(row: Record<string, string>, rowNumber: number, creditToUsd: number): RowOutcome {
  const periodRaw = firstPresentAlias(row, PERIOD_ALIASES);
  if (!periodRaw || !isValidPeriod(periodRaw)) {
    return { warning: `Row ${rowNumber}: missing or malformed period value (expected "YYYY-MM"), skipping` };
  }

  const userRaw = firstPresentAlias(row, USER_ALIASES);
  if (!userRaw) {
    return { warning: `Row ${rowNumber}: missing user/login value, skipping` };
  }

  const creditsRaw = firstPresentAlias(row, CREDITS_ALIASES);
  const credits = parseNumeric(creditsRaw);
  if (credits === undefined) {
    return {
      warning: `Row ${rowNumber}: missing or unparseable credits value (checked ${CREDITS_ALIASES.join(", ")}), skipping`,
    };
  }

  const orgRaw = firstPresentAlias(row, ORG_ALIASES) ?? "";
  const grossUsdRaw = parseNumeric(firstPresentAlias(row, GROSS_USD_ALIASES));
  const netUsdRaw = parseNumeric(firstPresentAlias(row, NET_USD_ALIASES));

  const record: AicCsvConsumptionRecord = {
    billingPeriod: periodRaw,
    orgLogin: orgRaw,
    userLogin: userRaw.toLowerCase(),
    credits,
    grossUsd: grossUsdRaw ?? credits * creditToUsd,
    netUsd: netUsdRaw ?? null,
    source: "csv_import",
    raw: row,
  };

  return { record };
}

// ── Main entry point ──────────────────────────────────────────────────────

const DEFAULT_CREDIT_TO_USD = 0.01;

/**
 * Import an AI-credit consumption CSV from a server-config-resolved path.
 * Accepts flexible column aliases for credits/USD/period/org/user, handles
 * quoted/multiline/comma-containing fields, reports (rather than silently
 * drops) malformed and unparseable rows, and never deduplicates rows —
 * duplicate detection/merging is a later orchestration concern.
 *
 * `aicConsumption.csvPath` is an *optional* configured source (a run may
 * have no CSV backfill at all): when the configured path simply doesn't
 * exist, this degrades to a valid empty {@link ImportResult} carrying a
 * structured warning, rather than throwing — callers can proceed with
 * other consumption sources undisturbed. Every other failure (the file
 * exists but is a directory, exceeds the byte cap, isn't valid UTF-8, or a
 * permission/I/O error) remains an explicit, thrown `ImportFileError` — a
 * *misconfigured* source must still surface loudly.
 */
export function importAicConsumptionCsv(
  configuredPath: string,
  options: ImportAicConsumptionCsvOptions = {},
): ImportResult<AicCsvConsumptionRecord> {
  const creditToUsd = options.creditToUsd ?? DEFAULT_CREDIT_TO_USD;

  let fileResult;
  try {
    fileResult = readImportFile(configuredPath, { maxBytes: options.maxBytes });
  } catch (err) {
    if (err instanceof ImportFileError && err.reason === "not_found") {
      return emptyImportResult(configuredPath, "aic_csv_import");
    }
    throw err;
  }
  const { content, fingerprint } = fileResult;

  const parsed = parseDelimitedText(content);
  const warnings: string[] = [];
  for (const rowIndex of parsed.malformedRowNumbers) {
    warnings.push(
      `Row ${rowIndex}: malformed — column count did not match the header (${parsed.headers.length} columns expected); attempting best-effort import`,
    );
  }

  const records: AicCsvConsumptionRecord[] = [];
  let skippedRows = 0;

  parsed.rows.forEach((row, index) => {
    const outcome = normalizeRow(row, index, creditToUsd);
    if (outcome.record) {
      records.push(outcome.record);
    } else {
      skippedRows++;
      if (outcome.warning) warnings.push(outcome.warning);
    }
  });

  return {
    records,
    warnings,
    skippedRows,
    // Mix in a small tag so this import type's fingerprint can never
    // collide with another import adapter's fingerprint of otherwise
    // byte-identical file content read via the same shared helper.
    sourceFingerprint: computeFingerprint(content, { kind: "aic_csv_import", fingerprint }),
  };
}
