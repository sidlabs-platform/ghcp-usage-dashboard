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
//  - "Current snapshot saved before legacy seat replacement" is satisfied by
//    data-lineage independence: this module fetches/normalizes its own live
//    seats (`seatsClient.get*SeatsNormalized`, which never drops unresolved
//    seats) and writes to `license_seat_snapshots` — a table entirely
//    separate from the legacy `copilot_seats` table `sync-service.ts`
//    replaces. The `onCurrentSnapshotPersisted` DI hook lets callers/tests
//    assert this module's own internal ordering (snapshot write happens
//    before anything else in this module could plausibly integrate with a
//    legacy replacement), without coupling this module to `sync-service.ts`.
//  - Historical-period skip/rerun fingerprints are persisted inside the
//    existing free-form `license_reconciliation_runs.source_stats` JSON
//    column (`sourceStats.periodFingerprints[period]`) rather than a new
//    schema column — no schema changes are permitted for this task, and no
//    dedicated fingerprint column exists anywhere in `licensing-schema.sql`.
//  - Per-period AI-Credit API consumption is only fetched for the set of
//    holder logins resolved from that period's live/seat-ledger rows,
//    bounded by MAX_REPORT_MONTHS periods and the configured AIC
//    concurrency — never all historical DB rows.

import {
  getLicensingConfig,
  type ResolvedLicensingConfig,
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
  type MaterializeLicensePeriodInput,
  type MaterializeLicensePeriodResult,
  type MaterializedLicensePeriodRow,
  type ConsumptionRecordInput,
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
  replaceMaterializedPeriod,
  queryLicensePeriodRows,
  hasMaterializedRows,
  type LicenseSeatSnapshotInput,
  type LicenseAuditEventInput,
  type LicenseIdentityRecordInput,
  type LicenseOrgBillingSnapshotInput,
  type LicenseAicConsumptionInput,
  type LicensePeriodRowInput,
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
  replaceMaterializedPeriod: (enterpriseSlug: string, period: string, rows: LicensePeriodRowInput[]) => number;
  queryLicensePeriodRows: (query: LicensePeriodFilterQuery & { view?: "detail" }) => { rows: LicensePeriodRowLike[] };
  hasMaterializedRows: (query: LicensePeriodFilterQuery) => boolean;

  startLicenseRun: (input: StartLicenseRunInput) => string;
  listLicenseRuns: (enterpriseSlug: string, limit?: number) => LicenseRunSummary[];
  recordLicenseRunDiagnostics: (input: LicenseRunDiagnosticsInput) => void;

  /**
   * Invoked immediately after this enterprise's current-month seat snapshot
   * has been durably persisted, and before any later phase in this module
   * runs. Exists purely so tests (and, if ever needed, an external caller)
   * can assert the "current snapshot before legacy seat replacement/
   * integration callback" ordering guarantee documented in the module doc —
   * see the design note above.
   */
  onCurrentSnapshotPersisted?: (enterpriseSlug: string, period: string) => void;
}

/** Minimal shape this module reads off a persisted period row (see `LicensePeriodRowRecord`). Declared locally so this module doesn't need the full read-side repo type. */
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
  seatStatus: string;
  historyConfidence: "exact_snapshot" | "audit_reconstructed" | "live_snapshot_only" | "unrecoverable";
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
    replaceMaterializedPeriod,
    queryLicensePeriodRows: (query) => queryLicensePeriodRows({ ...query, view: "detail" }),
    hasMaterializedRows,

    startLicenseRun,
    listLicenseRuns,
    recordLicenseRunDiagnostics,

    ...overrides,
  };
}

// ── Small deterministic helpers ──────────────────────────────────────────

function sanitizeForLog(s: string): string {
  return s.replace(/\n|\r/g, "");
}

function currentPeriodOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Deterministic (order-independent) fingerprint over a set of source-derived string tokens for one period, so historical-period skip decisions never depend on array/iteration order. */
function computePeriodFingerprint(tokens: string[]): string {
  const sorted = [...tokens].sort();
  let hash = 0;
  for (const token of sorted) {
    for (let i = 0; i < token.length; i++) {
      hash = (hash * 31 + token.charCodeAt(i)) | 0;
    }
    hash = (hash * 31 + 0x1f) | 0; // token separator
  }
  return `fnv:${(hash >>> 0).toString(16)}`;
}

