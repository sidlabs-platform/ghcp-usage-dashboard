// Historical license reconciliation sync orchestrator (Task 9) — ties
// together every previously-completed licensing subsystem (config, GitHub
// optional-source clients, file-based imports, identity resolution, the
// seat ledger, period materialization, and reconciliation checks) into a
// single per-enterprise sync function plus a multi-enterprise coordinator
// suitable for the normal `fullSync()` sync.
//
// Orchestration order per enterprise (exact):
//   preflight → configured imports → live seats + current snapshot →
//   audit API (recoverable range) → membership/SCIM/SAML identities →
//   org billing summaries → selected AIC source(s) → ledger materialization
//   → reconciliation checks → atomic run completion + source state
//   (+ optional configured snapshot/report output).
//
// Design notes (disclosed explicitly — not literally specified upstream):
//  - "Current snapshot saved before legacy seat replacement" is enforced for
//    real by `sync-service.ts`: it calls the exported
//    `captureCurrentLicenseSeatSnapshot` primitive (below) immediately
//    before its legacy `replaceEnterpriseSeats`/`upsertSeats` calls, so the
//    current-month snapshot is durably persisted before the legacy
//    `copilot_seats` table is ever touched. This module's own per-enterprise
//    sync (`syncLicenseHistoryForEnterprise`, which runs later, after
//    billing) reuses the same primitive — idempotently re-persisting the
//    same current-month snapshot is safe and expected. The
//    `onCurrentSnapshotPersisted` hook remains solely as an internal test
//    seam for asserting *this module's own* phase ordering (snapshot
//    persisted before the audit/identity/etc. phases that follow it in this
//    same function) — it is not what proves the legacy-replacement ordering
//    guarantee; `sync-service.test.ts` proves that via real call-order
//    assertions on the actual production wiring.
//  - Historical-period skip/rerun fingerprints are persisted inside the
//    existing free-form `license_reconciliation_runs.source_stats` JSON
//    column (`sourceStats.periodFingerprints[period]`) rather than a new
//    schema column — no schema changes are permitted for this task, and no
//    dedicated fingerprint column exists anywhere in `licensing-schema.sql`.
//  - Per-period AI-Credit API consumption is only fetched for the set of
//    holder logins resolved from that period's live/seat-ledger rows,
//    bounded by MAX_REPORT_MONTHS periods and the configured AIC
//    concurrency — never all historical DB rows.
//  - AI-Credit consumption is fetched enterprise-only first. A capability-
//    wide enterprise failure (every requested holder gets the identical
//    non-`not_found` classification — see `isCapabilityWideAicFailure`) is
//    the only trigger for a per-org fallback (one call per real resolved
//    org, each scoped to that org's own distinct assigned logins); an
//    isolated `not_found` for one holder never triggers a fallback. Only
//    successful results from whichever source actually served the batch are
//    ever persisted/used — a failed enterprise attempt contributes nothing.
//  - Configured snapshot/report output (`history.emitSnapshots`) is fully
//    optional and behind injectable `resolveLicenseSnapshotFilePath`/
//    `writeLicenseSnapshotFile` deps so tests never touch the real
//    filesystem; a write failure degrades to a warning, never a whole-run
//    failure, and nothing is written when disabled (the default).

import {
  getLicensingConfig,
  type ResolvedLicensingConfig,
  type DatedAllowance,
} from "@/lib/config/dashboard-config";
import { getResolvedOrgsForEnterprise as defaultGetResolvedOrgsForEnterprise } from "@/lib/config/enterprise-config";
import { heartbeatSyncLock } from "./metrics-repo";
import { cache } from "@/lib/cache/memory-cache";
import { preflightEnterpriseAuth, type EnterprisePreflightResult } from "@/lib/github/auth-preflight";
import { seatsClient } from "@/lib/github/seats-client";
import type { NormalizedCopilotSeat } from "@/lib/github/seats-client";
import { copilotAuditClient, type AuditFetchResult } from "@/lib/github/copilot-audit-client";
import { copilotIdentityClient, type IdentityFetchResult } from "@/lib/github/copilot-identity-client";
import { copilotMembershipClient, type ScimFetchResult } from "@/lib/github/copilot-membership-client";
import { copilotOrgBillingClient, type OrgBillingResult } from "@/lib/github/copilot-org-billing-client";
import {
  fetchAicConsumptionForUsers,
  type FetchAicConsumptionOptions,
  type FetchAicConsumptionResult,
  type AicConsumptionUserResult,
  type AicConsumptionOk,
  type AicConsumptionSource,
} from "@/lib/github/aic-consumption-client";
import {
  importAuditArchive,
  type NormalizedAuditEvent,
  type ImportAuditArchiveOptions,
} from "@/lib/licensing/audit-archive-import";
import {
  importIdentityMap,
  type NormalizedIdentityRecord as ImportedIdentityMapRecord,
} from "@/lib/licensing/identity-map-import";
import {
  importAicConsumptionCsv,
  type AicCsvConsumptionRecord,
  type ImportAicConsumptionCsvOptions,
} from "@/lib/licensing/aic-csv-import";
import type { ImportResult } from "@/lib/licensing/import-shared";
import { earliestRecoverablePeriod } from "@/lib/licensing/periods";
import {
  resolveIdentity as pureResolveIdentity,
  type IdentityResolutionInput,
  type ResolvedIdentity,
  type AccountState,
} from "@/lib/licensing/identity-resolver";
import {
  buildSeatLedger as pureBuildSeatLedger,
  UNATTRIBUTED_ORG as LEDGER_UNATTRIBUTED_ORG,
  type BuildSeatLedgerOptions,
  type SeatLedgerResult,
  type SeatLedgerAuditEventInput,
  type SeatLedgerSnapshotInput,
  type SeatLedgerLiveSeatInput,
} from "@/lib/licensing/seat-ledger";
import {
  materializeLicensePeriodRows as pureMaterializeLicensePeriodRows,
  licensePeriodCanonicalKey,
  normalizePlanKey,
  CONSUMPTION_SOURCE_PRECEDENCE,
  type MaterializeLicensePeriodInput,
  type MaterializeLicensePeriodResult,
  type MaterializedLicensePeriodRow,
  type ConsumptionRecordInput,
  type ConsumptionSourceKind,
} from "@/lib/licensing/materialize-license-period";
import {
  checkSeatCount,
  checkRealLoginCoverage,
  checkExternalIdentityLeak,
  checkStatusAgreement,
  checkAicGrossVsNet,
  checkConsumptionAttribution,
  checkHistoryCoverage,
  deriveOverallRunStatus,
  type ReconciliationCheckResult,
  type AuthoritativeSeatCount,
} from "@/lib/licensing/reconciliation-checks";
import {
  replacePeriodSnapshots,
  upsertAuditEvents,
  upsertIdentityRecords,
  upsertOrgBillingSnapshots,
  upsertAicConsumption,
  listPersistedAuditEvents,
  listPersistedSeatSnapshots,
  listPersistedIdentityRecords,
  listPersistedOrgBillingSnapshots,
  listPersistedAicConsumption,
  replaceMaterializedPeriod,
  queryLicensePeriodRows,
  hasMaterializedRows,
  stableStringify,
  type LicenseSeatSnapshotInput,
  type LicenseAuditEventInput,
  type LicenseIdentityRecordInput,
  type LicenseOrgBillingSnapshotInput,
  type LicenseAicConsumptionInput,
  type PersistedLicenseAuditEvent,
  type PersistedLicenseSeatSnapshot,
  type PersistedLicenseIdentityRecord,
  type PersistedLicenseOrgBillingSnapshot,
  type PersistedLicenseAicConsumption,
  type LicensePeriodRowInput,
  type LicensePeriodQuery,
  type LicenseRowsPagination,
} from "./license-history-repo";
import {
  startLicenseRun,
  listLicenseRuns,
  recordLicenseRunDiagnostics,
  type StartLicenseRunInput,
  type LicenseCheckInput,
  type LicenseSourceStateInput,
  type LicenseRunDiagnosticsInput,
  type LicenseRunStatus,
} from "./license-run-repo";
import type { LicensePeriodFilterQuery } from "@/lib/types/licensing";
import { promises as fsPromises } from "node:fs";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";

// ── Public progress/result types ─────────────────────────────────────────

/** Typed structured progress for the historical licensing sync — never includes secrets/raw identities. */
export interface LicenseHistorySyncProgress {
  enterprise: string;
  /** Which orchestration phase (source) this progress event belongs to — see the module doc's exact phase order. */
  source: string;
  /** "YYYY-MM" period this progress event is scoped to, when phase-appropriate. */
  period?: string;
  current: number;
  total: number;
  message: string;
}

export type LicenseHistoryEnterpriseStatus = "disabled" | "success" | "warning" | "failed";

export interface LicenseHistoryEnterpriseSyncResult {
  enterpriseSlug: string;
  status: LicenseHistoryEnterpriseStatus;
  runId: string | null;
  requestedPeriods: string[];
  materializedPeriods: string[];
  skippedPeriods: string[];
  warnings: string[];
  errorMessage: string | null;
}

/** Additive summary — never replaces or mutates any existing sync response field. */
export interface LicenseHistorySyncResult {
  enabled: boolean;
  enterprises: LicenseHistoryEnterpriseSyncResult[];
}

// ── Dependency injection surface ─────────────────────────────────────────
//
// Every network/DB/filesystem/clock/heartbeat/progress dependency is
// injectable so tests exercise real orchestration behavior without a
// network call, a native DB binding, or real wall-clock time. Production
// defaults (`createDefaultLicenseHistorySyncDeps`) wire the already-
// completed Task 1-8 modules unchanged.

export interface LicenseHistorySyncDeps {
  getConfig: () => ResolvedLicensingConfig;
  getResolvedOrgsForEnterprise: (enterpriseSlug: string) => string[];
  clock: () => Date;
  heartbeatSyncLock: () => void;
  onProgress?: (progress: LicenseHistorySyncProgress) => void;
  invalidateCache: (prefix: string) => void;

  preflightEnterpriseAuth: (enterpriseSlug: string) => Promise<EnterprisePreflightResult>;

  importAuditArchive: (path: string, options?: ImportAuditArchiveOptions) => ImportResult<NormalizedAuditEvent>;
  importIdentityMap: (path: string) => ImportResult<ImportedIdentityMapRecord>;
  importAicConsumptionCsv: (path: string, options?: ImportAicConsumptionCsvOptions) => ImportResult<AicCsvConsumptionRecord>;

  getEnterpriseSeatsNormalized: (enterpriseSlug: string) => Promise<{ totalSeats: number; seats: NormalizedCopilotSeat[] }>;
  getEnterpriseAuditEvents: (enterpriseSlug: string, cutoffMs: number | null) => Promise<AuditFetchResult>;
  getEnterpriseIdentities: (enterpriseSlug: string) => Promise<IdentityFetchResult>;
  getOrgIdentities: (org: string, enterpriseSlug: string) => Promise<IdentityFetchResult>;
  getEnterpriseScimUsers: (enterpriseSlug: string) => Promise<ScimFetchResult>;
  getOrgBilling: (org: string, enterpriseSlug: string) => Promise<OrgBillingResult>;
  fetchAicConsumptionForUsers: (options: FetchAicConsumptionOptions) => Promise<FetchAicConsumptionResult>;

  resolveIdentity: (input: IdentityResolutionInput) => ResolvedIdentity;
  buildSeatLedger: (options: BuildSeatLedgerOptions) => SeatLedgerResult;
  materializeLicensePeriodRows: (input: MaterializeLicensePeriodInput) => MaterializeLicensePeriodResult;

  replacePeriodSnapshots: (enterpriseSlug: string, period: string, snapshots: LicenseSeatSnapshotInput[]) => number;
  upsertAuditEvents: (enterpriseSlug: string, events: LicenseAuditEventInput[]) => number;
  upsertIdentityRecords: (enterpriseSlug: string, records: LicenseIdentityRecordInput[]) => number;
  upsertOrgBillingSnapshots: (enterpriseSlug: string, records: LicenseOrgBillingSnapshotInput[]) => number;
  upsertAicConsumption: (enterpriseSlug: string, records: LicenseAicConsumptionInput[]) => number;
  listPersistedAuditEvents: (enterpriseSlug: string, periods: string[]) => PersistedLicenseAuditEvent[];
  listPersistedSeatSnapshots: (enterpriseSlug: string, periods: string[]) => PersistedLicenseSeatSnapshot[];
  listPersistedIdentityRecords: (enterpriseSlug: string) => PersistedLicenseIdentityRecord[];
  listPersistedOrgBillingSnapshots: (enterpriseSlug: string, periods: string[]) => PersistedLicenseOrgBillingSnapshot[];
  listPersistedAicConsumption: (enterpriseSlug: string, periods: string[]) => PersistedLicenseAicConsumption[];
  replaceMaterializedPeriod: (enterpriseSlug: string, period: string, rows: LicensePeriodRowInput[]) => number;
  queryLicensePeriodRows: (
    query: LicensePeriodQuery & { view?: "detail" },
  ) => { rows: LicensePeriodRowLike[]; pagination?: LicenseRowsPagination };
  hasMaterializedRows: (query: LicensePeriodFilterQuery) => boolean;

