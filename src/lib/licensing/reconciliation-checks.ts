// Reconciliation checks (Task 8) — pure, deterministic validation of a
// materialized licensing period against independent comparators.
//
// Every check function here is pure and side-effect free: no DB access, no
// network calls. Inputs are plain typed data the caller assembles from
// Task 7's materialized rows (`materialize-license-period.ts`), Task 6's
// seat-ledger coverage / identity-resolution outcomes (`seat-ledger.ts`,
// `identity-resolver.ts`), synced source summaries, and optional
// authoritative totals (e.g. `license_org_billing_snapshots`). Callers
// (a future sync orchestrator) are responsible for gathering that data and
// persisting the results via `license-run-repo.ts`'s `replaceLicenseChecks`
// — these functions never write anything themselves.
//
// Privacy: outputs must never surface an external identity, email, SAML
// NameID, SCIM external id/username, token, or raw payload. Only a stable
// `holderKey` and (when already present upstream) a numeric GitHub user id
// may appear in details. See each check's doc comment for how it upholds
// this.

import { UNATTRIBUTED_ORG, type SeatLedgerCoverage, type SeatLedgerConfidence } from "./seat-ledger";
import type { MaterializedLicensePeriodRow } from "./materialize-license-period";

// ── Shared types ──────────────────────────────────────────────────────────

/** Every reconciliation check this module implements, in no particular order. */
export type ReconciliationCheckName =
  | "seat_count"
  | "real_login_coverage"
  | "external_identity_leak"
  | "status_agreement"
  | "aic_gross_vs_net"
  | "consumption_attribution"
  | "history_coverage";

export type ReconciliationCheckStatus = "pass" | "warning" | "fail";

/** Overall reconciliation run status derived from a full set of check results (see {@link deriveOverallRunStatus}). Assignable to `license-run-repo.ts`'s `LicenseRunStatus` (a superset that also has `"running"`). */
export type ReconciliationRunStatus = "success" | "warning" | "failed";

/**
 * One deterministic, typed check result. `details` must only ever contain
 * JSON-safe values (numbers, strings, booleans, arrays, plain objects) —
 * safe to pass straight through `license-run-repo.ts`'s `stableStringify`
 * into the `license_reconciliation_checks.details` column.
 */
export interface ReconciliationCheckResult {
  name: ReconciliationCheckName;
  status: ReconciliationCheckStatus;
  /** Concise, deterministic, human-readable summary. Never includes a raw external identity/email/token value. */
  message: string;
  /** "YYYY-MM" billing period this result is scoped to. */
  billingPeriod: string;
  /** Org login this result is scoped to, or `""` for an enterprise-wide result (mirrors `license_reconciliation_checks.org_login`'s default). */
  orgLogin: string;
  expectedValue: number | null;
  actualValue: number | null;
  /** Count of holders/rows this result flagged as affected/mismatched/unresolved, when applicable. */
  affectedCount: number;
  details: Record<string, unknown>;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Canonical (billingPeriod, orgLogin) grouping key. NUL-separated so no real value can collide across the join. */
function groupKey(billingPeriod: string, orgLogin: string): string {
  return `${billingPeriod}\u0000${orgLogin}`;
}

function makeResult(
  name: ReconciliationCheckName,
  status: ReconciliationCheckStatus,
  billingPeriod: string,
  orgLogin: string,
  message: string,
  details: Record<string, unknown>,
  expectedValue: number | null = null,
  actualValue: number | null = null,
  affectedCount = 0
): ReconciliationCheckResult {
  return { name, status, message, billingPeriod, orgLogin, expectedValue, actualValue, affectedCount, details };
}

/** Stable sort: by check name, then billing period, then org login — mirrors `license-run-repo.ts`'s `listLicenseChecks` ORDER BY, so persisted order matches computed order. */
function sortResults(results: ReconciliationCheckResult[]): ReconciliationCheckResult[] {
  return [...results].sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      a.billingPeriod.localeCompare(b.billingPeriod) ||
      a.orgLogin.localeCompare(b.orgLogin)
  );
}

// ── seat_count ──────────────────────────────────────────────────────────

/** An authoritative seat total for one (billingPeriod, orgLogin), e.g. from `license_org_billing_snapshots`. */
export interface AuthoritativeSeatCount {
  billingPeriod: string;
  orgLogin: string;
  totalSeats: number;
}

export interface SeatCountCheckInput {
  materializedRows: MaterializedLicensePeriodRow[];
  /** Authoritative comparator per (billingPeriod, orgLogin). Omit an entry (or the whole array) when no authoritative source is available for that group — never treated as a mismatch. */
  authoritativeSeatCounts?: AuthoritativeSeatCount[];
  /** Absolute seat-count difference still considered a "defensible small variance". Default 1. */
  varianceToleranceSeats?: number;
  /** Percentage difference (of the authoritative count) still considered a defensible variance. Default 2. Either tolerance passing is enough to downgrade a mismatch to a warning instead of a fail. */
  variancePctTolerance?: number;
}