/** Adapt a persisted, already-materialized period row (reused for a skipped historical period) into the shape reconciliation checks expect. Derived cost/utilization fields are not re-derived (not needed by any check function consumed here — see module doc). */
function toMaterializedRowLike(row: LicensePeriodRowLike, enterpriseSlug: string): MaterializedLicensePeriodRow {
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
    licenseAssignedDate: null,
    userRevokedDate: null,
    planType: "unknown",
    seatStatus: row.seatStatus,
    assignedVia: "direct",
    lastActivityAt: null,
    licenseCost: 0,
    defaultAicCredits: 0,
    defaultAicUsd: 0,
    aicAssignedUsd: 0,
    aicAssignedRule: "reused_skip",
    aicConsumedCredits: 0,
    aicConsumedUsd: 0,
    currency: "USD",
    rowSource: "reused_skip",
    consumptionSource: null,
    historyConfidence: row.historyConfidence,
    dataQualityNotes: [],
    utilizationPct: 0,
    overageCredits: 0,
    overageUsd: 0,
    totalCost: 0,
    asOfUtc: "",
    generatedAtUtc: "",
  };
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
): Promise<LicenseHistoryEnterpriseSyncResult> {
  const config = deps.getConfig();
  if (!config.history.enabled) {
    return disabledResult(enterpriseSlug);
  }

  const requestedPeriods = config.history.reportMonths;
  const now = deps.clock();
  const currentPeriod = currentPeriodOf(now);
  const warnings: string[] = [];

  // ── preflight ───────────────────────────────────────────────────────
  deps.onProgress?.({ enterprise: enterpriseSlug, source: "preflight", current: 0, total: 1, message: `Checking auth capabilities for ${sanitizeForLog(enterpriseSlug)}...` });
  const preflight = await deps.preflightEnterpriseAuth(enterpriseSlug);
  deps.heartbeatSyncLock();
  if (!preflight.ok) {
    const failedCapabilities = preflight.capabilities.filter((c) => c.required && c.status !== "supported");
    const message = `Required licensing capability preflight failed for ${enterpriseSlug}: ${failedCapabilities.map((c) => c.message).join(" ")}`;
    return failedResult(enterpriseSlug, requestedPeriods, null, message, warnings);
  }
  for (const capability of preflight.capabilities) {
    if (!capability.required && capability.status !== "supported") {
      warnings.push(capability.message);
    }
  }

  // ── start durable run ────────────────────────────────────────────────
  const runId = deps.startLicenseRun({ enterpriseSlug, requestedPeriods, startedAt: now.toISOString() });

  try {
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
    const { seats: liveSeats } = await deps.getEnterpriseSeatsNormalized(enterpriseSlug);
    const currentSnapshotInputs: LicenseSeatSnapshotInput[] = liveSeats.map((seat) => ({
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
    deps.replacePeriodSnapshots(enterpriseSlug, currentPeriod, currentSnapshotInputs);
    sourceStates.push({ enterpriseSlug, source: "live_seats", billingPeriod: currentPeriod, lastSyncedAt: now.toISOString(), status: "ok" });
    // Design note: satisfies "current snapshot saved before legacy seat
    // replacement/integration callback" — see module doc.
    deps.onCurrentSnapshotPersisted?.(enterpriseSlug, currentPeriod);
    deps.heartbeatSyncLock();

    // ── recoverable range ────────────────────────────────────────────────
    const earliest = earliestRecoverablePeriod({ auditRetentionDays: config.history.auditRetentionDays, now });
    const recoverablePeriods = requestedPeriods.filter((period) => (earliest ? period >= earliest : true) && period <= currentPeriod);
    if (!recoverablePeriods.includes(currentPeriod)) {
      recoverablePeriods.push(currentPeriod);
    }
    recoverablePeriods.sort();

    // ── audit API (recoverable range only) ──────────────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "audit", current: 0, total: 1, message: `Fetching audit log events for ${sanitizeForLog(enterpriseSlug)}...` });
    const cutoffMs = earliest ? Date.parse(`${earliest}-01T00:00:00.000Z`) : null;
    const apiAuditEvents: (SeatLedgerAuditEventInput & { observedLogin: string | null })[] = [];
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
          });
        }
        warnings.push(...auditApiResult.warnings);
        sourceStates.push({ enterpriseSlug, source: "audit_api", lastSyncedAt: now.toISOString(), status: "ok" });
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

    // Merge configured archive import + API events, deterministically
    // deduped by (eventId, source) — configured imports are ingested first
    // (see module doc's exact phase order), so an archive event and an API
    // event that happen to share an id/source pair keep the archive's copy.
    const archiveAuditEvents: (SeatLedgerAuditEventInput & { observedLogin: string | null })[] = archiveImport.records.map((event) => ({
      eventId: event.eventId,
      source: "audit_archive",
      orgLogin: event.orgLogin ?? "",
      holderKey: `login:${(event.observedLogin ?? "unknown").toLowerCase()}`,
      githubUserId: null,
      action: event.action === "cancel" ? "cancel" : "assign",
      occurredAt: event.occurredAt,
      observedLogin: event.observedLogin ?? null,
    }));
    const mergedAuditEventsByKey = new Map<string, SeatLedgerAuditEventInput & { observedLogin: string | null }>();
    for (const event of [...archiveAuditEvents, ...apiAuditEvents]) {
      const key = `${event.eventId}\u0000${event.source}`;
      if (!mergedAuditEventsByKey.has(key)) mergedAuditEventsByKey.set(key, event);
    }
    const mergedAuditEvents = [...mergedAuditEventsByKey.values()];
    deps.upsertAuditEvents(
      enterpriseSlug,
      mergedAuditEvents.map((event) => ({
        eventId: event.eventId,
        orgLogin: event.orgLogin,
        action: event.action,
        occurredAt: event.occurredAt,
        githubUserId: event.githubUserId,
        source: event.source,
      })),
    );
    deps.heartbeatSyncLock();

    // ── membership/SCIM/SAML identities (optional) ──────────────────────
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "identity", current: 0, total: 1, message: `Fetching identity/membership sources for ${sanitizeForLog(enterpriseSlug)}...` });
    const identityRecordsToPersist: LicenseIdentityRecordInput[] = [];
    const enterpriseIdentityByLogin = new Map<string, { externalIdentity: string | null; resolvedLogin: string | null }>();
    const orgIdentityByLogin = new Map<string, { externalIdentity: string | null; resolvedLogin: string | null }>();
    const knownExternalIdentities: string[] = [];

    if (config.identity.fetchEnterpriseIdentities) {
      try {
        const enterpriseIdentities = await deps.getEnterpriseIdentities(enterpriseSlug);
        for (const identity of enterpriseIdentities.identities) {
          if (identity.resolvedLogin) {
            enterpriseIdentityByLogin.set(identity.resolvedLogin.toLowerCase(), { externalIdentity: identity.externalIdentity, resolvedLogin: identity.resolvedLogin });
          }
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
            if (identity.resolvedLogin) {
              orgIdentityByLogin.set(identity.resolvedLogin.toLowerCase(), { externalIdentity: identity.externalIdentity, resolvedLogin: identity.resolvedLogin });
            }
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
    const consumptionRecordsWithPeriod: (ConsumptionRecordInput & { billingPeriod: string })[] = [];
    for (const record of aicCsvImport.records) {
      consumptionRecordsWithPeriod.push({
        billingPeriod: record.billingPeriod,
        source: "csv_import",
        orgLogin: record.orgLogin,
        holderKey: `login:${record.userLogin.toLowerCase()}`,
        credits: record.credits,
        grossUsd: record.grossUsd,
      });
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
          const aicResult = await deps.fetchAicConsumptionForUsers({
            enterpriseSlug,
            year,
            month,
            users: currentLogins,
            concurrency: config.aicConsumption.concurrency,
            creditToUsd: config.creditToUsd,
          });
          enterpriseApiUnavailable = aicResult.fellBackToOrg;
          const aicPersist: LicenseAicConsumptionInput[] = [];
          for (const result of aicResult.results) {
            if (result.status === "ok") {
              consumptionRecordsWithPeriod.push({
                billingPeriod: result.record.billingPeriod,
                source: aicResult.source,
                orgLogin: result.record.orgLogin,
                holderKey: `login:${result.record.userLogin.toLowerCase()}`,
                credits: result.record.credits,
                grossUsd: result.record.grossUsd,
              });
              aicPersist.push({
                billingPeriod: result.record.billingPeriod,
                orgLogin: result.record.orgLogin ?? undefined,
                holderKey: `login:${result.record.userLogin.toLowerCase()}`,
                username: result.record.userLogin,
                credits: result.record.credits,
                grossUsd: result.record.grossUsd,
                netUsd: result.record.netUsd,
                source: aicResult.source,
                observedAt: now.toISOString(),
              });
            } else if (result.status !== "not_found") {
              warnings.push(`AI-Credit consumption fetch issue for a holder: ${result.status}`);
            }
          }
          if (aicPersist.length > 0) deps.upsertAicConsumption(enterpriseSlug, aicPersist);
          sourceStates.push({
            enterpriseSlug,
            source: "aic_consumption",
            billingPeriod: currentPeriod,
            lastSyncedAt: now.toISOString(),
            status: enterpriseApiUnavailable ? "warning" : "ok",
            errorMessage: enterpriseApiUnavailable ? "Enterprise AI-Credit API unavailable; fell back to org endpoint." : null,
          });
        } catch (err) {
          const message = `AI-Credit consumption fetch failed unexpectedly for ${enterpriseSlug}: ${err instanceof Error ? err.message : String(err)}`;
          warnings.push(message);
          sourceStates.push({ enterpriseSlug, source: "aic_consumption", billingPeriod: currentPeriod, lastSyncedAt: now.toISOString(), status: "warning", errorMessage: message });
        }
      }
    }
    deps.heartbeatSyncLock();

    // ── ledger materialization (per enterprise, explicit requested periods) ──
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "ledger", current: 0, total: 1, message: `Building seat ledger for ${sanitizeForLog(enterpriseSlug)}...` });
    const ledgerSnapshots: SeatLedgerSnapshotInput[] = currentSnapshotInputs.map((snapshot) => ({
      billingPeriod: currentPeriod,
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
      auditEvents: mergedAuditEvents,
      snapshots: ledgerSnapshots,
      liveSeats: ledgerLiveSeats,
      periods: recoverablePeriods,
      currentPeriod,
    });
    warnings.push(...ledger.warnings);

    // Build identity resolution input per holderKey, from every source
    // gathered above (audit observations, enterprise/org identity mapping,
    // configured identity-map import), following Task 6 precedence — never
    // promoting an external identity into a login field.
    const holderKeys = new Set(ledger.rows.map((row) => row.holderKey));
    const identities: Record<string, ResolvedIdentity> = {};
    const auditObservationsByHolder = new Map<string, { githubUserId?: number | null; observedLogin: string | null; occurredAt: string; period?: string | null }[]>();
    for (const event of mergedAuditEvents) {
      const list = auditObservationsByHolder.get(event.holderKey) ?? [];
      list.push({ githubUserId: event.githubUserId, observedLogin: event.observedLogin ?? null, occurredAt: event.occurredAt });
      auditObservationsByHolder.set(event.holderKey, list);
    }
    // Indexed by resolvedLogin (the canonical GitHub login the map entry
    // supplies) — not externalIdentity — since holders are looked up by
    // their seat-observed login below.
    const identityMapByResolvedLogin = new Map(identityMapImport.records.map((rec) => [rec.resolvedLogin.toLowerCase(), rec]));

    for (const holderKey of holderKeys) {
      const seatRow = ledger.rows.find((r) => r.holderKey === holderKey && r.revokedAt === null) ?? ledger.rows.find((r) => r.holderKey === holderKey);
      const loginKey = seatRow?.observedLogin?.toLowerCase();
      const enterpriseIdentity = loginKey ? enterpriseIdentityByLogin.get(loginKey) ?? null : null;
      const orgIdentity = loginKey ? orgIdentityByLogin.get(loginKey) ?? null : null;
      const identityMapEntry = loginKey ? identityMapByResolvedLogin.get(loginKey) ?? null : null;
      identities[holderKey] = deps.resolveIdentity({
        holderKey,
        githubUserId: seatRow?.githubUserId ?? null,
        seatLogin: seatRow?.observedLogin ?? null,
        auditObservations: auditObservationsByHolder.get(holderKey) ?? [],
        enterpriseIdentity: enterpriseIdentity ? { externalIdentity: enterpriseIdentity.externalIdentity, resolvedLogin: enterpriseIdentity.resolvedLogin } : null,
        orgIdentity: orgIdentity ? { externalIdentity: orgIdentity.externalIdentity, resolvedLogin: orgIdentity.resolvedLogin } : null,
        identityMap: identityMapEntry ? { externalIdentity: identityMapEntry.externalIdentity, resolvedLogin: identityMapEntry.resolvedLogin, accountState: identityMapEntry.accountState } : null,
      });
    }
    deps.heartbeatSyncLock();

    // ── materialize one period at a time (skip unchanged historical periods) ──
    deps.onProgress?.({ enterprise: enterpriseSlug, source: "materialize", current: 0, total: recoverablePeriods.length, message: `Materializing licensing periods for ${sanitizeForLog(enterpriseSlug)}...` });
    const priorRuns = deps.listLicenseRuns(enterpriseSlug, 20).filter((r) => r.status === "success" || r.status === "warning");
    const priorFingerprints = (priorRuns[0]?.sourceStats?.periodFingerprints as Record<string, string> | undefined) ?? {};

    const allConsumptionForFingerprint = consumptionRecordsWithPeriod.map((c) => `${c.billingPeriod}:${c.orgLogin ?? ""}:${c.holderKey}:${c.credits ?? 0}:${c.grossUsd ?? 0}`);
    const auditFingerprintTokens = mergedAuditEvents.map((e) => `${e.eventId}:${e.source}`);
    const archiveFingerprint = archiveImport.sourceFingerprint;

    const nextPeriodFingerprints: Record<string, string> = { ...priorFingerprints };
    const materializedPeriods: string[] = [];
    const skippedPeriods: string[] = [];
    const asOfUtc = now.toISOString();
    const generatedAtUtc = now.toISOString();
    const allMaterializedRows: MaterializedLicensePeriodRow[] = [];

    for (let i = 0; i < recoverablePeriods.length; i++) {
      const period = recoverablePeriods[i];
      deps.onProgress?.({ enterprise: enterpriseSlug, source: "materialize", period, current: i + 1, total: recoverablePeriods.length, message: `Materializing ${period} for ${sanitizeForLog(enterpriseSlug)}...` });

      const periodAuditTokens = auditFingerprintTokens.filter((_, idx) => mergedAuditEvents[idx].occurredAt.slice(0, 7) === period);
      const periodConsumptionTokens = allConsumptionForFingerprint.filter((_, idx) => consumptionRecordsWithPeriod[idx].billingPeriod === period);
      const fingerprint = computePeriodFingerprint([archiveFingerprint, ...periodAuditTokens, ...periodConsumptionTokens]);

      const canSkip =
        period !== currentPeriod &&
        priorFingerprints[period] === fingerprint &&
        deps.hasMaterializedRows({ enterpriseSlug, periods: [period] });

      if (canSkip) {
        skippedPeriods.push(period);
        nextPeriodFingerprints[period] = fingerprint;
        const existing = deps.queryLicensePeriodRows({ enterpriseSlug, periods: [period] });
        for (const row of existing.rows) {
          allMaterializedRows.push(toMaterializedRowLike(row, enterpriseSlug));
        }
        continue;
      }

      const seatRowsForPeriod = ledger.rows.filter((row) => row.billingPeriod === period);
      const seatMetadata: Record<string, { planType?: string | null; assignedVia?: string | null; lastActivityAt?: string | null }> = {};
      for (const seat of liveSeats) {
        seatMetadata[licensePeriodCanonicalKey(seat.orgLogin, seat.holderKey)] = {
          planType: seat.planType,
          assignedVia: seat.assignedVia,
          lastActivityAt: seat.lastActivityAt,
        };
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
    const authoritativeSeatCounts: AuthoritativeSeatCount[] = orgBillingSnapshots.map((snapshot) => ({
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
        comparisons: orgBillingSnapshots.map((snapshot) => ({
          billingPeriod: snapshot.billingPeriod,
          orgLogin: snapshot.orgLogin,
          grossUsd: consumptionRecordsWithPeriod
            .filter((c) => c.orgLogin === snapshot.orgLogin && c.billingPeriod === snapshot.billingPeriod)
            .reduce((sum, c) => sum + (c.grossUsd ?? 0), 0),
          netUsd: null,
        })),
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