  startLicenseRun: (input: StartLicenseRunInput) => string;
  listLicenseRuns: (enterpriseSlug: string, limit?: number) => LicenseRunSummary[];
  recordLicenseRunDiagnostics: (input: LicenseRunDiagnosticsInput) => void;

  /**
   * Resolve the on-disk path for one enterprise/period's configured
   * snapshot output file, given the configured base directory
   * (`history.snapshotDirectory`). Pure — never touches the filesystem.
   * Must sanitize `enterpriseSlug`/`period` and reject (throw) a resolved
   * path that would escape `baseDir` (path traversal defense-in-depth).
   */
  resolveLicenseSnapshotFilePath: (baseDir: string, enterpriseSlug: string, period: string) => string;
  /**
   * Durably write `contents` to `filePath`, atomically (temp-write then
   * rename) so a crash mid-write never leaves a partial/corrupt file.
   * Production default uses `node:fs/promises`; tests always inject a
   * fake so no test ever touches the real filesystem.
   */
  writeLicenseSnapshotFile: (filePath: string, contents: string) => Promise<void>;

  /**
   * Invoked immediately after this enterprise's current-month seat snapshot
   * has been durably persisted, and before any later phase in this module
   * runs. This is an internal test seam for asserting *this module's own*
   * phase ordering only — see the module doc's design notes above for how
   * the "current snapshot before legacy seat replacement" guarantee is
   * actually enforced (via `captureCurrentLicenseSeatSnapshot` wired
   * directly into `sync-service.ts`, proven by `sync-service.test.ts`).
   */
  onCurrentSnapshotPersisted?: (enterpriseSlug: string, period: string) => void;
}

/**
 * Shape this module reads off a persisted period row (see
 * `LicensePeriodRowRecord`) when reusing an already-materialized row for a
 * skipped historical period. Declared locally so this module doesn't need
 * the full read-side repo type, but mirrors every real, persisted
 * reconciliation field `LicensePeriodRowRecord` carries (everything except
 * `enterpriseSlug`, which the caller already knows and supplies separately)
 * — a skipped period must reconstruct the exact same materialized row shape
 * a freshly-materialized period would produce, never inventing zeros/
 * "unknown" placeholders for data that is actually persisted (see
 * `toMaterializedRowLike`).
 */
export interface LicensePeriodRowLike {
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  githubUserId: number | null;
  userLogin: string | null;
  resolvedUserLogin: string | null;
  externalIdentity: string | null;
  identityResolutionSource: string;
  accountState: string;
  licenseAssignedDate: string | null;
  userRevokedDate: string | null;
  planType: string;
  seatStatus: string;
  assignedVia: string;
  lastActivityAt: string | null;
  licenseCost: number;
  defaultAicCredits: number;
  defaultAicUsd: number;
  aicAssignedUsd: number;
  aicAssignedRule: string;
  aicConsumedCredits: number;
  aicConsumedUsd: number;
  currency: string;
  rowSource: string;
  consumptionSource: string | null;
  historyConfidence: "exact_snapshot" | "audit_reconstructed" | "live_snapshot_only" | "unrecoverable";
  dataQualityNotes: unknown[];
  asOfUtc: string;
  generatedAtUtc: string;
}

/** Minimal shape this module reads off a listed run (see `LicenseRunRecord`). */
export interface LicenseRunSummary {
  status: string;
  sourceStats: Record<string, unknown>;
}

// ── Default (production) dependency wiring ───────────────────────────────

export function createDefaultLicenseHistorySyncDeps(
  overrides: Partial<LicenseHistorySyncDeps> = {},
): LicenseHistorySyncDeps {
  return {
    getConfig: () => getLicensingConfig(),
    getResolvedOrgsForEnterprise: defaultGetResolvedOrgsForEnterprise,
    clock: () => new Date(),
    heartbeatSyncLock,
    invalidateCache: (prefix: string) => cache.invalidateByPrefix(prefix),

    preflightEnterpriseAuth,

    importAuditArchive,
    importIdentityMap,
    importAicConsumptionCsv,

    getEnterpriseSeatsNormalized: (enterpriseSlug) => seatsClient.getEnterpriseSeatsNormalized(enterpriseSlug, enterpriseSlug),
    getEnterpriseAuditEvents: (enterpriseSlug, cutoffMs) =>
      copilotAuditClient.getEnterpriseAuditEvents(enterpriseSlug, { cutoffMs, enterpriseSlug }),
    getEnterpriseIdentities: (enterpriseSlug) => copilotIdentityClient.getEnterpriseIdentities(enterpriseSlug, { enterpriseSlug }),
    getOrgIdentities: (org, enterpriseSlug) => copilotIdentityClient.getOrgIdentities(org, { enterpriseSlug }),
    getEnterpriseScimUsers: (enterpriseSlug) => copilotMembershipClient.getEnterpriseScimUsers(enterpriseSlug, { enterpriseSlug }),
    getOrgBilling: (org, enterpriseSlug) => copilotOrgBillingClient.getOrgBilling(org, enterpriseSlug),
    fetchAicConsumptionForUsers,

    resolveIdentity: pureResolveIdentity,
    buildSeatLedger: pureBuildSeatLedger,
    materializeLicensePeriodRows: pureMaterializeLicensePeriodRows,

    replacePeriodSnapshots,
    upsertAuditEvents,
    upsertIdentityRecords,
    upsertOrgBillingSnapshots,
    upsertAicConsumption,
    listPersistedAuditEvents,
    listPersistedSeatSnapshots,
    listPersistedIdentityRecords,
    listPersistedOrgBillingSnapshots,
    listPersistedAicConsumption,
    replaceMaterializedPeriod,
    queryLicensePeriodRows: (query) => queryLicensePeriodRows({ ...query, view: "detail" }),
    hasMaterializedRows,

    startLicenseRun,
    listLicenseRuns,
    recordLicenseRunDiagnostics,

    resolveLicenseSnapshotFilePath: resolveLicenseSnapshotFilePathDefault,
    writeLicenseSnapshotFile: writeLicenseSnapshotFileDefault,

    ...overrides,
  };
}

// ── Small deterministic helpers ──────────────────────────────────────────

/** Strips anything other than `[a-zA-Z0-9._-]` from a single path segment, so it can never itself carry a directory separator (defense-in-depth against path traversal — see {@link resolveLicenseSnapshotFilePathDefault}). */
function sanitizeSnapshotPathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Production default for `resolveLicenseSnapshotFilePath` — pure, no
 * filesystem access. Builds a single flat filename (`{enterpriseSlug}_
 * {period}.json`) from sanitized segments (each stripped of any path
 * separator) and resolves it against the configured base directory.
 * Defense-in-depth: also verifies the resolved path never escapes the
 * resolved base directory, throwing rather than ever returning an
 * out-of-bounds path.
 */
function resolveLicenseSnapshotFilePathDefault(baseDir: string, enterpriseSlug: string, period: string): string {
  const safeEnterprise = sanitizeSnapshotPathSegment(enterpriseSlug);
  const safePeriod = sanitizeSnapshotPathSegment(period);
  const fileName = `${safeEnterprise}_${safePeriod}.json`;
  const resolvedBase = nodePath.resolve(baseDir);
  const resolvedPath = nodePath.resolve(resolvedBase, fileName);
  const relative = nodePath.relative(resolvedBase, resolvedPath);
  // Only a *directory-traversal* relative path (an actual ".." segment, or
  // an absolute path) ever indicates escape — a sanitized filename that
  // merely starts with literal dots (e.g. "..\_.._etc_...json", with no
  // path separator) is not a traversal and must not be rejected.
  const escapesBase = relative === ".." || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative);
  if (escapesBase) {
    throw new Error(`Resolved license snapshot path would escape the configured base directory for ${enterpriseSlug}/${period}`);
  }
  return resolvedPath;
}

/**
 * Minimal low-level filesystem operations {@link writeLicenseSnapshotFileDefault}
 * needs, injectable so tests can exercise real-temp-directory success paths
 * alongside controlled failure/cleanup paths (rename conflicts, permission
 * errors) without depending on platform-specific rename-failure semantics.
 * The default implementation delegates to `node:fs/promises` unchanged.
 */
export interface LicenseSnapshotFsOps {
  mkdir: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile: (path: string, contents: string, encoding: BufferEncoding) => Promise<void>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

const defaultLicenseSnapshotFsOps: LicenseSnapshotFsOps = {
  mkdir: (dir, options) => fsPromises.mkdir(dir, options),
  writeFile: (path, contents, encoding) => fsPromises.writeFile(path, contents, encoding),
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  unlink: (path) => fsPromises.unlink(path),
};

/**
 * Production default for `writeLicenseSnapshotFile` — atomic temp-write then
 * rename, so a crash mid-write never leaves a partial/corrupt snapshot file.
 * Creates the target directory (recursively) if it doesn't already exist.
 *
 * Task 9 re-review fix #3: if the write or the rename fails, the temp file is
 * always cleaned up (best-effort `unlink`) in a `finally`-equivalent
 * catch/rethrow path — never left orphaned on disk. Cleanup itself never
 * masks the original failure: a missing temp file (`ENOENT` — nothing to
 * remove, e.g. because the write itself never created it) is silently
 * ignored, but any *other* cleanup error is logged (`console.error`, safely
 * isolated in its own try/catch) without ever replacing or swallowing the
 * original error, which is always rethrown unchanged.
 */
export async function writeLicenseSnapshotFileDefault(
  filePath: string,
  contents: string,
  fsOps: LicenseSnapshotFsOps = defaultLicenseSnapshotFsOps,
): Promise<void> {
  const dir = nodePath.dirname(filePath);
  await fsOps.mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fsOps.writeFile(tempPath, contents, "utf8");
    await fsOps.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fsOps.unlink(tempPath);
    } catch (cleanupErr) {
      const code = (cleanupErr as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        // Never let a cleanup failure mask the original error below — just
        // surface it for observability.
        console.error("writeLicenseSnapshotFileDefault: failed to clean up temp file", tempPath, cleanupErr);
      }
    }
    throw err;
  }
}

function sanitizeForLog(s: string): string {
  return s.replace(/\n|\r/g, "");
}

function currentPeriodOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

type PeriodConsumptionRecord = ConsumptionRecordInput & {
  billingPeriod: string;
  netUsd?: number | null;
};

function canonicalizeConsumptionHolderKeys(
  records: PeriodConsumptionRecord[],
  seatRows: SeatLedgerResult["rows"],
  warnings: string[],
): PeriodConsumptionRecord[] {
  const exactMatches = new Map<string, Map<string, string>>();
  const periodMatches = new Map<string, Set<string>>();

  const addPeriodMatch = (key: string, holderKey: string) => {
    const matches = periodMatches.get(key) ?? new Set<string>();
    matches.add(holderKey);
    periodMatches.set(key, matches);
  };
  const addExactMatch = (key: string, holderKey: string, orgLogin: string) => {
    const matches = exactMatches.get(key) ?? new Map<string, string>();
    matches.set(holderKey, orgLogin);
    exactMatches.set(key, matches);
  };

  for (const row of seatRows) {
    const login = row.observedLogin?.trim().toLowerCase();
    if (!login) continue;
    const orgLogin = row.orgLogin.trim() || LEDGER_UNATTRIBUTED_ORG;
    addExactMatch(`${row.billingPeriod}\u0000${orgLogin.toLowerCase()}\u0000${login}`, row.holderKey, orgLogin);
    addPeriodMatch(`${row.billingPeriod}\u0000${login}`, row.holderKey);
  }

  let ambiguousCount = 0;
  const canonicalized = records.map((record) => {
    if (!record.holderKey.startsWith("login:")) return record;
    const login = record.holderKey.slice("login:".length).trim().toLowerCase();
    if (!login) return record;

    const orgLogin = record.orgLogin?.trim() || LEDGER_UNATTRIBUTED_ORG;
    const exact = exactMatches.get(`${record.billingPeriod}\u0000${orgLogin.toLowerCase()}\u0000${login}`);
    if (exact && exact.size > 0) {
      if (exact.size > 1) {
        ambiguousCount++;
        return record;
      }
      const [holderKey, canonicalOrgLogin] = [...exact.entries()][0];
      return { ...record, holderKey, orgLogin: canonicalOrgLogin };
    }

    let matches: Set<string> | undefined;
    if (orgLogin === LEDGER_UNATTRIBUTED_ORG) {
      matches = periodMatches.get(`${record.billingPeriod}\u0000${login}`);
    }
    if (!matches || matches.size === 0) return record;
    if (matches.size > 1) {
      ambiguousCount++;
      return record;
    }

    return { ...record, holderKey: [...matches][0] };
  });

  if (ambiguousCount > 0) {
    warnings.push(
      `AI-Credit holder canonicalization skipped ${ambiguousCount} record(s) because seat evidence mapped a consumed login to multiple holders.`,
    );
  }

  return canonicalized;
}

const MATERIALIZED_ROWS_PAGE_SIZE = 200;