const DEFAULT_SEAT_COUNT_ABS_TOLERANCE = 1;
const DEFAULT_SEAT_COUNT_PCT_TOLERANCE = 2;

/**
 * Compare the materialized active-seat count to an authoritative
 * snapshot/org-billing count, per (billingPeriod, orgLogin). Exact match
 * passes; a small variance (within the absolute-or-percentage tolerance)
 * warns; a substantive mismatch fails. A missing authoritative comparator
 * for a group always warns — it is never treated as pass, fail, or an
 * error condition.
 */
export function checkSeatCount(input: SeatCountCheckInput): ReconciliationCheckResult[] {
  const absTolerance = input.varianceToleranceSeats ?? DEFAULT_SEAT_COUNT_ABS_TOLERANCE;
  const pctTolerance = input.variancePctTolerance ?? DEFAULT_SEAT_COUNT_PCT_TOLERANCE;

  const activeCounts = new Map<string, number>();
  const groupMeta = new Map<string, { billingPeriod: string; orgLogin: string }>();

  for (const row of input.materializedRows) {
    const key = groupKey(row.billingPeriod, row.orgLogin);
    if (!groupMeta.has(key)) groupMeta.set(key, { billingPeriod: row.billingPeriod, orgLogin: row.orgLogin });
    if (row.seatStatus !== "active") continue;
    activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
  }

  const authoritativeMap = new Map<string, number>();
  for (const auth of input.authoritativeSeatCounts ?? []) {
    const key = groupKey(auth.billingPeriod, auth.orgLogin);
    authoritativeMap.set(key, auth.totalSeats);
    if (!groupMeta.has(key)) groupMeta.set(key, { billingPeriod: auth.billingPeriod, orgLogin: auth.orgLogin });
  }

  const results: ReconciliationCheckResult[] = [];
  for (const [key, meta] of groupMeta) {
    const materialized = activeCounts.get(key) ?? 0;
    const authoritative = authoritativeMap.get(key);

    if (authoritative === undefined) {
      results.push(
        makeResult(
          "seat_count",
          "warning",
          meta.billingPeriod,
          meta.orgLogin,
          `No authoritative seat count is available to compare against for org "${meta.orgLogin}" in ${meta.billingPeriod}; materialized active seat count is ${materialized}.`,
          { materializedActiveSeatCount: materialized },
          null,
          materialized
        )
      );
      continue;
    }

    const diff = materialized - authoritative;
    const diffAbs = Math.abs(diff);
    const diffPct = authoritative === 0 ? (diffAbs === 0 ? 0 : 100) : round2((diffAbs / authoritative) * 100);

    let status: ReconciliationCheckStatus;
    let message: string;
    if (diffAbs === 0) {
      status = "pass";
      message = `Materialized active seat count (${materialized}) matches the authoritative count exactly for org "${meta.orgLogin}" in ${meta.billingPeriod}.`;
    } else if (diffAbs <= absTolerance || diffPct <= pctTolerance) {
      status = "warning";
      message = `Materialized active seat count (${materialized}) differs from the authoritative count (${authoritative}) by ${diff} for org "${meta.orgLogin}" in ${meta.billingPeriod}, within the defensible variance tolerance.`;
    } else {
      status = "fail";
      message = `Materialized active seat count (${materialized}) differs from the authoritative count (${authoritative}) by ${diff} for org "${meta.orgLogin}" in ${meta.billingPeriod}, exceeding the variance tolerance.`;
    }

    results.push(
      makeResult(
        "seat_count",
        status,
        meta.billingPeriod,
        meta.orgLogin,
        message,
        { materializedActiveSeatCount: materialized, authoritativeSeatCount: authoritative, diff, diffPct },
        authoritative,
        materialized
      )
    );
  }

  return sortResults(results);
}

// ── real_login_coverage ───────────────────────────────────────────────────

export interface RealLoginCoverageCheckInput {
  materializedRows: MaterializedLicensePeriodRow[];
}

/** A holder resolves to a "real login" when identity resolution reached a verified/observed tier (i.e. not `"unresolved"`) and produced a non-null `resolvedUserLogin`. */
function hasRealLogin(row: Pick<MaterializedLicensePeriodRow, "identityResolutionSource" | "resolvedUserLogin">): boolean {
  return row.identityResolutionSource !== "unresolved" && row.resolvedUserLogin != null;
}

/** Full coverage requires 100% resolution. Below that, coverage is only "partial" (warning) down to this percentage; below it, coverage is "severely low" (fail). Documented, deterministic thresholds — see check semantics doc. */
const REAL_LOGIN_COVERAGE_FAIL_THRESHOLD_PCT = 90;