function listAllMaterializedPeriodRows(
  deps: LicenseHistorySyncDeps,
  enterpriseSlug: string,
  period: string,
): LicensePeriodRowLike[] {
  const rows: LicensePeriodRowLike[] = [];
  let page = 1;

  while (true) {
    const result = deps.queryLicensePeriodRows({
      enterpriseSlug,
      periods: [period],
      page,
      pageSize: MATERIALIZED_ROWS_PAGE_SIZE,
    });
    rows.push(...result.rows);
    if (
      result.rows.length === 0 ||
      !result.pagination ||
      page >= result.pagination.totalPages
    ) {
      return rows;
    }
    page++;
  }
}

const ACCOUNT_STATE_RANK: Record<AccountState, number> = {
  unknown: 0,
  member: 1,
  suspended: 2,
  deprovisioned: 3,
};

function normalizeAccountState(value: string | null | undefined): AccountState {
  switch (value?.trim().toLowerCase()) {
    case "active":
    case "enabled":
    case "member":
      return "member";
    case "disabled":
    case "suspended":
      return "suspended";
    case "deleted":
    case "removed":
    case "deprovisioned":
      return "deprovisioned";
    default:
      return "unknown";
  }
}

function mergeIdentityEvidence(
  records: PersistedLicenseIdentityRecord[],
): NonNullable<IdentityResolutionInput["enterpriseIdentity"]> | null {
  if (records.length === 0) return null;
  let accountState: AccountState = "unknown";
  let resolvedLogin: string | null = null;
  let externalIdentity: string | null = null;

  for (const record of records) {
    resolvedLogin ??= record.resolvedLogin ?? null;
    externalIdentity ??= record.externalIdentity ?? null;
    const candidateState = normalizeAccountState(record.accountState);
    if (ACCOUNT_STATE_RANK[candidateState] > ACCOUNT_STATE_RANK[accountState]) {
      accountState = candidateState;
    }
  }

  return { resolvedLogin, externalIdentity, accountState };
}

function isConsumptionSourceKind(source: string): source is ConsumptionSourceKind {
  return (CONSUMPTION_SOURCE_PRECEDENCE as readonly string[]).includes(source);
}

function buildGrossVsNetComparisons(records: PeriodConsumptionRecord[]) {
  const selectedByHolder = new Map<string, PeriodConsumptionRecord>();
  const selectedNetByHolder = new Map<string, PeriodConsumptionRecord>();
  for (const record of records) {
    const orgLogin = record.orgLogin || LEDGER_UNATTRIBUTED_ORG;
    const key = `${record.billingPeriod}\u0000${orgLogin}\u0000${record.holderKey}`;
    const current = selectedByHolder.get(key);
    const candidateRank = CONSUMPTION_SOURCE_PRECEDENCE.indexOf(record.source);
    const currentRank = current
      ? CONSUMPTION_SOURCE_PRECEDENCE.indexOf(current.source)
      : Number.POSITIVE_INFINITY;
    if (!current || candidateRank < currentRank) {
      selectedByHolder.set(key, record);
    }
    if (record.netUsd != null) {
      const currentNet = selectedNetByHolder.get(key);
      const currentNetRank = currentNet
        ? CONSUMPTION_SOURCE_PRECEDENCE.indexOf(currentNet.source)
        : Number.POSITIVE_INFINITY;
      if (!currentNet || candidateRank < currentNetRank) {
        selectedNetByHolder.set(key, record);
      }
    }
  }

  const comparisons = new Map<string, {
    billingPeriod: string;
    orgLogin: string;
    grossUsd: number;
    netUsd: number;
    hasCompleteNet: boolean;
  }>();
  for (const [holderKey, record] of selectedByHolder) {
    const orgLogin = record.orgLogin || LEDGER_UNATTRIBUTED_ORG;
    const key = `${record.billingPeriod}\u0000${orgLogin}`;
    const netRecord = selectedNetByHolder.get(holderKey);
    const comparison = comparisons.get(key) ?? {
      billingPeriod: record.billingPeriod,
      orgLogin,
      grossUsd: 0,
      netUsd: 0,
      hasCompleteNet: true,
    };
    comparison.grossUsd += record.grossUsd ?? 0;
    if (netRecord?.netUsd == null) {
      comparison.hasCompleteNet = false;
    } else {
      comparison.netUsd += netRecord.netUsd;
    }
    comparisons.set(key, comparison);
  }

  return [...comparisons.values()]
    .sort((a, b) =>
      a.billingPeriod.localeCompare(b.billingPeriod) ||
      a.orgLogin.localeCompare(b.orgLogin)
    )
    .map(({ hasCompleteNet, ...comparison }) => ({
      ...comparison,
      netUsd: hasCompleteNet ? comparison.netUsd : null,
    }));
}

/**
 * Detects a capability-wide enterprise AI-Credit API failure from a batch of
 * results returned by an enterprise-only `fetchAicConsumptionForUsers` call
 * (no `orgLogin` passed). The client copies one shared non-`"not_found"`
 * classification across the *entire* batch when the whole endpoint capability
 * is unavailable — so this is true only when every result shares that same
 * failure status. An isolated `"not_found"` for a single holder (mixed with
 * `"ok"`/other results) is never capability-wide, and must never trigger an
 * org fallback.
 */
function isCapabilityWideAicFailure(results: AicConsumptionUserResult[]): boolean {
  if (results.length === 0) return false;
  const failureStatuses = results
    .filter((r) => r.status !== "ok" && r.status !== "not_found")
    .map((r) => r.status);
  if (failureStatuses.length !== results.length) return false;
  return failureStatuses.every((status) => status === failureStatuses[0]);
}

/**
 * Task 9 re-review fix #5: defend against duplicate replicated consumption
 * when the multi-org AI-Credit fallback (see `isCapabilityWideAicFailure`
 * above) queries more than one org and a single holder happens to have a
 * seat in more than one of them. A holder with genuinely distinct per-org
 * consumption keeps every org-attributed record — that is legitimate
 * multi-org usage. But when two or more org-scoped responses return
 * byte-identical, *non-zero* `(credits, grossUsd)` for the very same
 * holder in the same billing period, that is not real distinct
 * consumption — it is the same underlying usage figure replicated by the
 * endpoint across each org query — so this collapses the group into a
 * single deterministic `(unattributed)` record (`orgLogin: null`) instead
 * of persisting/materializing N duplicate org-attributed copies. Grouped
 * and iterated by sorted `(billingPeriod, userLogin)` key so output order
 * never depends on org iteration order. All-zero identical values are
 * left alone (never collapsed) since a zero result carries no consumption
 * to conflate.
 */
function collapseDuplicateOrgFallbackConsumption(results: AicConsumptionUserResult[], warnings: string[]): AicConsumptionUserResult[] {
  const okResults = results.filter((r): r is AicConsumptionOk => r.status === "ok");
  const otherResults = results.filter((r) => r.status !== "ok");

  const groups = new Map<string, AicConsumptionOk[]>();
  for (const result of okResults) {
    const key = `${result.record.billingPeriod}\u0000${result.record.userLogin.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }

  const collapsed: AicConsumptionOk[] = [];
  let collapsedHolderCount = 0;
  let collapsedResponseCount = 0;
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      collapsed.push(group[0]);
      continue;
    }
    const credits = group[0].record.credits ?? 0;
    const grossUsd = group[0].record.grossUsd ?? 0;
    const isNonZero = credits !== 0 || grossUsd !== 0;
    const allIdentical = group.every((r) => (r.record.credits ?? 0) === credits && (r.record.grossUsd ?? 0) === grossUsd);
    if (isNonZero && allIdentical) {
      collapsed.push({ ...group[0], record: { ...group[0].record, orgLogin: null } });
      collapsedHolderCount++;
      collapsedResponseCount += group.length;
    } else {
      // Distinct per-org values (legitimate multi-org consumption), or
      // identical-but-all-zero values — never collapsed.
      collapsed.push(...group);
    }
  }

  if (collapsedHolderCount > 0) {
    warnings.push(
      `AI-Credit org fallback returned byte-identical non-zero consumption for ${collapsedHolderCount} holder(s) across ${collapsedResponseCount} org-scoped response(s) in the same billing period; collapsed each to a single unattributed record rather than persisting duplicate org-attributed rows.`,
    );
  }

  return [...collapsed, ...otherResults];
}

/** Round to 2 decimal places, matching `materialize-license-period.ts`'s own `round2` convention exactly (kept as a tiny local copy — this module intentionally stays free of that module's internal, unexported helpers). Never returns a non-finite value. */
function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Structured, deterministic input to one period's fingerprint — every
 * category of source-derived data that can change Task 7 rows or
 * reconciliation-check outcomes for that period (see module doc's
 * "historical-period skip fingerprints" design note). Every array field
 * must already be a *sorted* array of canonicalized string tokens (each
 * produced via `stableStringify` over a token object) so fingerprint
 * equality never depends on array/iteration order — only `computePeriodFingerprint`
 * itself sorts nothing further.
 */
interface PeriodFingerprintInput {
  period: string;
  /** Normalized (org, holder, action, occurredAt, eventId, source) tokens for this period's merged audit events — never the whole-archive-file fingerprint, so an archive edit affecting only one period never forces every other period to rerun. */
  auditEvents: string[];
  /** (org, holder, source, credits, grossUsd) tokens for this period's chosen/available consumption records. */
  consumption: string[];
  /** Per-holder resolved-identity tokens (resolved login, resolution source, account state, numeric GitHub id) for every holder present in this period — never the raw external identity value. */
  identities: string[];
  /** (org, holder, assignedAt, revokedAt, confidence, source) tokens for this period's seat ledger rows. */
  ledger: string[];
  /** Org billing comparator snapshot tokens for this period, where they affect `checkSeatCount`/`checkAicGrossVsNet`. */
  orgBilling: string[];
  pricing: {
    licenseCost: Record<string, number>;
    aicAllowance: Record<string, number>;
    perUserBudgetUsd: Record<string, number>;
    creditToUsd: number;
    currency: string;
    /** Only the dated-allowance windows whose range actually covers this period. */
    datedAllowances: string[];
  };
  /** Whether this period's consumption was sourced via the per-org fallback (affects row provenance/checks). */
  enterpriseApiUnavailable: boolean;
}

/**
 * Cryptographic (SHA-256), deterministic fingerprint over a period's full
 * fingerprint input — replaces a prior weak, collision-prone 32-bit
 * FNV-like hash. `stableStringify` recursively sorts object keys (see
 * `license-history-repo.ts`), and every array field on the input is already
 * pre-sorted by the caller, so two logically-equivalent inputs (same
 * content, any construction order) always hash identically, while any
 * semantic change to a single field changes the digest.
 */
function computePeriodFingerprint(input: PeriodFingerprintInput): string {
  return `sha256:${createHash("sha256").update(stableStringify(input)).digest("hex")}`;
}

/** True when a configured dated-allowance window's range covers the given "YYYY-MM" period — mirrors `materialize-license-period.ts`'s own `resolveAllowanceCredits` window-matching convention (compares the period's first-of-month date against `start`/`end` lexicographically) so fingerprinting and materialization always agree on which windows are "in effect" for a period. */
function datedAllowanceAffectsPeriod(allowance: DatedAllowance, period: string): boolean {
  const periodStartDate = `${period}-01`;
  if (periodStartDate < allowance.start) return false;
  if (allowance.end && periodStartDate > allowance.end) return false;
  return true;
}

/** Adapt a persisted, already-materialized period row (reused for a skipped historical period) into the shape reconciliation checks expect — reusing every real, persisted field verbatim (see `LicensePeriodRowLike`) rather than inventing zero/"unknown" placeholders. Only the four cost/utilization fields that are genuinely never persisted (`utilizationPct`, `overageCredits`, `overageUsd`, `totalCost`) are re-derived here, using the exact same formula `materialize-license-period.ts` uses to produce them the first time, from the row's own real persisted cost/consumption fields. */
function toMaterializedRowLike(row: LicensePeriodRowLike, enterpriseSlug: string): MaterializedLicensePeriodRow {
  const effectiveBudgetUsd =
    row.aicAssignedRule === "per_user_budget"
      ? row.aicAssignedUsd
      : row.aicAssignedUsd > 0
        ? row.aicAssignedUsd
        : row.defaultAicUsd > 0
          ? row.defaultAicUsd
          : 0;
  const utilizationPct = effectiveBudgetUsd > 0 ? round2((row.aicConsumedUsd / effectiveBudgetUsd) * 100) : 0;
  const overageUsd = Math.max(round2(row.aicConsumedUsd - effectiveBudgetUsd), 0);
  const overageCredits = Math.max(round2(row.aicConsumedCredits - row.defaultAicCredits), 0);
  const totalCost = round2(row.licenseCost + overageUsd);

  return {
    enterpriseSlug,
    billingPeriod: row.billingPeriod,
    orgLogin: row.orgLogin,
    holderKey: row.holderKey,
    githubUserId: row.githubUserId,
    userLogin: row.userLogin,
    resolvedUserLogin: row.resolvedUserLogin,
    externalIdentity: row.externalIdentity,
    identityResolutionSource: row.identityResolutionSource,
    accountState: row.accountState,
    licenseAssignedDate: row.licenseAssignedDate,
    userRevokedDate: row.userRevokedDate,
    planType: normalizePlanKey(row.planType),
    seatStatus: row.seatStatus,
    assignedVia: row.assignedVia,
    lastActivityAt: row.lastActivityAt,
    licenseCost: row.licenseCost,
    defaultAicCredits: row.defaultAicCredits,
    defaultAicUsd: row.defaultAicUsd,
    aicAssignedUsd: row.aicAssignedUsd,
    aicAssignedRule: row.aicAssignedRule,
    aicConsumedCredits: row.aicConsumedCredits,
    aicConsumedUsd: row.aicConsumedUsd,
    currency: row.currency,
    rowSource: row.rowSource,
    consumptionSource: row.consumptionSource,
    historyConfidence: row.historyConfidence,
    dataQualityNotes: (row.dataQualityNotes as string[] | undefined) ?? [],
    utilizationPct,
    overageCredits,
    overageUsd,
    totalCost,
    asOfUtc: row.asOfUtc,
    generatedAtUtc: row.generatedAtUtc,
  };
}

/**
 * Safe, explicit-allowlist projection of a materialized period row for the
 * optional on-disk snapshot artifact (Task 9 re-review fix #1). Snapshot
 * files are operational reconciliation artifacts, not identity exports —
 * they must never carry `externalIdentity` (raw email/SAML NameID/SCIM
 * external ID) or the free-form `dataQualityNotes` array (which can contain
 * arbitrary diagnostic text, including tokens or identity fragments copied
 * from upstream sources). The raw/unverified `userLogin` and the numeric
 * `githubUserId` are also omitted — only `resolvedUserLogin` (the identity
 * pipeline's verified login, when policy allows one to be assigned) and the
 * non-PII `holderKey` are kept as holder identifiers. Every other field is a
 * purely operational/numeric reconciliation value (seat/plan/status/
 * confidence/source, consumption/cost/currency, or a safe ISO timestamp).
 */
export interface SafeLicenseSnapshotRow {
  enterpriseSlug: string;
  billingPeriod: string;
  orgLogin: string;
  holderKey: string;
  resolvedUserLogin: string | null;
  accountState: string;
  planType: string;
  seatStatus: string;
  assignedVia: string;
  historyConfidence: MaterializedLicensePeriodRow["historyConfidence"];
  rowSource: string;
  consumptionSource: string | null;
  licenseCost: number;
  defaultAicCredits: number;
  defaultAicUsd: number;
  aicAssignedUsd: number;
  aicAssignedRule: string;
  aicConsumedCredits: number;
  aicConsumedUsd: number;
  currency: string;
  utilizationPct: number;
  overageCredits: number;
  overageUsd: number;
  totalCost: number;
  licenseAssignedDate: string | null;
  userRevokedDate: string | null;
  lastActivityAt: string | null;
  asOfUtc: string;
  generatedAtUtc: string;
}

/** Project one materialized row through the safe snapshot allowlist — see {@link SafeLicenseSnapshotRow}. */
function toSafeSnapshotRow(row: MaterializedLicensePeriodRow): SafeLicenseSnapshotRow {
  return {
    enterpriseSlug: row.enterpriseSlug,
    billingPeriod: row.billingPeriod,
    orgLogin: row.orgLogin,
    holderKey: row.holderKey,
    resolvedUserLogin: row.resolvedUserLogin,
    accountState: row.accountState,
    planType: row.planType,
    seatStatus: row.seatStatus,
    assignedVia: row.assignedVia,
    historyConfidence: row.historyConfidence,
    rowSource: row.rowSource,
    consumptionSource: row.consumptionSource,
    licenseCost: row.licenseCost,
    defaultAicCredits: row.defaultAicCredits,
    defaultAicUsd: row.defaultAicUsd,
    aicAssignedUsd: row.aicAssignedUsd,
    aicAssignedRule: row.aicAssignedRule,
    aicConsumedCredits: row.aicConsumedCredits,
    aicConsumedUsd: row.aicConsumedUsd,
    currency: row.currency,
    utilizationPct: row.utilizationPct,
    overageCredits: row.overageCredits,
    overageUsd: row.overageUsd,
    totalCost: row.totalCost,
    licenseAssignedDate: row.licenseAssignedDate,
    userRevokedDate: row.userRevokedDate,
    lastActivityAt: row.lastActivityAt,
    asOfUtc: row.asOfUtc,
    generatedAtUtc: row.generatedAtUtc,
  };
}

/** Result of {@link captureCurrentLicenseSeatSnapshot}. */
export interface CaptureCurrentLicenseSeatSnapshotResult {
  /** True whenever history is enabled and a capture was actually attempted (even if it ultimately failed). */
  attempted: boolean;
  /** True only when the snapshot was durably persisted via `replacePeriodSnapshots`. */
  persisted: boolean;
  /** The current billing period (`YYYY-MM`) this capture targeted. */
  period: string;
  /** The normalized live seats used for this capture (either freshly fetched or the caller-supplied `preFetchedSeats`), for reuse by the caller. Empty when disabled or on failure. */
  seats: NormalizedCopilotSeat[];
  /** Non-null only when the required seat fetch failed — no snapshot was persisted in that case. */
  errorMessage: string | null;
}

/** Minimal dependency surface {@link captureCurrentLicenseSeatSnapshot} needs — a subset of {@link LicenseHistorySyncDeps}. */
export type CaptureCurrentLicenseSeatSnapshotDeps = Pick<
  LicenseHistorySyncDeps,
  "getConfig" | "clock" | "getEnterpriseSeatsNormalized" | "replacePeriodSnapshots" | "heartbeatSyncLock"
>;

/**
 * Capture and durably persist this enterprise's current-month authoritative
 * seat snapshot — the primitive `sync-service.ts` calls immediately BEFORE
 * its legacy `copilot_seats` replacement, so the current-month history
 * snapshot is always saved before the legacy table is overwritten (Task 9
 * spec-review fix #2). No-ops with zero side effects when
 * `config.history.enabled` is false (so `fullSync()` calling this
 * unconditionally stays safe/inert on default-disabled configs). Never
 * persists a false/partial snapshot: if the required seat fetch fails, this
 * returns `errorMessage` instead of throwing, so callers can treat this as
 * best-effort. Accepts already-fetched `preFetchedSeats` to avoid an
 * unnecessary extra network round-trip when the caller already has fresh
 * normalized seats in hand (e.g. this module's own per-enterprise sync).
 */
export async function captureCurrentLicenseSeatSnapshot(
  enterpriseSlug: string,
  deps: CaptureCurrentLicenseSeatSnapshotDeps,
  preFetchedSeats?: NormalizedCopilotSeat[],
): Promise<CaptureCurrentLicenseSeatSnapshotResult> {
  const config = deps.getConfig();
  const now = deps.clock();
  const period = currentPeriodOf(now);

  if (!config.history.enabled) {
    return { attempted: false, persisted: false, period, seats: [], errorMessage: null };
  }

  try {
    const seats = preFetchedSeats ?? (await deps.getEnterpriseSeatsNormalized(enterpriseSlug)).seats;
    // `seats` is never filtered/dropped here — unresolved seats (no
    // resolvable login) are preserved so the snapshot stays authoritative.
    const snapshotInputs: LicenseSeatSnapshotInput[] = seats.map((seat) => ({
      orgLogin: seat.orgLogin,
      holderKey: seat.holderKey,
      githubUserId: seat.githubUserId,
      observedLogin: seat.observedLogin,
      planType: seat.planType,
      assignedVia: seat.assignedVia,
      lastActivityAt: seat.lastActivityAt,
      pendingCancellationDate: seat.pendingCancellationDate,
      snapshotAt: now.toISOString(),
      source: "live_seats",
      raw: seat.raw,
    }));
    deps.replacePeriodSnapshots(enterpriseSlug, period, snapshotInputs);
    deps.heartbeatSyncLock?.();
    return { attempted: true, persisted: true, period, seats, errorMessage: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { attempted: true, persisted: false, period, seats: [], errorMessage: message };
  }
}

// ── Per-enterprise sync ───────────────────────────────────────────────────

function disabledResult(enterpriseSlug: string): LicenseHistoryEnterpriseSyncResult {
  return {
    enterpriseSlug,
    status: "disabled",
    runId: null,
    requestedPeriods: [],
    materializedPeriods: [],
    skippedPeriods: [],
    warnings: [],
    errorMessage: null,
  };
}

function failedResult(
  enterpriseSlug: string,
  requestedPeriods: string[],
  runId: string | null,
  errorMessage: string,
  warnings: string[],
): LicenseHistoryEnterpriseSyncResult {
  return {
    enterpriseSlug,
    status: "failed",
    runId,
    requestedPeriods,
    materializedPeriods: [],
    skippedPeriods: [],
    warnings,
    errorMessage,
  };
}

/**
 * Run the historical license reconciliation sync for a single enterprise.
 * Never throws for an expected, per-enterprise failure (a required-capability
 * preflight failure, or any error during active phases) — those degrade to a
 * typed `"failed"` result so a multi-enterprise coordinator can continue with
 * the next enterprise. Only a genuine programmer error before any durable
 * state has been touched (e.g. a DI contract violation) is allowed to
 * propagate.
 */
export async function syncLicenseHistoryForEnterprise(
  enterpriseSlug: string,
  deps: LicenseHistorySyncDeps,
  preCaptured?: CaptureCurrentLicenseSeatSnapshotResult,
): Promise<LicenseHistoryEnterpriseSyncResult> {
  const config = deps.getConfig();
  if (!config.history.enabled) {
    return disabledResult(enterpriseSlug);
  }

  const requestedPeriods = config.history.reportMonths;
  const now = deps.clock();
  const currentPeriod = currentPeriodOf(now);
  const warnings: string[] = [];

  // ── start durable run (Task 9 re-review fix #4) ─────────────────────
  // Started *before* preflight so a required-capability preflight failure
  // still produces a durable, operator-visible run record — never a
  // silent, unrecorded failure. (`config.history.enabled` is checked above
  // this point, so a disabled history sync remains zero-side-effect: no
  // run is ever started for it.)
  const runId = deps.startLicenseRun({ enterpriseSlug, requestedPeriods, startedAt: now.toISOString() });

  try {
    // ── preflight ─────────────────────────────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "preflight", current: 0, total: 1, message: `Checking auth capabilities for ${sanitizeForLog(enterpriseSlug)}...` });
    const preflight = await deps.preflightEnterpriseAuth(enterpriseSlug);
    deps.heartbeatSyncLock();
    if (!preflight.ok) {
      const failedCapabilities = preflight.capabilities.filter((c) => c.required && c.status !== "supported");
      const message = `Required licensing capability preflight failed for ${enterpriseSlug}: ${failedCapabilities.map((c) => c.message).join(" ")}`;
      // Atomically record the failed run's diagnostics (source state/checks
      // stay empty — no phase beyond preflight was ever attempted) so the
      // failure is durably visible via the same run history/diagnostics
      // surfaces a successful run uses, then return without attempting any
      // later phase.
      try {
        deps.recordLicenseRunDiagnostics({
          runId,
          finish: { status: "failed", completedAt: deps.clock().toISOString(), errorMessage: message, warnings },
          checks: [],
          sourceStates: [],
        });
      } catch (persistErr) {
        console.error("[LicenseHistorySync] Failed to persist failed-run diagnostics for %s:", sanitizeForLog(enterpriseSlug), persistErr);
      }
      return failedResult(enterpriseSlug, requestedPeriods, runId, message, warnings);
    }
    for (const capability of preflight.capabilities) {
      if (!capability.required && capability.status !== "supported") {
        warnings.push(capability.message);
      }
    }

    const sourceStates: LicenseSourceStateInput[] = [];
    const orgs = deps.getResolvedOrgsForEnterprise(enterpriseSlug);

    // ── configured imports ─────────────────────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "imports", current: 0, total: 1, message: `Importing configured licensing sources for ${sanitizeForLog(enterpriseSlug)}...` });
    const archiveImport = deps.importAuditArchive(config.history.auditArchivePath);
    warnings.push(...archiveImport.warnings);
    sourceStates.push({
      enterpriseSlug,
      source: "audit_archive_import",
      lastSyncedAt: now.toISOString(),
      status: archiveImport.records.length > 0 || archiveImport.warnings.length === 0 ? "ok" : "warning",
    });

    const identityMapImport = deps.importIdentityMap(config.history.identityMapPath);
    warnings.push(...identityMapImport.warnings);
    sourceStates.push({
      enterpriseSlug,
      source: "identity_map_import",
      lastSyncedAt: now.toISOString(),
      status: identityMapImport.records.length > 0 || identityMapImport.warnings.length === 0 ? "ok" : "warning",
    });

    let aicCsvImport: ImportResult<AicCsvConsumptionRecord> = { records: [], warnings: [], skippedRows: 0, sourceFingerprint: "" };
    // CSV import is independent of `aicConsumption.mode` (which governs the
    // *API* source selection) — it is attempted whenever a csvPath is
    // configured, regardless of mode, per its role as a backfill/override
    // source (see `LicensingAicConsumptionConfig.csvPath` doc).
    if (config.aicConsumption.csvPath) {
      aicCsvImport = deps.importAicConsumptionCsv(config.aicConsumption.csvPath, { creditToUsd: config.creditToUsd });
      warnings.push(...aicCsvImport.warnings);
      sourceStates.push({
        enterpriseSlug,
        source: "aic_csv_import",
        lastSyncedAt: now.toISOString(),
        status: aicCsvImport.records.length > 0 || aicCsvImport.warnings.length === 0 ? "ok" : "warning",
      });
    }
    deps.heartbeatSyncLock();

    // ── live seats + current authoritative monthly snapshot ────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "seats", period: currentPeriod, current: 0, total: 1, message: `Fetching live seats for ${sanitizeForLog(enterpriseSlug)}...` });
    // Task 9 re-review fix #2: when the caller (normally `sync-service.ts`'s
    // `fullSync()`) already captured-and-persisted this enterprise's
    // current-month snapshot once, reuse its normalized seats verbatim and
    // skip both the live-seat re-fetch and the redundant re-persist below —
    // eliminating the duplicate API call and duplicate `replacePeriodSnapshots`
    // write for the same period. Any other case (no pre-capture supplied, or
    // a supplied pre-capture that failed to persist) preserves this
    // function's original standalone behavior exactly: fetch once, then
    // persist once via the shared primitive.
    let liveSeats: NormalizedCopilotSeat[];
    let captureResult: CaptureCurrentLicenseSeatSnapshotResult;
    if (preCaptured?.persisted) {
      liveSeats = preCaptured.seats;
      captureResult = preCaptured;
    } else {
      const fetched = await deps.getEnterpriseSeatsNormalized(enterpriseSlug);
      liveSeats = fetched.seats;
      // Reuse the already-fetched live seats — no extra fetch — while
      // delegating the actual persistence to the shared primitive so
      // `sync-service.ts` and this module both go through the exact same
      // capture logic (Task 9 spec-review fix #2). Preserve this function's
      // existing contract: a required live-seat/snapshot failure fails the
      // whole enterprise run (never a false snapshot).
      captureResult = await captureCurrentLicenseSeatSnapshot(enterpriseSlug, deps, liveSeats);
    }
    if (captureResult.errorMessage) {
      throw new Error(captureResult.errorMessage);
    }
    sourceStates.push({ enterpriseSlug, source: "live_seats", billingPeriod: currentPeriod, lastSyncedAt: now.toISOString(), status: "ok" });
    // Design note: this hook is an internal test seam for this module's own
    // phase ordering only — see the module doc for how the real
    // "current snapshot before legacy seat replacement" guarantee is
    // enforced (via `sync-service.ts` calling the exported primitive above).
    deps.onCurrentSnapshotPersisted?.(enterpriseSlug, currentPeriod);
    deps.heartbeatSyncLock();

    // ── recoverable range ────────────────────────────────────────────────
    // Retention bounds only what the live audit API can return. Configured
    // archives and durable audit/snapshot evidence may extend historical
    // materialization further back, so derive the period gate from both.
    const requestedThroughCurrent = [...new Set([
      ...requestedPeriods.filter((period) => period <= currentPeriod),
      currentPeriod,
    ])].sort();
    const persistedAuditEvidence = deps.listPersistedAuditEvents(
      enterpriseSlug,
      requestedThroughCurrent,
    );
    const persistedSnapshotEvidence = deps.listPersistedSeatSnapshots(
      enterpriseSlug,
      requestedThroughCurrent,
    );
    const liveAuditEarliest = earliestRecoverablePeriod({
      auditRetentionDays: config.history.auditRetentionDays,
      now,
    });
    const earliest = earliestRecoverablePeriod({
      auditRetentionDays: config.history.auditRetentionDays,
      archiveDates: [
        ...archiveImport.records.map((event) => event.occurredAt),
        ...persistedAuditEvidence.map((event) => event.occurredAt),
      ],
      snapshotDates: persistedSnapshotEvidence
        .filter((snapshot) => snapshot.source !== "live_seats")
        .map((snapshot) => `${snapshot.billingPeriod}-01T00:00:00.000Z`),
      now,
    });
    const recoverablePeriods = requestedPeriods.filter((period) => (earliest ? period >= earliest : true) && period <= currentPeriod);
    if (!recoverablePeriods.includes(currentPeriod)) {
      recoverablePeriods.push(currentPeriod);
    }
    recoverablePeriods.sort();

    // ── audit API (recoverable range only) ──────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "audit", current: 0, total: 1, message: `Fetching audit log events for ${sanitizeForLog(enterpriseSlug)}...` });
    const cutoffMs = liveAuditEarliest
      ? Date.parse(`${liveAuditEarliest}-01T00:00:00.000Z`)
      : null;
    type EnrichedAuditEvent = SeatLedgerAuditEventInput & {
      observedLogin: string | null;
      externalIdentity: string | null;
      assignedVia: string | null;
    };
    const apiAuditEvents: EnrichedAuditEvent[] = [];
    // Optional source: this client already normalizes GitHubApiError into a
    // typed unavailable/unknown result, but a genuine unexpected throw must
    // still degrade to a warning here (never fail the whole enterprise run)
    // — mirrors billing-sync-service.ts's established per-source catch
    // pattern for optional sources.
    try {
      const auditApiResult = await deps.getEnterpriseAuditEvents(enterpriseSlug, cutoffMs);
      if (auditApiResult.status === "ok") {
        for (const event of auditApiResult.events) {
          apiAuditEvents.push({
            eventId: event.eventId,
            source: "audit_log",
            orgLogin: event.orgLogin,
            holderKey: event.githubUserId != null ? `id:${event.githubUserId}` : `login:${(event.observedLogin ?? "unknown").toLowerCase()}`,
            githubUserId: event.githubUserId,
            action: event.action,
            occurredAt: event.occurredAt,
            observedLogin: event.observedLogin ?? null,
            externalIdentity: event.externalIdentity ?? null,
            assignedVia: event.team ?? null,
          });
        }
        warnings.push(...auditApiResult.warnings);
        const truncationMessage = auditApiResult.truncated
          ? auditApiResult.warnings.find((warning) => /truncat/i.test(warning))
            ?? "Audit API fetch returned a truncated result; the audit_api source is incomplete."
          : null;
        if (truncationMessage !== null && !warnings.includes(truncationMessage)) warnings.push(truncationMessage);
        sourceStates.push({
          enterpriseSlug,
          source: "audit_api",
          lastSyncedAt: now.toISOString(),
          status: truncationMessage === null ? "ok" : "warning",
          ...(truncationMessage === null ? {} : { errorMessage: truncationMessage }),
        });
      } else {
        const message = auditApiResult.status === "unavailable" ? `Audit log unavailable: ${auditApiResult.reason}` : auditApiResult.message;
        warnings.push(message);
        sourceStates.push({ enterpriseSlug, source: "audit_api", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
      }
    } catch (err) {
      const message = `Audit API fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(message);
      sourceStates.push({ enterpriseSlug, source: "audit_api", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
    }

    // Task 9 re-review fix #3: build an unambiguous observed-login (lowercased)
    // → numeric GitHub ID map from normalized live seats and API audit events
    // — the only two sources in scope that can carry a verified numeric
    // GitHub ID alongside an observed login. Archive events never carry a
    // numeric ID (see `audit-archive-import.ts`), so without this map an
    // archive-derived `login:` holderKey can never correlate with the same
    // real person's `id:`-keyed API/seat events, fragmenting ledger history.
    // A login maps only when every observed numeric ID for it agrees; an
    // ambiguous login (2+ distinct IDs across sources) is never guessed —
    // its archive events keep their login-based holderKey, and a safe
    // (count-only, no login/PII) warning is emitted instead.
    const idsByLogin = new Map<string, Set<number>>();
    const recordLoginId = (login: string | null | undefined, githubUserId: number | null | undefined) => {
      if (!login || githubUserId == null) return;
      const key = login.toLowerCase();
      const set = idsByLogin.get(key) ?? new Set<number>();
      set.add(githubUserId);
      idsByLogin.set(key, set);
    };
    for (const seat of liveSeats) recordLoginId(seat.observedLogin, seat.githubUserId);
    for (const event of apiAuditEvents) recordLoginId(event.observedLogin, event.githubUserId);
    const loginToGithubId = new Map<string, number>();
    let ambiguousLoginCount = 0;
    for (const [login, ids] of idsByLogin) {
      if (ids.size === 1) {
        loginToGithubId.set(login, [...ids][0]);
      } else {
        ambiguousLoginCount++;
      }
    }
    if (ambiguousLoginCount > 0) {
      warnings.push(
        `Skipped GitHub ID correlation for ${ambiguousLoginCount} observed login(s) with ambiguous/conflicting numeric IDs across sources; retaining login-based holder keys for those events.`,
      );
    }

    // Merge configured archive import + API events. Archive events are
    // first upgraded to an `id:`-keyed holderKey wherever the login→ID map
    // above unambiguously resolves them (see fix #3 above) — this must
    // happen *before* dedup/grouping so an archive-sourced event and an
    // API-sourced event describing the same real holder always share a
    // `holderKey`, letting the ledger reconstruct a single assignment
    // interval across "assign in archive, cancel via API" (or vice versa).
    const archiveAuditEvents: EnrichedAuditEvent[] = archiveImport.records.map((event) => {
      const observedLogin = event.observedLogin ?? null;
      const mappedId = observedLogin ? loginToGithubId.get(observedLogin.toLowerCase()) ?? null : null;
      return {
        eventId: event.eventId,
        source: "audit_archive",
        orgLogin: event.orgLogin ?? "",
        holderKey: mappedId != null ? `id:${mappedId}` : `login:${(observedLogin ?? "unknown").toLowerCase()}`,
        githubUserId: mappedId,
        action: event.action === "cancel" ? "cancel" : "assign",
        occurredAt: event.occurredAt,
        observedLogin,
        externalIdentity: event.externalIdentity,
        assignedVia: event.assignedVia,
      };
    });

    // Deterministic two-pass merge/dedupe (Task 9 re-review fix #3):
    //   1) exact eventId dedupe, regardless of source — the same literal
    //      event id ingested via both an archive re-import and a live API
    //      fetch is one event, not two. Archive wins the tie (matches the
    //      module's documented phase order: configured imports ingested
    //      first), but enrichment fields (`githubUserId`/`observedLogin`)
    //      are backfilled from whichever copy has them, in case the
    //      archive copy is the poorer-evidence one.
    //   2) semantic-key dedupe among survivors — `(orgLogin, holderKey,
    //      action, occurredAt)` — catches equivalent normalized records
    //      that happen to carry different source-generated event ids
    //      (e.g. an archive export and a live API page describing the
    //      exact same occurrence). Never collapses events that differ in
    //      holder, org, action, or timestamp — an "assign in archive" +
    //      "cancel in API" pair for the same holder always survives as two
    //      distinct events (one ledger interval, via the shared
    //      holderKey — not one collapsed event).
    type MergeableAuditEvent = EnrichedAuditEvent;
    function mergeEnrichment(primary: MergeableAuditEvent, secondary: MergeableAuditEvent): MergeableAuditEvent {
      return {
        ...primary,
        githubUserId: primary.githubUserId ?? secondary.githubUserId ?? null,
        observedLogin: primary.observedLogin ?? secondary.observedLogin ?? null,
        externalIdentity: primary.externalIdentity ?? secondary.externalIdentity ?? null,
        assignedVia: primary.assignedVia ?? secondary.assignedVia ?? null,
      };
    }
    function preferArchive(a: MergeableAuditEvent, b: MergeableAuditEvent): MergeableAuditEvent {
      const [archiveEvent, otherEvent] = a.source === "audit_archive" ? [a, b] : b.source === "audit_archive" ? [b, a] : [a, b];
      return mergeEnrichment(archiveEvent, otherEvent);
    }

    const byEventId = new Map<string, MergeableAuditEvent>();
    for (const event of [...archiveAuditEvents, ...apiAuditEvents]) {
      const existing = byEventId.get(event.eventId);
      byEventId.set(event.eventId, existing ? preferArchive(existing, event) : event);
    }

    const bySemanticKey = new Map<string, MergeableAuditEvent>();
    for (const event of byEventId.values()) {
      const key = `${event.orgLogin}\u0000${event.holderKey}\u0000${event.action}\u0000${event.occurredAt}`;
      const existing = bySemanticKey.get(key);
      bySemanticKey.set(key, existing ? preferArchive(existing, event) : event);
    }
    const mergedAuditEvents = [...bySemanticKey.values()];
    deps.upsertAuditEvents(
      enterpriseSlug,
      mergedAuditEvents.map((event) => ({
        eventId: event.eventId,
        orgLogin: event.orgLogin,
        action: event.action,
        occurredAt: event.occurredAt,
        githubUserId: event.githubUserId,
        observedLogin: event.observedLogin,
        externalIdentity: event.externalIdentity,
        assignedVia: event.assignedVia,
        source: event.source,
      })),
    );
    deps.heartbeatSyncLock();

    // ── membership/SCIM/SAML identities (optional) ──────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "identity", current: 0, total: 1, message: `Fetching identity/membership sources for ${sanitizeForLog(enterpriseSlug)}...` });
    const identityRecordsToPersist: LicenseIdentityRecordInput[] = [];
    const knownExternalIdentities: string[] = [];

    for (const record of identityMapImport.records) {
      identityRecordsToPersist.push({
        identityKey: `identity-map:${record.resolvedLogin.toLowerCase()}`,
        resolvedLogin: record.resolvedLogin,
        externalIdentity: record.externalIdentity,
        accountState: record.accountState ?? undefined,
        resolutionSource: "identity_map",
        observedAt: now.toISOString(),
      });
    }

    if (config.identity.fetchEnterpriseIdentities) {
      try {
        const enterpriseIdentities = await deps.getEnterpriseIdentities(enterpriseSlug);
        for (const identity of enterpriseIdentities.identities) {
          if (identity.externalIdentity) knownExternalIdentities.push(identity.externalIdentity);
          identityRecordsToPersist.push({
            identityKey: identity.identityKey,
            githubUserId: identity.githubUserId,
            resolvedLogin: identity.resolvedLogin,
            externalIdentity: identity.externalIdentity,
            accountState: "unknown",
            resolutionSource: "enterprise_identity",
            observedAt: identity.observedAt,
          });
        }
        warnings.push(...enterpriseIdentities.warnings);
        sourceStates.push({ enterpriseSlug, source: "enterprise_identity", lastSyncedAt: now.toISOString(), status: "ok" });
      } catch (err) {
        const message = `Enterprise identity fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        sourceStates.push({ enterpriseSlug, source: "enterprise_identity", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
      }
    }

    if (config.identity.fetchOrgIdentities) {
      try {
        for (const org of orgs) {
          const orgIdentities = await deps.getOrgIdentities(org, enterpriseSlug);
          for (const identity of orgIdentities.identities) {
            if (identity.externalIdentity) knownExternalIdentities.push(identity.externalIdentity);
            identityRecordsToPersist.push({
              identityKey: identity.identityKey,
              githubUserId: identity.githubUserId,
              resolvedLogin: identity.resolvedLogin,
              externalIdentity: identity.externalIdentity,
              accountState: "unknown",
              resolutionSource: "org_identity",
              observedAt: identity.observedAt,
            });
          }
          warnings.push(...orgIdentities.warnings);
        }
        sourceStates.push({ enterpriseSlug, source: "org_identity", lastSyncedAt: now.toISOString(), status: "ok" });
      } catch (err) {
        const message = `Org identity fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        sourceStates.push({ enterpriseSlug, source: "org_identity", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
      }
    }

    if (config.identity.fetchMembership) {
      try {
        const scimResult = await deps.getEnterpriseScimUsers(enterpriseSlug);
        if (scimResult.status === "ok") {
          for (const record of scimResult.records) {
            if (record.externalIdentity) knownExternalIdentities.push(record.externalIdentity);
            identityRecordsToPersist.push({
              identityKey: record.identityKey,
              githubUserId: record.githubUserId,
              resolvedLogin: record.observedLogin,
              externalIdentity: record.externalIdentity,
              accountState: record.accountState,
              resolutionSource: "scim_enterprise",
              observedAt: record.observedAt,
            });
          }
          sourceStates.push({ enterpriseSlug, source: "membership", lastSyncedAt: now.toISOString(), status: "ok" });
        } else {
          const message = scimResult.status === "unavailable" ? `Membership/SCIM unavailable: ${scimResult.reason}` : scimResult.message;
          warnings.push(message);
          sourceStates.push({ enterpriseSlug, source: "membership", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
        }
      } catch (err) {
        const message = `Membership/SCIM fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        sourceStates.push({ enterpriseSlug, source: "membership", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
      }
    }

    if (identityRecordsToPersist.length > 0) {
      deps.upsertIdentityRecords(enterpriseSlug, identityRecordsToPersist);
    }
    deps.heartbeatSyncLock();

    // ── org billing summaries (optional) ────────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "org_billing", current: 0, total: 1, message: `Fetching org billing summaries for ${sanitizeForLog(enterpriseSlug)}...` });
    const orgBillingSnapshots: LicenseOrgBillingSnapshotInput[] = [];
    for (const org of orgs) {
      try {
        const billing = await deps.getOrgBilling(org, enterpriseSlug);
        if (billing.status === "ok") {
          orgBillingSnapshots.push({
            billingPeriod: billing.snapshot.billingPeriod,
            orgLogin: billing.snapshot.orgLogin,
            planType: billing.snapshot.planType,
            totalSeats: billing.snapshot.totalSeats,
            pendingCancellation: billing.snapshot.pendingCancellation,
            observedAt: billing.snapshot.observedAt,
          });
          sourceStates.push({ enterpriseSlug, source: "org_billing", billingPeriod: billing.snapshot.billingPeriod, lastSyncedAt: now.toISOString(), status: "ok" });
        } else {
          const message = billing.status === "unavailable" ? `Org billing unavailable for ${org}: ${billing.reason}` : billing.message;
          warnings.push(message);
          sourceStates.push({ enterpriseSlug, source: "org_billing", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
        }
      } catch (err) {
        const message = `Org billing fetch failed unexpectedly for org ${org}: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        sourceStates.push({ enterpriseSlug, source: "org_billing", lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
      }
    }
    if (orgBillingSnapshots.length > 0) {
      deps.upsertOrgBillingSnapshots(enterpriseSlug, orgBillingSnapshots);
    }
    deps.heartbeatSyncLock();

    // ── selected AIC source(s) — precedence enforced at materialization ──
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "aic", period: currentPeriod, current: 0, total: 1, message: `Fetching AI-Credit consumption for ${sanitizeForLog(enterpriseSlug)}...` });
    // Consumption records are period-scoped (CSV rows carry their own
    // billingPeriod; API results are current-period-only) — tracked here
    // with an explicit billingPeriod so each materialize call and
    // reconciliation check below can filter to the right period instead of
    // double-counting the same row across every historical period.
    let consumptionRecordsWithPeriod: PeriodConsumptionRecord[] = [];
    const csvConsumptionToPersist: LicenseAicConsumptionInput[] = [];
    for (const record of aicCsvImport.records) {
      consumptionRecordsWithPeriod.push({
        billingPeriod: record.billingPeriod,
        source: "csv_import",
        orgLogin: record.orgLogin,
        holderKey: `login:${record.userLogin.toLowerCase()}`,
        credits: record.credits,
        grossUsd: record.grossUsd,
      });
      csvConsumptionToPersist.push({
        billingPeriod: record.billingPeriod,
        orgLogin: record.orgLogin ?? undefined,
        holderKey: `login:${record.userLogin.toLowerCase()}`,
        username: record.userLogin,
        credits: record.credits,
        grossUsd: record.grossUsd,
        source: "csv_import",
        observedAt: now.toISOString(),
      });
    }
    if (csvConsumptionToPersist.length > 0) {
      deps.upsertAicConsumption(enterpriseSlug, csvConsumptionToPersist);
    }

    let enterpriseApiUnavailable = false;
    // "billing_report" mode intentionally does not call the per-user AIC
    // API here — it relies on already-synced billing report data (a
    // pre-existing, separate sync surface out of this task's scope) plus
    // whatever CSV import / org-billing data is available. See the final
    // report's disclosed scope simplifications.
    if (config.aicConsumption.mode === "per_user_api" || config.aicConsumption.mode === "auto") {
      const currentLogins = liveSeats.map((s) => s.observedLogin).filter((login): login is string => !!login);
      if (currentLogins.length > 0) {
        try {
          const [year, month] = currentPeriod.split("-").map(Number);

          // Enterprise-only first — dedupe distinct live/resolved logins
          // case-insensitively so the batch call matches the client's own
          // dedup contract (no double-count from casing differences).
          const dedupedLogins = Array.from(new Map(currentLogins.map((login) => [login.toLowerCase(), login])).values());
          const enterpriseResult = await deps.fetchAicConsumptionForUsers({
            enterpriseSlug,
            year,
            month,
            users: dedupedLogins,
            concurrency: config.aicConsumption.concurrency,
            creditToUsd: config.creditToUsd,
          });

          // A capability-wide enterprise failure is the *only* trigger for
          // an org fallback — the client (without `orgLogin`) copies one
          // shared non-"not_found" classification across the whole batch
          // when the whole endpoint is unavailable; an isolated per-holder
          // `not_found` never triggers this.
          const capabilityWideFailure = isCapabilityWideAicFailure(enterpriseResult.results);

          let chosenResults: AicConsumptionUserResult[] = [];
          let chosenSource: AicConsumptionSource = enterpriseResult.source;
          let orgFallbackAttempted = false;
          let orgFallbackHadAnySuccess = false;
          // Task 9 re-review fix #4: tracks whether *any* org in the
          // fallback loop returned a non-"ok" result or threw, independent
          // of `capabilityWideFailure` — used below so a mixed
          // success/failure fallback is never reported as a "clean" one.
          let orgFallbackHadAnyFailure = false;

          if (!capabilityWideFailure) {
            chosenResults = enterpriseResult.results;
          } else {
            enterpriseApiUnavailable = true;
            // Per real resolved org, scoped to that org's own distinct
            // assigned logins only — never re-consuming the enterprise-only
            // batch, and never duplicating a multi-org user's consumption
            // across orgs (each org call only carries its own holders).
            // Task 9 re-review fix #4: each org's fetch is isolated in its
            // own try/catch so a single org throwing (or returning
            // non-"ok" results) never discards another org's already-
            // successful results — only that org's holders are skipped.
            for (const org of orgs) {
              const orgLogins = Array.from(
                new Map(
                  liveSeats
                    .filter((seat) => seat.orgLogin === org && seat.observedLogin)
                    .map((seat) => [seat.observedLogin!.toLowerCase(), seat.observedLogin!] as const),
                ).values(),
              );
              if (orgLogins.length === 0) continue;
              orgFallbackAttempted = true;
              try {
                const orgResult = await deps.fetchAicConsumptionForUsers({
                  orgLogin: org,
                  year,
                  month,
                  users: orgLogins,
                  concurrency: config.aicConsumption.concurrency,
                  creditToUsd: config.creditToUsd,
                });
                chosenSource = orgResult.source;
                const orgFailures = orgResult.results.filter((r) => r.status !== "ok");
                if (orgResult.results.some((r) => r.status === "ok")) orgFallbackHadAnySuccess = true;
                if (orgFailures.length > 0) {
                  orgFallbackHadAnyFailure = true;
                  // Deterministic, PII-free summary: org + failed-count +
                  // status-category breakdown — never individual user logins.
                  const statusCounts = orgFailures.reduce<Record<string, number>>((acc, r) => {
                    acc[r.status] = (acc[r.status] ?? 0) + 1;
                    return acc;
                  }, {});
                  const categorySummary = Object.entries(statusCounts)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([status, count]) => `${status}:${count}`)
                    .join(", ");
                  warnings.push(
                    `AI-Credit org fallback for ${sanitizeForLog(org)}: ${orgFailures.length} of ${orgResult.results.length} holder(s) failed (${categorySummary}).`,
                  );
                }
                chosenResults.push(...orgResult.results);
              } catch (err) {
                orgFallbackHadAnyFailure = true;
                const message = err instanceof Error ? err.message : String(err);
                warnings.push(`AI-Credit org fallback for ${sanitizeForLog(org)} failed unexpectedly: ${sanitizeForLog(message)}.`);
                // This org contributes no results — its failure never
                // discards results already collected from other orgs.
              }
            }
            // Task 9 re-review fix #5: defend against the same holder's
            // consumption being replicated byte-identically across
            // multiple org-scoped fallback responses (see
            // `collapseDuplicateOrgFallbackConsumption` doc comment).
            chosenResults = collapseDuplicateOrgFallbackConsumption(chosenResults, warnings);
          }

          const aicPersist: LicenseAicConsumptionInput[] = [];
          for (const result of chosenResults) {
            if (result.status === "ok") {
              consumptionRecordsWithPeriod.push({
                billingPeriod: result.record.billingPeriod,
                source: chosenSource,
                orgLogin: result.record.orgLogin,
                holderKey: `login:${result.record.userLogin.toLowerCase()}`,
                credits: result.record.credits,
                grossUsd: result.record.grossUsd,
                netUsd: result.record.netUsd,
              });
              aicPersist.push({
                billingPeriod: result.record.billingPeriod,
                orgLogin: result.record.orgLogin ?? undefined,
                holderKey: `login:${result.record.userLogin.toLowerCase()}`,
                username: result.record.userLogin,
                credits: result.record.credits,
                grossUsd: result.record.grossUsd,
                netUsd: result.record.netUsd,
                source: chosenSource,
                observedAt: now.toISOString(),
              });
            } else if (result.status !== "not_found" && !capabilityWideFailure) {
              // Only surface isolated per-holder issues as a warning when
              // we're not already reporting the capability-wide failure
              // below (avoids duplicate/noisy warnings for every holder).
              warnings.push(`AI-Credit consumption fetch issue for a holder: ${result.status}`);
            }
          }
          if (aicPersist.length > 0) deps.upsertAicConsumption(enterpriseSlug, aicPersist);

          let aicErrorMessage: string | null = null;
          if (enterpriseApiUnavailable) {
            if (orgFallbackAttempted && orgFallbackHadAnySuccess && !orgFallbackHadAnyFailure) {
              aicErrorMessage = "Enterprise AI-Credit API unavailable; fell back to per-org endpoint(s).";
            } else if (orgFallbackAttempted && orgFallbackHadAnySuccess && orgFallbackHadAnyFailure) {
              // Task 9 re-review fix #4: never report a "clean" fallback
              // when at least one org partially or fully failed — the
              // per-org warning(s) above already carry the detail.
              aicErrorMessage = "Enterprise AI-Credit API unavailable; fell back to per-org endpoint(s) with partial per-org failures (see org fallback warnings).";
            } else {
              aicErrorMessage = "Enterprise AI-Credit API unavailable and org fallback did not return any consumption.";
            }
          }
          sourceStates.push({
            enterpriseSlug,
            source: "aic_consumption",
            billingPeriod: currentPeriod,
            lastSyncedAt: now.toISOString(),
            // Never a false "ok" while the enterprise API is unavailable —
            // "warning" whether or not the org fallback itself succeeded.
            status: enterpriseApiUnavailable ? "warning" : "ok",
            errorMessage: aicErrorMessage,
          });
          if (aicErrorMessage) warnings.push(aicErrorMessage);
        } catch (err) {
          const message = `AI-Credit consumption fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
          warnings.push(message);
          sourceStates.push({ enterpriseSlug, source: "aic_consumption", billingPeriod: currentPeriod, lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
        }
      }
    }
    deps.heartbeatSyncLock();

    const persistedAuditEvents: EnrichedAuditEvent[] = persistedAuditEvidence.map((event) => ({
        eventId: event.eventId,
        source: event.source,
        orgLogin: event.orgLogin ?? "",
        holderKey: event.holderKey,
        githubUserId: event.githubUserId ?? null,
        action: event.action as SeatLedgerAuditEventInput["action"],
        occurredAt: event.occurredAt,
        observedLogin: event.observedLogin ?? null,
        externalIdentity: event.externalIdentity ?? null,
        assignedVia: event.assignedVia ?? null,
    }));
    const durableAuditByEventId = new Map<string, EnrichedAuditEvent>();
    for (const event of [...persistedAuditEvents, ...mergedAuditEvents]) {
      durableAuditByEventId.set(event.eventId, event);
    }
    const durableAuditBySemanticKey = new Map<string, EnrichedAuditEvent>();
    for (const event of durableAuditByEventId.values()) {
      const key = `${event.orgLogin}\u0000${event.holderKey}\u0000${event.action}\u0000${event.occurredAt}`;
      durableAuditBySemanticKey.set(key, event);
    }
    const durableAuditEvents = [...durableAuditBySemanticKey.values()];
    const persistedSeatSnapshots = persistedSnapshotEvidence.filter((snapshot) =>
      recoverablePeriods.includes(snapshot.billingPeriod),
    );
    const persistedSeatSnapshotByPeriodKey = new Map(
      persistedSeatSnapshots.map((snapshot) => [
        `${snapshot.billingPeriod}\u0000${licensePeriodCanonicalKey(snapshot.orgLogin ?? "", snapshot.holderKey)}`,
        snapshot,
      ]),
    );
    const durableIdentityRecords = [
      ...identityRecordsToPersist,
      ...deps.listPersistedIdentityRecords(enterpriseSlug),
    ];
    const durableOrgBillingByKey = new Map<string, LicenseOrgBillingSnapshotInput>();
    for (const snapshot of [
      ...deps.listPersistedOrgBillingSnapshots(enterpriseSlug, recoverablePeriods),
      ...orgBillingSnapshots,
    ]) {
      durableOrgBillingByKey.set(`${snapshot.billingPeriod}\u0000${snapshot.orgLogin}`, snapshot);
    }
    const durableOrgBillingSnapshots = [...durableOrgBillingByKey.values()];
    const freshConsumptionRecords = consumptionRecordsWithPeriod;
    const persistedConsumption = deps.listPersistedAicConsumption(enterpriseSlug, recoverablePeriods);
    const durableConsumptionByKey = new Map<string, PeriodConsumptionRecord>();
    for (const record of persistedConsumption) {
      if (!isConsumptionSourceKind(record.source)) {
        warnings.push(`Ignored persisted AI-Credit row with unsupported source "${sanitizeForLog(record.source)}".`);
        continue;
      }
      const normalized: PeriodConsumptionRecord = {
        billingPeriod: record.billingPeriod,
        source: record.source,
        orgLogin: record.orgLogin,
        holderKey: record.holderKey,
        credits: record.credits,
        grossUsd: record.grossUsd,
        netUsd: record.netUsd,
      };
      durableConsumptionByKey.set(
        `${normalized.billingPeriod}\u0000${normalized.orgLogin ?? ""}\u0000${normalized.holderKey}\u0000${normalized.source}`,
        normalized,
      );
    }
    for (const record of freshConsumptionRecords) {
      durableConsumptionByKey.set(
        `${record.billingPeriod}\u0000${record.orgLogin ?? ""}\u0000${record.holderKey}\u0000${record.source}`,
        record,
      );
    }
    consumptionRecordsWithPeriod = [...durableConsumptionByKey.values()];
    for (const record of durableIdentityRecords) {
      if (record.externalIdentity) knownExternalIdentities.push(record.externalIdentity);
    }

    // ── ledger materialization (per enterprise, explicit requested periods) ──
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "ledger", current: 0, total: 1, message: `Building seat ledger for ${sanitizeForLog(enterpriseSlug)}...` });
    const ledgerSnapshots: SeatLedgerSnapshotInput[] = persistedSeatSnapshots
      .filter((snapshot) => snapshot.source !== "live_seats")
      .map((snapshot) => ({
      billingPeriod: snapshot.billingPeriod,
      orgLogin: snapshot.orgLogin ?? "",
      holderKey: snapshot.holderKey,
      githubUserId: snapshot.githubUserId ?? null,
      observedLogin: snapshot.observedLogin ?? null,
      snapshotAt: snapshot.snapshotAt,
    }));
    const ledgerLiveSeats: SeatLedgerLiveSeatInput[] = liveSeats.map((seat) => ({
      orgLogin: seat.orgLogin,
      holderKey: seat.holderKey,
      githubUserId: seat.githubUserId,
      observedLogin: seat.observedLogin,
      observedAt: now.toISOString(),
    }));
    const ledger = deps.buildSeatLedger({
      enterpriseSlug,
      auditEvents: durableAuditEvents,
      snapshots: ledgerSnapshots,
      liveSeats: ledgerLiveSeats,
      periods: recoverablePeriods,
      currentPeriod,
    });
    warnings.push(...ledger.warnings);
    consumptionRecordsWithPeriod = canonicalizeConsumptionHolderKeys(
      consumptionRecordsWithPeriod,
      ledger.rows,
      warnings,
    );

    // Build identity resolution input per holderKey, from every source
    // gathered above (audit observations, enterprise/org identity mapping,
    // configured identity-map import), following Task 6 precedence — never
    // promoting an external identity into a login field.
    const holderKeys = new Set(ledger.rows.map((row) => row.holderKey));
    const identities: Record<string, ResolvedIdentity> = {};
    const auditObservationsByHolder = new Map<string, { githubUserId?: number | null; observedLogin: string | null; occurredAt: string; period?: string | null }[]>();
    for (const event of durableAuditEvents) {
      const list = auditObservationsByHolder.get(event.holderKey) ?? [];
      list.push({ githubUserId: event.githubUserId, observedLogin: event.observedLogin ?? null, occurredAt: event.occurredAt });
      auditObservationsByHolder.set(event.holderKey, list);
    }

    const indexIdentityRecord = (
      index: Map<string, PersistedLicenseIdentityRecord[]>,
      key: string | null | undefined,
      record: PersistedLicenseIdentityRecord,
    ) => {
      if (!key) return;
      const normalized = key.toLowerCase();
      const list = index.get(normalized) ?? [];
      list.push(record);
      index.set(normalized, list);
    };
    const identityRecordsByKey = new Map<string, PersistedLicenseIdentityRecord[]>();
    const identityRecordsByLogin = new Map<string, PersistedLicenseIdentityRecord[]>();
    const identityRecordsByGithubId = new Map<string, PersistedLicenseIdentityRecord[]>();
    for (const record of durableIdentityRecords) {
      indexIdentityRecord(identityRecordsByKey, record.identityKey, record);
      indexIdentityRecord(identityRecordsByLogin, record.resolvedLogin, record);
      if (record.githubUserId != null) {
        indexIdentityRecord(identityRecordsByGithubId, String(record.githubUserId), record);
      }
    }

    const seatRowByHolder = new Map<string, (typeof ledger.rows)[number]>();
    for (const row of ledger.rows) {
      const current = seatRowByHolder.get(row.holderKey);
      if (!current || (current.revokedAt !== null && row.revokedAt === null)) {
        seatRowByHolder.set(row.holderKey, row);
      }
    }

    for (const holderKey of holderKeys) {
      const seatRow = seatRowByHolder.get(holderKey);
      const loginKey = seatRow?.observedLogin?.toLowerCase();
      const matchingIdentityRecords = new Set<PersistedLicenseIdentityRecord>([
        ...(identityRecordsByKey.get(holderKey.toLowerCase()) ?? []),
        ...(loginKey ? identityRecordsByLogin.get(loginKey) ?? [] : []),
        ...(seatRow?.githubUserId != null
          ? identityRecordsByGithubId.get(String(seatRow.githubUserId)) ?? []
          : []),
      ]);
      const enterpriseIdentity = mergeIdentityEvidence(
        [...matchingIdentityRecords].filter((record) =>
          record.resolutionSource === "enterprise_identity" ||
          record.resolutionSource === "scim_enterprise" ||
          record.resolutionSource === "membership"
        ),
      );
      const orgIdentity = mergeIdentityEvidence(
        [...matchingIdentityRecords].filter((record) => record.resolutionSource === "org_identity"),
      );
      const identityMapEntry = mergeIdentityEvidence(
        [...matchingIdentityRecords].filter((record) => record.resolutionSource === "identity_map"),
      );
      identities[holderKey] = deps.resolveIdentity({
        holderKey,
        githubUserId: seatRow?.githubUserId ?? null,
        seatLogin: seatRow?.observedLogin ?? null,
        auditObservations: auditObservationsByHolder.get(holderKey) ?? [],
        enterpriseIdentity,
        orgIdentity,
        identityMap: identityMapEntry,
      });
    }
    deps.heartbeatSyncLock();

    // ── materialize one period at a time (skip unchanged historical periods) ──
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "materialize", current: 0, total: recoverablePeriods.length, message: `Materializing licensing periods for ${sanitizeForLog(enterpriseSlug)}...` });
    const priorRuns = deps.listLicenseRuns(enterpriseSlug, 20).filter((r) => r.status === "success" || r.status === "warning");
    const priorFingerprints = (priorRuns[0]?.sourceStats?.periodFingerprints as Record<string, string> | undefined) ?? {};

    const nextPeriodFingerprints: Record<string, string> = {};
    const materializedPeriods: string[] = [];
    const skippedPeriods: string[] = [];
    const asOfUtc = now.toISOString();
    const generatedAtUtc = now.toISOString();
    const allMaterializedRows: MaterializedLicensePeriodRow[] = [];

    for (let i = 0; i < recoverablePeriods.length; i++) {
      const period = recoverablePeriods[i];
      deps.onProgress?.({ enterprise: enterpriseSlug, source: "materialize", period, current: i + 1, total: recoverablePeriods.length, message: `Materializing ${period} for ${sanitizeForLog(enterpriseSlug)}...` });

      const periodAuditTokens = durableAuditEvents
        .filter((e) => e.occurredAt.slice(0, 7) === period)
        .map((e) => stableStringify({ eventId: e.eventId, source: e.source, orgLogin: e.orgLogin, holderKey: e.holderKey, action: e.action, occurredAt: e.occurredAt }))
        .sort();
      const periodConsumptionTokens = consumptionRecordsWithPeriod
        .filter((c) => c.billingPeriod === period)
        .map((c) => stableStringify({ orgLogin: c.orgLogin ?? null, holderKey: c.holderKey, source: c.source, credits: c.credits ?? 0, grossUsd: c.grossUsd ?? 0 }))
        .sort();
      const periodHolderKeys = new Set(ledger.rows.filter((row) => row.billingPeriod === period).map((row) => row.holderKey));
      const periodIdentityTokens = [...periodHolderKeys]
        .map((holderKey) => {
          const identity = identities[holderKey];
          return stableStringify({
            holderKey,
            resolvedUserLogin: identity?.resolvedUserLogin ?? null,
            identityResolutionSource: identity?.source ?? "unresolved",
            accountState: identity?.accountState ?? "unknown",
            githubUserId: identity?.githubUserId ?? null,
          });
        })
        .sort();
      const periodLedgerTokens = ledger.rows
        .filter((row) => row.billingPeriod === period)
        .map((row) => stableStringify({ orgLogin: row.orgLogin, holderKey: row.holderKey, assignedAt: row.assignedAt, revokedAt: row.revokedAt, confidence: row.confidence, source: row.source }))
        .sort();
      const periodOrgBillingTokens = durableOrgBillingSnapshots
        .filter((snapshot) => snapshot.billingPeriod === period)
        .map((snapshot) => stableStringify({ orgLogin: snapshot.orgLogin, planType: snapshot.planType, totalSeats: snapshot.totalSeats, pendingCancellation: snapshot.pendingCancellation }))
        .sort();
      const periodDatedAllowanceTokens = config.datedAllowances
        .filter((allowance) => datedAllowanceAffectsPeriod(allowance, period))
        .map((allowance) => stableStringify(allowance))
        .sort();

      const fingerprint = computePeriodFingerprint({
        period,
        auditEvents: periodAuditTokens,
        consumption: periodConsumptionTokens,
        identities: periodIdentityTokens,
        ledger: periodLedgerTokens,
        orgBilling: periodOrgBillingTokens,
        pricing: {
          licenseCost: config.licenseCost,
          aicAllowance: config.aicAllowance,
          perUserBudgetUsd: config.perUserBudgetUsd,
          creditToUsd: config.creditToUsd,
          currency: config.currency,
          datedAllowances: periodDatedAllowanceTokens,
        },
        enterpriseApiUnavailable,
      });

      const canSkip =
        period !== currentPeriod &&
        priorFingerprints[period] === fingerprint &&
        deps.hasMaterializedRows({ enterpriseSlug, periods: [period] });

      if (canSkip) {
        skippedPeriods.push(period);
        nextPeriodFingerprints[period] = fingerprint;
        const existingRows = listAllMaterializedPeriodRows(deps, enterpriseSlug, period);
        for (const row of existingRows) {
          allMaterializedRows.push(toMaterializedRowLike(row, enterpriseSlug));
        }
        continue;
      }

      const seatRowsForPeriod = ledger.rows.filter((row) => row.billingPeriod === period);
      const seatMetadata: Record<string, { planType?: string | null; assignedVia?: string | null; lastActivityAt?: string | null }> = {};
      const periodOrgPlanByLogin = new Map(
        durableOrgBillingSnapshots
          .filter((snapshot) => snapshot.billingPeriod === period && snapshot.planType)
          .map((snapshot) => [snapshot.orgLogin, snapshot.planType] as const),
      );
      for (const seatRow of seatRowsForPeriod) {
        const snapshot = persistedSeatSnapshotByPeriodKey.get(
          `${period}\u0000${licensePeriodCanonicalKey(seatRow.orgLogin, seatRow.holderKey)}`,
        );
        const orgPlanType = periodOrgPlanByLogin.get(seatRow.orgLogin) ?? null;
        if (snapshot || orgPlanType) {
          seatMetadata[licensePeriodCanonicalKey(seatRow.orgLogin, seatRow.holderKey)] = {
            planType: snapshot?.planType ?? orgPlanType,
            assignedVia: snapshot?.assignedVia ?? null,
            lastActivityAt: snapshot?.lastActivityAt ?? null,
          };
        }
      }
      if (period === currentPeriod) {
        for (const seat of liveSeats) {
          seatMetadata[licensePeriodCanonicalKey(seat.orgLogin, seat.holderKey)] = {
            planType: seat.planType,
            assignedVia: seat.assignedVia,
            lastActivityAt: seat.lastActivityAt,
          };
        }
      }

      const consumptionForPeriod: ConsumptionRecordInput[] = consumptionRecordsWithPeriod
        .filter((c) => c.billingPeriod === period)
        .map((c) => {
          const rest = { ...c };
          delete (rest as { billingPeriod?: string }).billingPeriod;
          return rest;
        });

      const materializeResult = deps.materializeLicensePeriodRows({
        enterpriseSlug,
        billingPeriod: period,
        seatRows: seatRowsForPeriod,
        identities,
        seatMetadata,
        consumption: consumptionForPeriod,
        enterpriseApiUnavailable,
        config,
        asOfUtc,
        generatedAtUtc,
      });
      warnings.push(...materializeResult.warnings);
      const degradedPeriod =
        materializeResult.warnings.length > 0 ||
        sourceStates.some((state) => state.status === "warning") ||
        ledger.coverage.some((coverage) =>
          coverage.billingPeriod === period && coverage.confidence === "unrecoverable"
        );
      if (
        materializeResult.rows.length === 0 &&
        degradedPeriod &&
        deps.hasMaterializedRows({ enterpriseSlug, periods: [period] })
      ) {
        const existingRows = listAllMaterializedPeriodRows(deps, enterpriseSlug, period);
        if (existingRows.length > 0) {
          const retainedWarning = `Retained the existing ${period} materialization because the current run produced no replacement rows.`;
          warnings.push(retainedWarning);
          skippedPeriods.push(period);
          for (const row of existingRows) {
            allMaterializedRows.push(toMaterializedRowLike(row, enterpriseSlug));
          }
          continue;
        }
      }
      const rowInputs: LicensePeriodRowInput[] = materializeResult.rows.map((row) => ({
        orgLogin: row.orgLogin,
        holderKey: row.holderKey,
        githubUserId: row.githubUserId,
        userLogin: row.userLogin,
        resolvedUserLogin: row.resolvedUserLogin,
        externalIdentity: row.externalIdentity,
        identityResolutionSource: row.identityResolutionSource,
        accountState: row.accountState,
        licenseAssignedDate: row.licenseAssignedDate,
        userRevokedDate: row.userRevokedDate,
        planType: row.planType,
        seatStatus: row.seatStatus,
        assignedVia: row.assignedVia,
        lastActivityAt: row.lastActivityAt,
        licenseCost: row.licenseCost,
        defaultAicCredits: row.defaultAicCredits,
        defaultAicUsd: row.defaultAicUsd,
        aicAssignedUsd: row.aicAssignedUsd,
        aicAssignedRule: row.aicAssignedRule,
        aicConsumedCredits: row.aicConsumedCredits,
        aicConsumedUsd: row.aicConsumedUsd,
        currency: row.currency,
        rowSource: row.rowSource,
        consumptionSource: row.consumptionSource,
        historyConfidence: row.historyConfidence,
        dataQualityNotes: row.dataQualityNotes,
        asOfUtc: row.asOfUtc,
        generatedAtUtc: row.generatedAtUtc,
      }));
      deps.replaceMaterializedPeriod(enterpriseSlug, period, rowInputs);
      materializedPeriods.push(period);
      nextPeriodFingerprints[period] = fingerprint;
      allMaterializedRows.push(...materializeResult.rows);
    }
    deps.heartbeatSyncLock();

    // ── reconciliation checks (after all periods materialized) ──────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "checks", current: 0, total: 1, message: `Running reconciliation checks for ${sanitizeForLog(enterpriseSlug)}...` });
    // Org billing's `totalSeats` is the authoritative seat-count comparator
    // `checkSeatCount` expects; a group with no org billing snapshot for its
    // (billingPeriod, orgLogin) legitimately warns (no comparator available).
    const authoritativeSeatCounts: AuthoritativeSeatCount[] = durableOrgBillingSnapshots.map((snapshot) => ({
      billingPeriod: snapshot.billingPeriod,
      orgLogin: snapshot.orgLogin,
      totalSeats: snapshot.totalSeats ?? 0,
    }));
    const checkResults: ReconciliationCheckResult[] = [
      ...checkSeatCount({ materializedRows: allMaterializedRows, authoritativeSeatCounts }),
      ...checkRealLoginCoverage({ materializedRows: allMaterializedRows }),
      ...checkExternalIdentityLeak({ materializedRows: allMaterializedRows, knownExternalIdentities }),
      ...checkStatusAgreement({ materializedRows: allMaterializedRows }),
      ...checkAicGrossVsNet({
        comparisons: buildGrossVsNetComparisons(consumptionRecordsWithPeriod),
        tolerancePct: config.validation.aicTolerancePct,
      }),
      ...checkConsumptionAttribution({
        records: consumptionRecordsWithPeriod.map((c) => ({
          billingPeriod: c.billingPeriod,
          orgLogin: c.orgLogin || LEDGER_UNATTRIBUTED_ORG,
          holderKey: c.holderKey,
          credits: c.credits ?? 0,
          grossUsd: c.grossUsd ?? 0,
        })),
      }),
      ...checkHistoryCoverage({ coverage: ledger.coverage }),
    ];
    const overallStatus = deriveOverallRunStatus(checkResults);
    const runStatus: LicenseRunStatus = overallStatus;

    // ── optional configured snapshot output (Task 9 spec-review fix #4) ──
    // Fully optional: no-op (no filesystem call at all) when
    // `history.emitSnapshots` is false — the default. Deliberately placed
    // after reconciliation checks so its warnings/source states make it
    // into the same `recordLicenseRunDiagnostics` call below, and before
    // "atomic run completion" per the module doc's documented ordering. A
    // write failure is always an optional-source warning, never a
    // whole-run failure.
    if (config.history.emitSnapshots) {
      for (const period of recoverablePeriods) {
        try {
          const rowsForPeriod = allMaterializedRows
            .filter((row) => row.billingPeriod === period)
            .slice()
            .sort((a, b) => (a.orgLogin === b.orgLogin ? a.holderKey.localeCompare(b.holderKey) : a.orgLogin.localeCompare(b.orgLogin)))
            .map(toSafeSnapshotRow);
          const filePath = deps.resolveLicenseSnapshotFilePath(config.history.snapshotDirectory, enterpriseSlug, period);
          const contents = JSON.stringify({ enterpriseSlug, billingPeriod: period, generatedAtUtc, rows: rowsForPeriod }, null, 2);
          await deps.writeLicenseSnapshotFile(filePath, contents);
        } catch (err) {
          const message = `Configured snapshot output failed for ${sanitizeForLog(enterpriseSlug)} period ${period}: ${err instanceof Error ? err.message : String(err)}`;
          warnings.push(message);
          sourceStates.push({ enterpriseSlug, source: "snapshot_output", billingPeriod: period, lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
        }
      }
    }

    // ── atomic run completion + source state ─────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "finalize", current: 1, total: 1, message: `Finalizing licensing sync run for ${sanitizeForLog(enterpriseSlug)}...` });
    const checkInputs: LicenseCheckInput[] = checkResults.map((check) => ({
      checkName: check.name,
      billingPeriod: check.billingPeriod,
      orgLogin: check.orgLogin,
      status: check.status,
      expectedValue: check.expectedValue,
      actualValue: check.actualValue,
      message: check.message,
      details: check.details,
    }));
    deps.recordLicenseRunDiagnostics({
      runId,
      finish: {
        status: runStatus,
        completedAt: deps.clock().toISOString(),
        sourceStats: { periodFingerprints: nextPeriodFingerprints },
        warnings,
        errorMessage: null,
      },
      checks: checkInputs,
      sourceStates,
    });
    deps.heartbeatSyncLock();

    deps.invalidateCache("/api/billing/license-reconciliation");
    deps.invalidateCache("/api/billing/license-history");
    deps.invalidateCache("/api/billing/license-exports");
    deps.invalidateCache("/api/billing/license-diagnostics");
    deps.invalidateCache("/api/billing/auth-preflight");

    return {
      enterpriseSlug,
      status: overallStatus,
      runId,
      requestedPeriods,
      materializedPeriods,
      skippedPeriods,
      warnings,
      errorMessage: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.recordLicenseRunDiagnostics({
        runId,
        finish: { status: "failed", completedAt: deps.clock().toISOString(), errorMessage: message, warnings },
        checks: [],
        sourceStates: [],
      });
    } catch (persistErr) {
      console.error("[LicenseHistorySync] Failed to persist failed-run diagnostics for %s:", sanitizeForLog(enterpriseSlug), persistErr);
    }
    return failedResult(enterpriseSlug, requestedPeriods, runId, message, warnings);
  }
}

// ── Multi-enterprise coordinator ─────────────────────────────────────────

/**
 * Run the historical license reconciliation sync across every given
 * enterprise, in order, isolating failures per enterprise so one
 * enterprise's failure never prevents the others from completing. Results
 * are sorted by `enterpriseSlug` for a stable, deterministic summary
 * regardless of the input order or per-enterprise completion timing.
 */
export async function syncLicenseHistory(
  enterpriseSlugs: string[],
  deps: LicenseHistorySyncDeps,
): Promise<LicenseHistorySyncResult> {
  const config = deps.getConfig();
  if (!config.history.enabled) {
    return { enabled: false, enterprises: enterpriseSlugs.map((slug) => disabledResult(slug)).sort((a, b) => a.enterpriseSlug.localeCompare(b.enterpriseSlug)) };
  }

  const results: LicenseHistoryEnterpriseSyncResult[] = [];
  for (const slug of enterpriseSlugs) {
    try {
      results.push(await syncLicenseHistoryForEnterprise(slug, deps));
    } catch (err) {
      // syncLicenseHistoryForEnterprise already catches everything it can
      // meaningfully recover from; this is a last-resort isolation guard so
      // a truly unexpected throw still never stops the remaining
      // enterprises in the coordinator.
      const message = err instanceof Error ? err.message : String(err);
      console.error("[LicenseHistorySync] Unexpected error syncing %s, continuing with remaining enterprises:", sanitizeForLog(slug), err);
      results.push(failedResult(slug, [], null, message, []));
    }
  }

  results.sort((a, b) => a.enterpriseSlug.localeCompare(b.enterpriseSlug));
  return { enabled: true, enterprises: results };
}