/**
 * Report the resolved real-login percentage and unresolved holder count per
 * (billingPeriod, orgLogin). Full (100%) coverage passes; partial coverage
 * (\>= {@link REAL_LOGIN_COVERAGE_FAIL_THRESHOLD_PCT}%, \< 100%) warns;
 * severely low coverage (\< {@link REAL_LOGIN_COVERAGE_FAIL_THRESHOLD_PCT}%)
 * fails. A group with zero holders trivially passes. Details use only
 * `holderKey` values — never external identities/emails/SAML/SCIM values.
 */
export function checkRealLoginCoverage(input: RealLoginCoverageCheckInput): ReconciliationCheckResult[] {
  const groups = new Map<string, { billingPeriod: string; orgLogin: string; rows: MaterializedLicensePeriodRow[] }>();
  for (const row of input.materializedRows) {
    const key = groupKey(row.billingPeriod, row.orgLogin);
    let group = groups.get(key);
    if (!group) {
      group = { billingPeriod: row.billingPeriod, orgLogin: row.orgLogin, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const results: ReconciliationCheckResult[] = [];
  for (const { billingPeriod, orgLogin, rows } of groups.values()) {
    const total = rows.length;
    const unresolvedHolderKeys = rows.filter((r) => !hasRealLogin(r)).map((r) => r.holderKey).sort();
    const resolved = total - unresolvedHolderKeys.length;
    const pct = total === 0 ? 100 : round2((resolved / total) * 100);

    let status: ReconciliationCheckStatus;
    let message: string;
    if (total === 0) {
      status = "pass";
      message = `No holders to resolve for org "${orgLogin}" in ${billingPeriod}.`;
    } else if (pct >= 100) {
      status = "pass";
      message = `All ${total} holder(s) resolved to a real GitHub login for org "${orgLogin}" in ${billingPeriod}.`;
    } else if (pct >= REAL_LOGIN_COVERAGE_FAIL_THRESHOLD_PCT) {
      status = "warning";
      message = `${resolved} of ${total} holder(s) (${pct}%) resolved to a real GitHub login for org "${orgLogin}" in ${billingPeriod}; partial coverage.`;
    } else {
      status = "fail";
      message = `Only ${resolved} of ${total} holder(s) (${pct}%) resolved to a real GitHub login for org "${orgLogin}" in ${billingPeriod}; severely low coverage.`;
    }

    results.push(
      makeResult(
        "real_login_coverage",
        status,
        billingPeriod,
        orgLogin,
        message,
        { totalHolders: total, resolvedHolders: resolved, unresolvedCount: unresolvedHolderKeys.length, unresolvedHolderKeys },
        100,
        pct,
        unresolvedHolderKeys.length
      )
    );
  }

  return sortResults(results);
}

// ── external_identity_leak ────────────────────────────────────────────────

const EMAIL_SHAPE_RE = /@/;
const GUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Dashless GUIDs / opaque hash-like blobs. Kept in sync with `identity-resolver.ts`'s internal `HEX_BLOB_RE` by design (see that file's doc comment); covered by parity expectations in this module's tests. */
const HEX_BLOB_SHAPE_RE = /^[0-9a-f]{32,}$/i;
const UNDERSCORE_SHAPE_RE = /_/;

/**
 * Identity-resolution tiers that accept an evidence source's `resolvedLogin`
 * field verbatim without validating it looks like a real GitHub login (see
 * `identity-resolver.ts` tiers 3-5). Only rows resolved through one of these
 * tiers are shape-checked here — tiers `"seat"`/`"audit"` already validate
 * login shape upstream (`looksLikeRealGitHubLogin`), so re-checking them
 * would only produce false positives, and `"unresolved"` never sets
 * `resolvedUserLogin` at all.
 */
const UNVALIDATED_MAPPING_SOURCES = new Set(["enterprise_identity", "org_identity", "identity_map"]);

function looksLikeOpaqueExternalIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return (
    EMAIL_SHAPE_RE.test(trimmed) ||
    GUID_SHAPE_RE.test(trimmed) ||
    HEX_BLOB_SHAPE_RE.test(trimmed) ||
    UNDERSCORE_SHAPE_RE.test(trimmed)
  );
}

export interface ExternalIdentityLeakCheckInput {
  materializedRows: MaterializedLicensePeriodRow[];
  /**
   * Known raw external identity values (e.g. from `license_identity_records`)
   * to compare resolved logins against. Compared case-insensitively;
   * NEVER echoed back in a result's message/details, only used to decide
   * pass/fail.
   */
  knownExternalIdentities?: string[];
}

/**
 * Fail when a holder's `resolvedUserLogin` equals a known external identity
 * value, or was resolved through an {@link UNVALIDATED_MAPPING_SOURCES} tier
 * and looks like an opaque external identifier (email/GUID/hex blob/
 * underscore-bearing value) rather than a verified GitHub login — a strong
 * signal that unverified external-identity data leaked into a login field.
 * Passes otherwise. Conservative by design: seat/audit-resolved logins are
 * never re-checked (already shape-validated upstream), so a real GitHub
 * login can never be flagged as a false positive. Never echoes the
 * suspected value — only the affected `holderKey`(s).
 */
export function checkExternalIdentityLeak(input: ExternalIdentityLeakCheckInput): ReconciliationCheckResult[] {
  const knownSet = new Set(
    (input.knownExternalIdentities ?? []).map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  );

  const groups = new Map<string, { billingPeriod: string; orgLogin: string; rows: MaterializedLicensePeriodRow[] }>();
  for (const row of input.materializedRows) {
    const key = groupKey(row.billingPeriod, row.orgLogin);
    let group = groups.get(key);
    if (!group) {
      group = { billingPeriod: row.billingPeriod, orgLogin: row.orgLogin, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const results: ReconciliationCheckResult[] = [];
  for (const { billingPeriod, orgLogin, rows } of groups.values()) {
    const leakedHolderKeys: string[] = [];
    for (const row of rows) {
      const candidate = row.resolvedUserLogin;
      if (!candidate) continue;
      const normalized = candidate.trim().toLowerCase();

      const matchesKnown = knownSet.has(normalized);
      const looksOpaqueViaUnverifiedTier =
        UNVALIDATED_MAPPING_SOURCES.has(row.identityResolutionSource) && looksLikeOpaqueExternalIdentifier(candidate);

      if (matchesKnown || looksOpaqueViaUnverifiedTier) {
        leakedHolderKeys.push(row.holderKey);
      }
    }
    leakedHolderKeys.sort();

    const status: ReconciliationCheckStatus = leakedHolderKeys.length === 0 ? "pass" : "fail";
    const message =
      leakedHolderKeys.length === 0
        ? `No external identity leakage detected among resolved logins for org "${orgLogin}" in ${billingPeriod}.`
        : `${leakedHolderKeys.length} resolved login(s) appear to be raw external identifiers rather than verified GitHub logins for org "${orgLogin}" in ${billingPeriod}.`;

    results.push(
      makeResult(
        "external_identity_leak",
        status,
        billingPeriod,
        orgLogin,
        message,
        { affectedHolderKeys: leakedHolderKeys },
        0,
        leakedHolderKeys.length,
        leakedHolderKeys.length
      )
    );
  }

  return sortResults(results);
}

// ── status_agreement ──────────────────────────────────────────────────────

export interface AuthoritativeStatus {
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  status: "active" | "inactive";
}

export interface StatusAgreementCheckInput {
  materializedRows: MaterializedLicensePeriodRow[];
  /** Independent per-holder status evidence (e.g. a live seat re-check). Omit a (billingPeriod, orgLogin) group entirely when no independent source exists for it. */
  authoritativeStatuses?: AuthoritativeStatus[];
}

const STATUS_AGREEMENT_FAIL_RATE_PCT = 5;

function normalizeMaterializedSeatStatus(seatStatus: string): "active" | "inactive" {
  return seatStatus === "active" ? "active" : "inactive";
}

/**
 * Compare materialized active/inactive status with an independent status
 * source, per (billingPeriod, orgLogin). No mismatches passes; a mismatch
 * rate at or below {@link STATUS_AGREEMENT_FAIL_RATE_PCT}% warns; above it
 * fails. A missing comparator (no independent status entries for a group,
 * or none overlapping the same holders) always warns.
 */
export function checkStatusAgreement(input: StatusAgreementCheckInput): ReconciliationCheckResult[] {
  const rowGroups = new Map<string, { billingPeriod: string; orgLogin: string; rows: MaterializedLicensePeriodRow[] }>();
  for (const row of input.materializedRows) {
    const key = groupKey(row.billingPeriod, row.orgLogin);
    let group = rowGroups.get(key);
    if (!group) {
      group = { billingPeriod: row.billingPeriod, orgLogin: row.orgLogin, rows: [] };
      rowGroups.set(key, group);
    }
    group.rows.push(row);
  }

  const authGroups = new Map<string, Map<string, "active" | "inactive">>();
  for (const auth of input.authoritativeStatuses ?? []) {
    const key = groupKey(auth.billingPeriod, auth.orgLogin);
    let byHolder = authGroups.get(key);
    if (!byHolder) {
      byHolder = new Map();
      authGroups.set(key, byHolder);
    }
    byHolder.set(auth.holderKey, auth.status);
    if (!rowGroups.has(key)) {
      rowGroups.set(key, { billingPeriod: auth.billingPeriod, orgLogin: auth.orgLogin, rows: [] });
    }
  }

  const results: ReconciliationCheckResult[] = [];
  for (const [key, { billingPeriod, orgLogin, rows }] of rowGroups) {
    const authByHolder = authGroups.get(key);
    if (!authByHolder || authByHolder.size === 0) {
      results.push(
        makeResult(
          "status_agreement",
          "warning",
          billingPeriod,
          orgLogin,
          `No independent status source is available to compare against for org "${orgLogin}" in ${billingPeriod}.`,
          {}
        )
      );
      continue;
    }

    let compared = 0;
    const mismatchedHolderKeys: string[] = [];
    for (const row of rows) {
      const authStatus = authByHolder.get(row.holderKey);
      if (authStatus === undefined) continue;
      compared += 1;
      if (normalizeMaterializedSeatStatus(row.seatStatus) !== authStatus) {
        mismatchedHolderKeys.push(row.holderKey);
      }
    }
    mismatchedHolderKeys.sort();

    if (compared === 0) {
      results.push(
        makeResult(
          "status_agreement",
          "warning",
          billingPeriod,
          orgLogin,
          `Independent status source for org "${orgLogin}" in ${billingPeriod} has no holders overlapping the materialized rows.`,
          {}
        )
      );
      continue;
    }

    const mismatchRatePct = round2((mismatchedHolderKeys.length / compared) * 100);
    let status: ReconciliationCheckStatus;
    let message: string;
    if (mismatchedHolderKeys.length === 0) {
      status = "pass";
      message = `Materialized status agrees with the independent source for all ${compared} compared holder(s) in org "${orgLogin}" for ${billingPeriod}.`;
    } else if (mismatchRatePct <= STATUS_AGREEMENT_FAIL_RATE_PCT) {
      status = "warning";
      message = `${mismatchedHolderKeys.length} of ${compared} compared holder(s) (${mismatchRatePct}%) disagree with the independent status source in org "${orgLogin}" for ${billingPeriod}.`;
    } else {
      status = "fail";
      message = `${mismatchedHolderKeys.length} of ${compared} compared holder(s) (${mismatchRatePct}%) disagree with the independent status source in org "${orgLogin}" for ${billingPeriod}, exceeding the acceptable mismatch rate.`;
    }

    results.push(
      makeResult(
        "status_agreement",
        status,
        billingPeriod,
        orgLogin,
        message,
        { comparedCount: compared, mismatchedCount: mismatchedHolderKeys.length, mismatchRatePct, mismatchedHolderKeys },
        0,
        mismatchRatePct,
        mismatchedHolderKeys.length
      )
    );
  }

  return sortResults(results);
}

// ── aic_gross_vs_net ───────────────────────────────────────────────────────

export interface GrossVsNetComparison {
  billingPeriod: string;
  /** Org login, or `""` for an enterprise-wide comparison. */
  orgLogin?: string;
  grossUsd: number;
  /** Net/report total to compare against. `null`/`undefined` means no independent net comparator was available. */
  netUsd?: number | null;
}

export interface AicGrossVsNetCheckInput {
  comparisons: GrossVsNetComparison[];
  /** Acceptable variance (percent, 0-100). Default is the config-resolved `validation.aicTolerancePct` (project default 5); pass an explicit override to use a different tolerance for this run. */
  tolerancePct?: number;
}

const DEFAULT_AIC_TOLERANCE_PCT = 5;
/** A variance up to this multiple of the tolerance still only warns; beyond it, fails. */
const AIC_TOLERANCE_FAIL_MULTIPLIER = 2;

/**
 * Compare gross source totals to net/report totals per (billingPeriod,
 * orgLogin), without divide-by-zero/NaN: when both are zero the comparison
 * trivially passes; otherwise the percentage variance is computed against
 * the larger of |net| and |gross| (never a bare zero denominator). Within
 * tolerance passes; up to {@link AIC_TOLERANCE_FAIL_MULTIPLIER}× tolerance
 * warns; beyond that fails. A missing net comparator always warns.
 *
 * @throws {Error} when `tolerancePct` is provided but is not a finite,
 * non-negative number — an invalid override must surface immediately
 * rather than silently falling back to the default.
 */
export function checkAicGrossVsNet(input: AicGrossVsNetCheckInput): ReconciliationCheckResult[] {
  if (input.tolerancePct !== undefined && (!Number.isFinite(input.tolerancePct) || input.tolerancePct < 0)) {
    throw new Error(`checkAicGrossVsNet: tolerancePct override must be a finite number >= 0, got ${JSON.stringify(input.tolerancePct)}`);
  }
  const tolerancePct = input.tolerancePct ?? DEFAULT_AIC_TOLERANCE_PCT;

  const results: ReconciliationCheckResult[] = [];
  for (const comparison of input.comparisons) {
    const billingPeriod = comparison.billingPeriod;
    const orgLogin = comparison.orgLogin ?? "";
    const gross = comparison.grossUsd;

    if (comparison.netUsd === null || comparison.netUsd === undefined) {
      results.push(
        makeResult(
          "aic_gross_vs_net",
          "warning",
          billingPeriod,
          orgLogin,
          `No net/report comparator is available to compare against gross consumption ($${gross}) for org "${orgLogin || "(enterprise)"}" in ${billingPeriod}.`,
          { grossUsd: gross, toleranceUsedPct: tolerancePct }
        )
      );
      continue;
    }

    const net = comparison.netUsd;
    const diff = gross - net;
    const diffAbs = Math.abs(diff);
    const denom = Math.max(Math.abs(net), Math.abs(gross));
    const diffPct = denom === 0 ? 0 : round2((diffAbs / denom) * 100);

    let status: ReconciliationCheckStatus;
    let message: string;
    if (diffPct <= tolerancePct) {
      status = "pass";
      message = `Gross ($${gross}) vs net ($${net}) AI-Credit consumption is within the ${tolerancePct}% tolerance (${diffPct}%) for org "${orgLogin || "(enterprise)"}" in ${billingPeriod}.`;
    } else if (diffPct <= tolerancePct * AIC_TOLERANCE_FAIL_MULTIPLIER) {
      status = "warning";
      message = `Gross ($${gross}) vs net ($${net}) AI-Credit consumption variance (${diffPct}%) exceeds the ${tolerancePct}% tolerance but is a modest variance for org "${orgLogin || "(enterprise)"}" in ${billingPeriod}.`;
    } else {
      status = "fail";
      message = `Gross ($${gross}) vs net ($${net}) AI-Credit consumption variance (${diffPct}%) is a major variance exceeding the ${tolerancePct}% tolerance for org "${orgLogin || "(enterprise)"}" in ${billingPeriod}.`;
    }

    results.push(
      makeResult(
        "aic_gross_vs_net",
        status,
        billingPeriod,
        orgLogin,
        message,
        { grossUsd: gross, netUsd: net, diffPct, toleranceUsedPct: tolerancePct },
        net,
        gross
      )
    );
  }

  return sortResults(results);
}

// ── consumption_attribution ───────────────────────────────────────────────

export interface ConsumptionAttributionRecord {
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  credits: number;
  grossUsd: number;
}

export interface ConsumptionAttributionCheckInput {
  records: ConsumptionAttributionRecord[];
}

/**
 * Validate that AI-Credit consumption is canonically attributed to a single
 * (org, holder) per period: an enterprise-only record must appear as
 * exactly one {@link UNATTRIBUTED_ORG} row per holder. Fails when the same
 * (org, holder) canonical key appears more than once (an impossible/
 * duplicate attribution), or when two or more *distinct* attributed orgs
 * report byte-for-byte identical non-zero credits/USD for the same holder
 * in the same period (a strong signal of consumption copied verbatim
 * across orgs rather than independently observed) — legitimate
 * org-attributed consumption for the same holder in multiple orgs is never
 * flagged merely for existing, only for being suspiciously identical.
 * Warns when a holder has only an unattributed record and no attributed
 * org record — a valid but incomplete attribution.
 */
export function checkConsumptionAttribution(input: ConsumptionAttributionCheckInput): ReconciliationCheckResult[] {
  const periods = new Map<string, ConsumptionAttributionRecord[]>();
  for (const record of input.records) {
    const list = periods.get(record.billingPeriod) ?? [];
    list.push(record);
    periods.set(record.billingPeriod, list);
  }

  const results: ReconciliationCheckResult[] = [];
  for (const [billingPeriod, records] of periods) {
    const keyCounts = new Map<string, number>();
    for (const record of records) {
      const key = `${record.orgLogin}\u0000${record.holderKey}`;
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    const duplicateKeyHolders = new Set<string>();
    for (const [key, count] of keyCounts) {
      if (count > 1) duplicateKeyHolders.add(key.split("\u0000")[1]);
    }

    const byHolder = new Map<string, ConsumptionAttributionRecord[]>();
    for (const record of records) {
      const list = byHolder.get(record.holderKey) ?? [];
      list.push(record);
      byHolder.set(record.holderKey, list);
    }

    const crossOrgDuplicateHolders = new Set<string>();
    const unattributedOnlyHolders = new Set<string>();
    for (const [holderKey, holderRecords] of byHolder) {
      const attributed = holderRecords.filter((r) => r.orgLogin !== UNATTRIBUTED_ORG);
      const unattributed = holderRecords.filter((r) => r.orgLogin === UNATTRIBUTED_ORG);

      if (attributed.length === 0 && unattributed.length > 0) {
        unattributedOnlyHolders.add(holderKey);
      }

      for (let i = 0; i < attributed.length; i++) {
        for (let j = i + 1; j < attributed.length; j++) {
          const a = attributed[i];
          const b = attributed[j];
          if (a.orgLogin === b.orgLogin) continue;
          const bothNonZero = a.credits !== 0 && a.grossUsd !== 0;
          if (bothNonZero && a.credits === b.credits && a.grossUsd === b.grossUsd) {
            crossOrgDuplicateHolders.add(holderKey);
          }
        }
      }
    }

    const affectedHolderKeys = [...new Set([...duplicateKeyHolders, ...crossOrgDuplicateHolders, ...unattributedOnlyHolders])].sort();

    let status: ReconciliationCheckStatus;
    let message: string;
    if (duplicateKeyHolders.size > 0 || crossOrgDuplicateHolders.size > 0) {
      status = "fail";
      message = `Consumption attribution errors detected in ${billingPeriod}: ${duplicateKeyHolders.size} duplicate canonical-key record(s), ${crossOrgDuplicateHolders.size} cross-org duplicated-value holder(s).`;
    } else if (unattributedOnlyHolders.size > 0) {
      status = "warning";
      message = `${unattributedOnlyHolders.size} holder(s) have only enterprise-level (unattributed) consumption with no org-attributed record in ${billingPeriod}.`;
    } else {
      status = "pass";
      message = `AI-Credit consumption is canonically attributed per (org, holder) in ${billingPeriod}.`;
    }

    results.push(
      makeResult(
        "consumption_attribution",
        status,
        billingPeriod,
        "",
        message,
        {
          duplicateCanonicalKeyCount: duplicateKeyHolders.size,
          crossOrgDuplicateCount: crossOrgDuplicateHolders.size,
          unattributedOnlyCount: unattributedOnlyHolders.size,
          affectedHolderKeys,
        },
        0,
        affectedHolderKeys.length,
        affectedHolderKeys.length
      )
    );
  }

  return sortResults(results);
}

// ── history_coverage ───────────────────────────────────────────────────────

export interface HistoryCoverageCheckInput {
  coverage: SeatLedgerCoverage[];
  /** Explicit (billingPeriod, orgLogin) groups expected to have coverage data. A group with no matching `coverage` entry surfaces as a "missing historical source" warning rather than being silently omitted. */
  expectedGroups?: { billingPeriod: string; orgLogin: string }[];
}

function classifyCoverageConfidence(confidence: SeatLedgerConfidence): ReconciliationCheckStatus {
  switch (confidence) {
    case "exact_snapshot":
    case "audit_reconstructed":
      return "pass";
    case "live_snapshot_only":
      return "warning";
    case "unrecoverable":
      return "fail";
  }
}

/**
 * Summarize Task 6 seat-ledger coverage (confidence + counts) per
 * (billingPeriod, orgLogin). Exact-snapshot or fully audit-reconstructed
 * coverage (no unrecoverable gaps) passes; `live_snapshot_only` (or any
 * other limited-gap coverage) warns; material `unrecoverable` coverage
 * fails. A group with no coverage data at all (missing historical source)
 * warns with a valid, safe summary rather than being silently dropped.
 */
export function checkHistoryCoverage(input: HistoryCoverageCheckInput): ReconciliationCheckResult[] {
  const results: ReconciliationCheckResult[] = [];
  const seen = new Set<string>();

  for (const coverage of input.coverage) {
    const key = groupKey(coverage.billingPeriod, coverage.orgLogin);
    seen.add(key);
    const status = classifyCoverageConfidence(coverage.confidence);
    const totalObservations = Object.values(coverage.counts).reduce((sum, n) => sum + n, 0);

    const message =
      status === "pass"
        ? `Seat-ledger coverage for org "${coverage.orgLogin}" in ${coverage.billingPeriod} is "${coverage.confidence}" (no unrecoverable gaps).`
        : status === "warning"
          ? `Seat-ledger coverage for org "${coverage.orgLogin}" in ${coverage.billingPeriod} is "${coverage.confidence}" (limited reconstruction).`
          : `Seat-ledger coverage for org "${coverage.orgLogin}" in ${coverage.billingPeriod} is "${coverage.confidence}" (material unrecoverable coverage).`;

    results.push(
      makeResult(
        "history_coverage",
        status,
        coverage.billingPeriod,
        coverage.orgLogin,
        message,
        { confidence: coverage.confidence, counts: coverage.counts, totalObservations, warnings: [...coverage.warnings].sort() }
      )
    );
  }

  for (const expected of input.expectedGroups ?? []) {
    const key = groupKey(expected.billingPeriod, expected.orgLogin);
    if (seen.has(key)) continue;
    results.push(
      makeResult(
        "history_coverage",
        "warning",
        expected.billingPeriod,
        expected.orgLogin,
        `No historical seat-ledger coverage data is available for org "${expected.orgLogin}" in ${expected.billingPeriod}.`,
        { confidence: null }
      )
    );
  }

  return sortResults(results);
}

// ── Overall run status ────────────────────────────────────────────────────

/**
 * Derive the overall reconciliation run status from a full set of check
 * results: any `"fail"` makes the run `"failed"`; otherwise any
 * `"warning"` makes it `"warning"`; otherwise `"success"`. An empty/missing
 * check set (e.g. every check was skipped or none produced a result) can
 * never claim `"success"` — it deterministically resolves to `"warning"`
 * instead, since "no checks ran" is not evidence of a healthy
 * reconciliation.
 */
export function deriveOverallRunStatus(checks: ReconciliationCheckResult[]): ReconciliationRunStatus {
  if (checks.length === 0) return "warning";
  if (checks.some((c) => c.status === "fail")) return "failed";
  if (checks.some((c) => c.status === "warning")) return "warning";
  return "success";
}

// ── Source / history summaries (deterministic) ────────────────────────────

export interface SourceStateSummaryEntry {
  source: string;
  billingPeriod: string;
  status: string;
  lastSyncedAt?: string | null;
}

export interface SourceStateSummary {
  source: string;
  periods: { billingPeriod: string; status: string; lastSyncedAt: string | null }[];
}

/** Group per-source sync state entries deterministically: sources sorted alphabetically, each source's periods sorted by billing period. Used by the run renderer's "sources used and per-source state" section. */
export function summarizeSourceStates(states: SourceStateSummaryEntry[]): SourceStateSummary[] {
  const bySource = new Map<string, SourceStateSummary>();
  for (const state of states) {
    let summary = bySource.get(state.source);
    if (!summary) {
      summary = { source: state.source, periods: [] };
      bySource.set(state.source, summary);
    }
    summary.periods.push({ billingPeriod: state.billingPeriod, status: state.status, lastSyncedAt: state.lastSyncedAt ?? null });
  }
  const result = [...bySource.values()];
  for (const summary of result) {
    summary.periods.sort((a, b) => a.billingPeriod.localeCompare(b.billingPeriod));
  }
  result.sort((a, b) => a.source.localeCompare(b.source));
  return result;
}

export interface HistoryCoverageSummaryEntry {
  confidence: SeatLedgerConfidence;
  count: number;
}

/** Count seat-ledger coverage entries by confidence tier, sorted alphabetically by tier name for determinism. Used by the run renderer's history-coverage summary section. */
export function summarizeHistoryCoverage(coverage: SeatLedgerCoverage[]): HistoryCoverageSummaryEntry[] {
  const counts = new Map<SeatLedgerConfidence, number>();
  for (const entry of coverage) {
    counts.set(entry.confidence, (counts.get(entry.confidence) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([confidence, count]) => ({ confidence, count }))
    .sort((a, b) => a.confidence.localeCompare(b.confidence));
}

export interface IdentityResolutionSummaryRow {
  holderKey: string;
  identityResolutionSource: string;
  resolvedUserLogin?: string | null;
}

export interface IdentityResolutionBySourceEntry {
  source: string;
  count: number;
}

export interface IdentityResolutionSummary {
  /** Resolution counts grouped by source tier, sorted alphabetically by source name. */
  bySource: IdentityResolutionBySourceEntry[];
  /** Holder keys that never resolved to a real login, sorted for determinism. Only `holderKey` — never an external identity/email/SAML/SCIM value. */
  unresolvedHolderKeys: string[];
}

/** Summarize identity-resolution outcomes deterministically for the run renderer's "identity resolution counts by source" and "unresolved holders" sections. Never surfaces anything beyond a stable `holderKey`. */
export function summarizeIdentityResolution(rows: IdentityResolutionSummaryRow[]): IdentityResolutionSummary {
  const bySourceCounts = new Map<string, number>();
  const unresolvedHolderKeys: string[] = [];
  for (const row of rows) {
    bySourceCounts.set(row.identityResolutionSource, (bySourceCounts.get(row.identityResolutionSource) ?? 0) + 1);
    if (!hasRealLogin({ identityResolutionSource: row.identityResolutionSource, resolvedUserLogin: row.resolvedUserLogin ?? null })) {
      unresolvedHolderKeys.push(row.holderKey);
    }
  }
  const bySource = [...bySourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => a.source.localeCompare(b.source));
  return { bySource, unresolvedHolderKeys: unresolvedHolderKeys.sort() };
}
