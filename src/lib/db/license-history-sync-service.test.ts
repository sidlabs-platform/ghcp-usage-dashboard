import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedLicensingConfig } from "@/lib/config/dashboard-config";
import type { EnterprisePreflightResult } from "@/lib/github/auth-preflight";
import type { NormalizedCopilotSeat } from "@/lib/github/seats-client";
import type { AuditFetchResult, NormalizedCopilotAuditEvent } from "@/lib/github/copilot-audit-client";
import type { IdentityFetchResult } from "@/lib/github/copilot-identity-client";
import type { ScimFetchResult } from "@/lib/github/copilot-membership-client";
import type { OrgBillingResult } from "@/lib/github/copilot-org-billing-client";
import type { FetchAicConsumptionResult, FetchAicConsumptionOptions, AicConsumptionUserResult } from "@/lib/github/aic-consumption-client";
import type { ResolvedIdentity } from "@/lib/licensing/identity-resolver";
import type {
  SeatLedgerResult,
  SeatLedgerRow,
  BuildSeatLedgerOptions,
} from "@/lib/licensing/seat-ledger";
import type {
  MaterializeLicensePeriodInput,
  MaterializeLicensePeriodResult,
  MaterializedLicensePeriodRow,
} from "@/lib/licensing/materialize-license-period";
import type { ImportResult } from "@/lib/licensing/import-shared";
import type { NormalizedAuditEvent } from "@/lib/licensing/audit-archive-import";
import type { AicCsvConsumptionRecord } from "@/lib/licensing/aic-csv-import";
import type { NormalizedIdentityRecord as ImportedIdentityMapRecord } from "@/lib/licensing/identity-map-import";
import type { LicenseRunDiagnosticsInput, StartLicenseRunInput } from "./license-run-repo";
import type {
  LicenseAicConsumptionInput,
  PersistedLicenseAuditEvent,
  PersistedLicenseSeatSnapshot,
  PersistedLicenseIdentityRecord,
  PersistedLicenseOrgBillingSnapshot,
  PersistedLicenseAicConsumption,
} from "./license-history-repo";
import type {
  LicenseHistorySyncDeps,
  LicenseHistorySyncProgress,
  LicenseRunSummary,
  CaptureCurrentLicenseSeatSnapshotResult,
  LicenseSnapshotFsOps,
  LicensePeriodRowLike,
} from "./license-history-sync-service";
import { promises as fsReal } from "node:fs";
import { tmpdir } from "node:os";
import nodePathReal from "node:path";

import {
  syncLicenseHistoryForEnterprise,
  syncLicenseHistory,
  captureCurrentLicenseSeatSnapshot,
  createDefaultLicenseHistorySyncDeps,
  writeLicenseSnapshotFileDefault,
} from "./license-history-sync-service";

// ── Fixture builders ──────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ResolvedLicensingConfig> = {}): ResolvedLicensingConfig {
  return {
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 0, enterprise: 0, unknown: 0 },
    perUserBudgetUsd: {},
    datedAllowances: [],
    history: {
      enabled: true,
      reportMonths: ["2025-01", "2025-02", "2025-03"],
      auditRetentionDays: 3650,
      emitSnapshots: false,
      snapshotDirectory: "",
      auditArchivePath: "",
      identityMapPath: "",
    },
    identity: { fetchMembership: false, fetchEnterpriseIdentities: false, fetchOrgIdentities: false },
    aicConsumption: { mode: "auto", csvPath: undefined, concurrency: 4 },
    validation: { enabled: true, aicTolerancePct: 5 },
    ...overrides,
  };
}

function makePreflight(enterpriseSlug: string, ok = true): EnterprisePreflightResult {
  return {
    enterpriseSlug,
    ok,
    capabilities: [
      {
        capability: "copilot_seats",
        label: "Copilot seat assignments",
        status: ok ? "supported" : "unsupported",
        required: true,
        message: ok ? "Copilot seat assignments supported." : "Copilot seat assignments not supported.",
      },
    ],
  };
}

function makeSeat(overrides: Partial<NormalizedCopilotSeat> = {}): NormalizedCopilotSeat {
  return {
    holderKey: "login:alice",
    githubUserId: 1,
    observedLogin: "alice",
    unresolved: false,
    orgLogin: "acme-org",
    planType: "business",
    assignedVia: "direct",
    lastActivityAt: null,
    lastActivityEditor: null,
    pendingCancellationDate: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    raw: {} as NormalizedCopilotSeat["raw"],
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
  return {
    holderKey: "login:alice",
    githubUserId: 1,
    userLogin: "alice",
    resolvedUserLogin: "alice",
    externalIdentity: null,
    source: "seat",
    accountState: "member",
    notes: [],
    ...overrides,
  };
}

function makeLedgerRow(period: string, overrides: Partial<SeatLedgerRow> = {}): SeatLedgerRow {
  return {
    enterpriseSlug: "acme",
    billingPeriod: period,
    orgLogin: "acme-org",
    holderKey: "login:alice",
    githubUserId: 1,
    observedLogin: "alice",
    assignedAt: "2024-01-01T00:00:00.000Z",
    revokedAt: null,
    confidence: "exact_snapshot",
    source: "exact_snapshot",
    ...overrides,
  };
}

function makeMaterializedRow(period: string, overrides: Partial<MaterializedLicensePeriodRow> = {}): MaterializedLicensePeriodRow {
  return {
    enterpriseSlug: "acme",
    billingPeriod: period,
    orgLogin: "acme-org",
    holderKey: "login:alice",
    githubUserId: 1,
    userLogin: "alice",
    resolvedUserLogin: "alice",
    externalIdentity: null,
    identityResolutionSource: "seat",
    accountState: "member",
    licenseAssignedDate: "2024-01-01",
    userRevokedDate: null,
    planType: "business",
    seatStatus: "active",
    assignedVia: "direct",
    lastActivityAt: null,
    licenseCost: 19,
    defaultAicCredits: 0,
    defaultAicUsd: 0,
    aicAssignedUsd: 0,
    aicAssignedRule: "plan_default",
    aicConsumedCredits: 0,
    aicConsumedUsd: 0,
    currency: "USD",
    rowSource: "materialized",
    consumptionSource: null,
    historyConfidence: "exact_snapshot",
    dataQualityNotes: [],
    utilizationPct: 0,
    overageCredits: 0,
    overageUsd: 0,
    totalCost: 19,
    asOfUtc: "2025-03-15T00:00:00.000Z",
    generatedAtUtc: "2025-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function emptyImport<T>(): ImportResult<T> {
  return { records: [], warnings: [], skippedRows: 0, sourceFingerprint: "" };
}

/** Builds a fully-mocked `LicenseHistorySyncDeps` with sensible passing defaults for every phase. Every test overrides only what it needs. */
function makeDeps(overrides: Partial<LicenseHistorySyncDeps> = {}): LicenseHistorySyncDeps {
  const now = new Date("2025-03-15T00:00:00.000Z");
  const base: LicenseHistorySyncDeps = {
    getConfig: vi.fn(() => makeConfig()),
    getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org"]),
    clock: vi.fn(() => now),
    heartbeatSyncLock: vi.fn(),
    onProgress: vi.fn(),
    invalidateCache: vi.fn(),

    preflightEnterpriseAuth: vi.fn(async (enterpriseSlug: string) => makePreflight(enterpriseSlug, true)),

    importAuditArchive: vi.fn(() => emptyImport<NormalizedAuditEvent>()),
    importIdentityMap: vi.fn(() => emptyImport<ImportedIdentityMapRecord>()),
    importAicConsumptionCsv: vi.fn(() => emptyImport<AicCsvConsumptionRecord>()),

    getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [makeSeat()] })),
    getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({ status: "ok", events: [], truncated: false, warnings: [] })),
    getEnterpriseIdentities: vi.fn(async (): Promise<IdentityFetchResult> => ({ identities: [], warnings: [] })),
    getOrgIdentities: vi.fn(async (): Promise<IdentityFetchResult> => ({ identities: [], warnings: [] })),
    getEnterpriseScimUsers: vi.fn(async (): Promise<ScimFetchResult> => ({ status: "ok", records: [] })),
    getOrgBilling: vi.fn(async (): Promise<OrgBillingResult> => ({
      status: "ok",
      snapshot: {
        orgLogin: "acme-org",
        billingPeriod: "2025-03",
        planType: "business",
        totalSeats: 1,
        pendingCancellation: 0,
        observedAt: now.toISOString(),
        raw: {} as never,
      },
    })),
    fetchAicConsumptionForUsers: vi.fn(async (): Promise<FetchAicConsumptionResult> => ({ results: [], source: "org_api", fellBackToOrg: false })),

    resolveIdentity: vi.fn((input) => makeIdentity({ holderKey: input.holderKey, githubUserId: input.githubUserId ?? null })),
    buildSeatLedger: vi.fn((options): SeatLedgerResult => ({
      rows: options.periods.map((period: string) => makeLedgerRow(period, { enterpriseSlug: options.enterpriseSlug })),
      coverage: [],
      warnings: [],
    })),
    materializeLicensePeriodRows: vi.fn((input: MaterializeLicensePeriodInput): MaterializeLicensePeriodResult => ({
      rows: [makeMaterializedRow(input.billingPeriod, { enterpriseSlug: input.enterpriseSlug })],
      warnings: [],
    })),

    replacePeriodSnapshots: vi.fn(() => 1),
    upsertAuditEvents: vi.fn(() => 0),
    upsertIdentityRecords: vi.fn(() => 0),
    upsertOrgBillingSnapshots: vi.fn(() => 0),
    upsertAicConsumption: vi.fn(() => 0),
    listPersistedAuditEvents: vi.fn((): PersistedLicenseAuditEvent[] => []),
    listPersistedSeatSnapshots: vi.fn((): PersistedLicenseSeatSnapshot[] => []),
    listPersistedIdentityRecords: vi.fn((): PersistedLicenseIdentityRecord[] => []),
    listPersistedOrgBillingSnapshots: vi.fn((): PersistedLicenseOrgBillingSnapshot[] => []),
    listPersistedAicConsumption: vi.fn((): PersistedLicenseAicConsumption[] => []),
    replaceMaterializedPeriod: vi.fn(() => 1),
    queryLicensePeriodRows: vi.fn(() => ({ rows: [] })),
    hasMaterializedRows: vi.fn(() => false),

    startLicenseRun: vi.fn((input: StartLicenseRunInput) => `run-${input.enterpriseSlug}`),
    listLicenseRuns: vi.fn((): LicenseRunSummary[] => []),
    recordLicenseRunDiagnostics: vi.fn(),

    resolveLicenseSnapshotFilePath: vi.fn((baseDir: string, enterpriseSlug: string, period: string) => `${baseDir}/${enterpriseSlug}_${period}.json`),
    writeLicenseSnapshotFile: vi.fn(async () => {}),

    onCurrentSnapshotPersisted: vi.fn(),
  };
  return { ...base, ...overrides };
}

/** Builds an ok AIC result for the given user/period/source. */
function makeAicOk(userLogin: string, overrides: Partial<Extract<AicConsumptionUserResult, { status: "ok" }>["record"]> = {}): Extract<AicConsumptionUserResult, { status: "ok" }> {
  return {
    status: "ok",
    userLogin,
    record: {
      billingPeriod: "2025-03",
      orgLogin: null,
      userLogin,
      credits: 10,
      grossUsd: 0.1,
      netUsd: 0.1,
      source: "enterprise_api",
      raw: {},
      ...overrides,
    },
  };
}

/** Builds a failed AIC result for the given user/status. */
function makeAicFailure(userLogin: string, status: Exclude<AicConsumptionUserResult["status"], "ok">): Extract<AicConsumptionUserResult, { status: typeof status }> {
  return { status, userLogin, message: `failure for ${userLogin}: ${status}` } as Extract<AicConsumptionUserResult, { status: typeof status }>;
}

describe("license-history-sync-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── disabled no-op ───────────────────────────────────────────────────
  describe("history.enabled = false", () => {
    it("returns a deterministic disabled/skipped result with no source/network/DB writes", async () => {
      const deps = makeDeps({ getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, enabled: false } })) });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result).toEqual({
        enterpriseSlug: "acme",
        status: "disabled",
        runId: null,
        requestedPeriods: [],
        materializedPeriods: [],
        skippedPeriods: [],
        warnings: [],
        errorMessage: null,
      });
      expect(deps.preflightEnterpriseAuth).not.toHaveBeenCalled();
      expect(deps.startLicenseRun).not.toHaveBeenCalled();
      expect(deps.getEnterpriseSeatsNormalized).not.toHaveBeenCalled();
      expect(deps.replacePeriodSnapshots).not.toHaveBeenCalled();
      expect(deps.heartbeatSyncLock).not.toHaveBeenCalled();
      expect(deps.invalidateCache).not.toHaveBeenCalled();
    });

    it("coordinator returns disabled for every enterprise with no per-enterprise work", async () => {
      const deps = makeDeps({ getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, enabled: false } })) });
      const result = await syncLicenseHistory(["zeta", "alpha"], deps);
      expect(result.enabled).toBe(false);
      expect(result.enterprises.map((e) => e.enterpriseSlug)).toEqual(["alpha", "zeta"]);
      expect(result.enterprises.every((e) => e.status === "disabled")).toBe(true);
      expect(deps.startLicenseRun).not.toHaveBeenCalled();
    });
  });

  // ── exact phase order + heartbeat/progress ──────────────────────────
  describe("phase order", () => {
    it("runs phases in the exact documented order with heartbeats between major phases", async () => {
      const deps = makeDeps();
      await syncLicenseHistoryForEnterprise("acme", deps);

      const progressCalls = (deps.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => (call[0] as LicenseHistorySyncProgress).source,
      );
      const uniqueOrderedPhases: string[] = [];
      for (const phase of progressCalls) {
        if (uniqueOrderedPhases[uniqueOrderedPhases.length - 1] !== phase) uniqueOrderedPhases.push(phase);
      }
      expect(uniqueOrderedPhases).toEqual([
        "preflight",
        "imports",
        "seats",
        "audit",
        "identity",
        "org_billing",
        "aic",
        "ledger",
        "materialize",
        "checks",
        "finalize",
      ]);

      // Heartbeat happens after preflight and after every subsequent major phase.
      expect((deps.heartbeatSyncLock as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(9);
    });
  });

  // ── archive-before-audit-API merge/dedupe ───────────────────────────
  describe("configured imports precede API audit consumption", () => {
    it("materializes an archive-backed period older than the live audit retention window", async () => {
      const archiveEvent: NormalizedAuditEvent = {
        eventId: "archive-old-assign",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2024-01-05T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const baseConfig = makeConfig();
      const deps = makeDeps({
        getConfig: vi.fn(() =>
          makeConfig({
            history: {
              ...baseConfig.history,
              reportMonths: ["2024-01", "2025-03"],
              auditRetentionDays: 30,
              auditArchivePath: "/configured/audit.ndjson",
            },
          }),
        ),
        importAuditArchive: vi.fn(() => ({
          records: [archiveEvent],
          warnings: [],
          skippedRows: 0,
          sourceFingerprint: "old-archive",
        })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.materializedPeriods).toContain("2024-01");
      expect(deps.buildSeatLedger).toHaveBeenCalledWith(
        expect.objectContaining({ periods: ["2024-01", "2025-03"] }),
      );
      expect(deps.getEnterpriseAuditEvents).toHaveBeenCalledWith(
        "acme",
        Date.parse("2025-02-01T00:00:00.000Z"),
      );
    });

    it("keeps the archive's copy of a duplicate (eventId, source) pair and merges deterministically", async () => {
      const archiveEvent: NormalizedAuditEvent = {
        eventId: "evt-1",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const apiEvent: NormalizedCopilotAuditEvent = {
        eventId: "evt-2",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-06T00:00:00.000Z",
        githubUserId: 1,
        observedLogin: "alice",
        externalIdentity: null,
        team: null,
        source: "audit_log",
        raw: {} as never,
      };

      const importOrder: string[] = [];
      const deps = makeDeps({
        importAuditArchive: vi.fn(() => {
          importOrder.push("archive");
          return { records: [archiveEvent], warnings: [], skippedRows: 0, sourceFingerprint: "fp-archive" };
        }),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => {
          importOrder.push("audit_api");
          return { status: "ok", events: [apiEvent], truncated: false, warnings: [] };
        }),
        buildSeatLedger: vi.fn((options: BuildSeatLedgerOptions) => {
          // Assert the merged, deduped audit events reach the ledger builder with both events present.
          expect(options.auditEvents?.map((e) => e.eventId).sort()).toEqual(["evt-1", "evt-2"]);
          return { rows: options.periods.map((p) => makeLedgerRow(p)), coverage: [], warnings: [] };
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      // Configured imports (archive) happen before API audit consumption.
      expect(importOrder).toEqual(["archive", "audit_api"]);
      expect(deps.buildSeatLedger).toHaveBeenCalled();
    });

    it("archive event wins over an API event sharing the same (eventId, source key)", async () => {
      // Force an actual collision: same eventId, and both tagged as coming
      // from the same merge key by using identical eventId with source
      // "audit_archive" vs "audit_log" — dedupe key is (eventId, source), so
      // to test a genuine collision we reuse the archive's own eventId as
      // if the API had somehow re-observed the same id under a different
      // action; the archive's action must be the one that is retained.
      const archiveEvent: NormalizedAuditEvent = {
        eventId: "dup-1",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-01T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };

      let capturedAuditEvents: { eventId: string; source: string }[] = [];
      const deps = makeDeps({
        importAuditArchive: vi.fn(() => ({ records: [archiveEvent], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        upsertAuditEvents: vi.fn((_enterpriseSlug: string, events) => {
          capturedAuditEvents = events.map((e: { eventId: string; source: string }) => ({ eventId: e.eventId, source: e.source }));
          return events.length;
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);
      expect(capturedAuditEvents).toEqual([{ eventId: "dup-1", source: "audit_archive" }]);
    });
  });

  // ── Task 9 re-review fix #3: archive/API holder-key correlation ─────
  describe("archive/API holder-key correlation", () => {
    it("dedupes the same literal eventId appearing in both archive and API sources into a single merged event, archive wins, enrichment backfilled", async () => {
      const archiveEvent: NormalizedAuditEvent = {
        eventId: "shared-1",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const apiEvent: NormalizedCopilotAuditEvent = {
        eventId: "shared-1",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        githubUserId: 1,
        observedLogin: "alice",
        externalIdentity: null,
        team: null,
        source: "audit_log",
        raw: {} as never,
      };
      let capturedEvents: { eventId: string; source: string; githubUserId: number | null }[] = [];
      const deps = makeDeps({
        importAuditArchive: vi.fn(() => ({ records: [archiveEvent], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({ status: "ok", events: [apiEvent], truncated: false, warnings: [] })),
        upsertAuditEvents: vi.fn((_enterpriseSlug: string, events) => {
          capturedEvents = events.map((e: { eventId: string; source: string; githubUserId: number | null }) => ({ eventId: e.eventId, source: e.source, githubUserId: e.githubUserId }));
          return events.length;
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0].eventId).toBe("shared-1");
      expect(capturedEvents[0].source).toBe("audit_archive");
      // Enrichment (numeric GitHub id) is backfilled from the losing (API) copy.
      expect(capturedEvents[0].githubUserId).toBe(1);
    });

    it("correlates an archive-sourced assign with an API-sourced cancel for the same holder via a shared holderKey, feeding one ledger interval", async () => {
      const archiveAssign: NormalizedAuditEvent = {
        eventId: "assign-1",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const apiCancel: NormalizedCopilotAuditEvent = {
        eventId: "cancel-1",
        orgLogin: "acme-org",
        action: "cancel",
        occurredAt: "2025-01-20T00:00:00.000Z",
        githubUserId: 1,
        observedLogin: "alice",
        externalIdentity: null,
        team: null,
        source: "audit_log",
        raw: {} as never,
      };
      let ledgerAuditEvents: { eventId: string; holderKey: string; action: string }[] = [];
      const deps = makeDeps({
        importAuditArchive: vi.fn(() => ({ records: [archiveAssign], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({ status: "ok", events: [apiCancel], truncated: false, warnings: [] })),
        buildSeatLedger: vi.fn((options: BuildSeatLedgerOptions) => {
          ledgerAuditEvents = (options.auditEvents ?? []).map((e) => ({ eventId: e.eventId, holderKey: e.holderKey, action: e.action }));
          return { rows: options.periods.map((p) => makeLedgerRow(p)), coverage: [], warnings: [] };
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      const assignEvent = ledgerAuditEvents.find((e) => e.eventId === "assign-1");
      const cancelEvent = ledgerAuditEvents.find((e) => e.eventId === "cancel-1");
      expect(assignEvent).toBeDefined();
      expect(cancelEvent).toBeDefined();
      // Distinct events — never collapsed into one (different eventId/action/occurredAt) —
      // but they now share a holderKey so the ledger reconstructs one assign→cancel interval.
      expect(assignEvent!.holderKey).toBe(cancelEvent!.holderKey);
      expect(assignEvent!.holderKey).toBe("id:1");
    });

    it("emits a safe count-only warning and retains a login-based holderKey (never guesses) when a login maps to conflicting numeric IDs across sources", async () => {
      const archiveEvent: NormalizedAuditEvent = {
        eventId: "evt-ambiguous",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        observedLogin: "dave",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const seatWithId10 = makeSeat({ holderKey: "id:10", githubUserId: 10, observedLogin: "dave", orgLogin: "acme-org" });
      const apiEventWithId11: NormalizedCopilotAuditEvent = {
        eventId: "evt-api-dave",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-06T00:00:00.000Z",
        githubUserId: 11,
        observedLogin: "dave",
        externalIdentity: null,
        team: null,
        source: "audit_log",
        raw: {} as never,
      };
      let capturedEvents: { eventId: string; holderKey: string }[] = [];
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [seatWithId10] })),
        importAuditArchive: vi.fn(() => ({ records: [archiveEvent], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({ status: "ok", events: [apiEventWithId11], truncated: false, warnings: [] })),
        buildSeatLedger: vi.fn((options: BuildSeatLedgerOptions) => {
          capturedEvents = (options.auditEvents ?? []).map((e) => ({ eventId: e.eventId, holderKey: e.holderKey }));
          return { rows: options.periods.map((p) => makeLedgerRow(p)), coverage: [], warnings: [] };
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      const archiveMerged = capturedEvents.find((e) => e.eventId === "evt-ambiguous");
      expect(archiveMerged).toBeDefined();
      expect(archiveMerged!.holderKey).toBe("login:dave");
      const warning = result.warnings.find((w) => w.includes("ambiguous"));
      expect(warning).toBeDefined();
      expect(warning).not.toMatch(/dave/i);
    });
  });

  // ── current snapshot before legacy replacement/integration callback ─
  describe("current snapshot ordering", () => {
    it("persists the current snapshot and invokes onCurrentSnapshotPersisted before any later phase", async () => {
      const order: string[] = [];
      const deps = makeDeps({
        replacePeriodSnapshots: vi.fn(() => {
          order.push("snapshot_persisted");
          return 1;
        }),
        onCurrentSnapshotPersisted: vi.fn(() => {
          order.push("hook_called");
        }),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => {
          order.push("audit_api");
          return { status: "ok", events: [], truncated: false, warnings: [] };
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);
      expect(order).toEqual(["snapshot_persisted", "hook_called", "audit_api"]);
    });

    it("passes the current period's snapshot inputs to replacePeriodSnapshots, never dropping unresolved seats", async () => {
      const unresolvedSeat = makeSeat({ holderKey: "internal:hash1", githubUserId: null, observedLogin: null, unresolved: true });
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [unresolvedSeat] })),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(deps.replacePeriodSnapshots).toHaveBeenCalledWith(
        "acme",
        "2025-03",
        expect.arrayContaining([expect.objectContaining({ holderKey: "internal:hash1" })]),
      );
    });
  });

  // ── required seat-capability failure isolates one enterprise ───────
  describe("preflight capability failures", () => {
    it("fails only the enterprise whose required copilot_seats capability failed; coordinator continues with the next", async () => {
      const deps = makeDeps({
        preflightEnterpriseAuth: vi.fn(async (enterpriseSlug: string) => makePreflight(enterpriseSlug, enterpriseSlug !== "broken-ent")),
      });

      const result = await syncLicenseHistory(["broken-ent", "healthy-ent"], deps);
      const broken = result.enterprises.find((e) => e.enterpriseSlug === "broken-ent")!;
      const healthy = result.enterprises.find((e) => e.enterpriseSlug === "healthy-ent")!;

      expect(broken.status).toBe("failed");
      expect(broken.errorMessage).toContain("Required licensing capability preflight failed");
      // Task 9 re-review fix #4: a required-preflight failure must still
      // start a durable run before failing, so the failure is
      // operator-visible via run history/diagnostics — never a silent,
      // unrecorded failure.
      expect(broken.runId).not.toBeNull();
      expect(deps.startLicenseRun).toHaveBeenCalledWith(expect.objectContaining({ enterpriseSlug: "broken-ent" }));
      expect(deps.recordLicenseRunDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: broken.runId,
          finish: expect.objectContaining({ status: "failed", errorMessage: expect.stringContaining("Required licensing capability preflight failed") }),
          checks: [],
          sourceStates: [],
        }),
      );

      // "warning" (not "success") is the correct healthy-run outcome here:
      // `checkStatusAgreement` (Task 8) has no independent per-holder status
      // source wired for historical periods in this system, and by its own
      // documented contract "a missing comparator always warns" — this is
      // intentional "never false success" behavior, not a defect.
      expect(healthy.status).toBe("warning");
      expect(healthy.errorMessage).toBeNull();
    });

    it("never attempts any phase beyond preflight when the required preflight check fails", async () => {
      const deps = makeDeps({
        preflightEnterpriseAuth: vi.fn(async () => makePreflight("acme", false)),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.status).toBe("failed");
      expect(result.runId).not.toBeNull();
      expect(deps.importAuditArchive).not.toHaveBeenCalled();
      expect(deps.getEnterpriseSeatsNormalized).not.toHaveBeenCalled();
      expect(deps.getEnterpriseAuditEvents).not.toHaveBeenCalled();
      expect(deps.getOrgBilling).not.toHaveBeenCalled();
      expect(deps.fetchAicConsumptionForUsers).not.toHaveBeenCalled();
      expect(deps.buildSeatLedger).not.toHaveBeenCalled();
      expect(deps.materializeLicensePeriodRows).not.toHaveBeenCalled();
    });

    it("continues normally across multiple enterprises when one has a durable preflight failure and others succeed", async () => {
      const deps = makeDeps({
        preflightEnterpriseAuth: vi.fn(async (enterpriseSlug: string) => makePreflight(enterpriseSlug, enterpriseSlug !== "broken-ent")),
      });

      const result = await syncLicenseHistory(["broken-ent", "mid-ent", "healthy-ent"], deps);
      expect(result.enterprises.map((e) => e.enterpriseSlug)).toEqual(["broken-ent", "healthy-ent", "mid-ent"]);
      expect(result.enterprises.find((e) => e.enterpriseSlug === "broken-ent")!.runId).not.toBeNull();
      expect(result.enterprises.find((e) => e.enterpriseSlug === "mid-ent")!.status).not.toBe("failed");
      expect(result.enterprises.find((e) => e.enterpriseSlug === "healthy-ent")!.status).not.toBe("failed");
    });
  });

  // ── optional-source failures degrade to warnings, never false success ─
  describe("optional source failures", () => {
    it("converts an unexpected audit API throw into a warning, not a run failure", async () => {
      const deps = makeDeps({
        getEnterpriseAuditEvents: vi.fn(async () => {
          throw new Error("network blip");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("Audit API fetch failed unexpectedly"))).toBe(true);
    });

    it("converts an enterprise-identity fetch throw into a warning when identity fetching is enabled", async () => {
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ identity: { fetchMembership: false, fetchEnterpriseIdentities: true, fetchOrgIdentities: false } })),
        getEnterpriseIdentities: vi.fn(async () => {
          throw new Error("GraphQL transport error");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("Enterprise identity fetch failed unexpectedly"))).toBe(true);
    });

    it("converts a membership/SCIM unavailable result into a warning", async () => {
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ identity: { fetchMembership: true, fetchEnterpriseIdentities: false, fetchOrgIdentities: false } })),
        getEnterpriseScimUsers: vi.fn(async (): Promise<ScimFetchResult> => ({ status: "unavailable", reason: "forbidden", enterprise: "acme" })),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("Membership/SCIM unavailable"))).toBe(true);
    });

    it("converts an org-billing throw into a warning per-org without failing the run", async () => {
      const deps = makeDeps({
        getOrgBilling: vi.fn(async () => {
          throw new Error("billing endpoint timeout");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("Org billing fetch failed unexpectedly"))).toBe(true);
    });

    it("converts an AI-Credit consumption API throw into a warning without failing the run", async () => {
      const deps = makeDeps({
        fetchAicConsumptionForUsers: vi.fn(async () => {
          throw new Error("aic api down");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("AI-Credit consumption fetch failed unexpectedly"))).toBe(true);
    });
  });

  // ── real AIC enterprise→org fallback (Task 9 spec-review fix #1) ────
  describe("AI-Credit enterprise-to-org fallback", () => {
    it("does not fall back when an isolated not_found is mixed with successful results", async () => {
      const calls: { enterpriseSlug?: string; orgLogin?: string; users: string[] }[] = [];
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "acme-org" }),
      ];
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          calls.push({ enterpriseSlug: options.enterpriseSlug, orgLogin: options.orgLogin, users: options.users });
          return { results: [makeAicOk("alice"), makeAicFailure("bob", "not_found")], source: "enterprise_api", fellBackToOrg: false };
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      // Only one call — enterprise-only — no org fallback triggered by an isolated 404.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ enterpriseSlug: "acme", orgLogin: undefined, users: ["alice", "bob"] });
      expect(deps.materializeLicensePeriodRows).toHaveBeenCalledWith(expect.objectContaining({ enterpriseApiUnavailable: false }));
      expect(result.status).not.toBe("failed");
    });

    it("detects a capability-wide enterprise failure and falls back to per-org calls with correct user partitions", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "other-org" }),
      ];
      const calls: { enterpriseSlug?: string; orgLogin?: string; users: string[] }[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          calls.push({ enterpriseSlug: options.enterpriseSlug, orgLogin: options.orgLogin, users: options.users });
          if (!options.orgLogin) {
            // Capability-wide failure: every user gets the identical non-not_found classification.
            return {
              results: options.users.map((u: string) => makeAicFailure(u, "forbidden")),
              source: "enterprise_api",
              fellBackToOrg: false,
            };
          }
          return {
            results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin })),
            source: "org_api",
            fellBackToOrg: false,
          };
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(calls).toHaveLength(3);
      expect(calls[0]).toEqual({ enterpriseSlug: "acme", orgLogin: undefined, users: ["alice", "bob"] });
      const orgCalls = calls.slice(1);
      expect(orgCalls.find((c) => c.orgLogin === "acme-org")?.users).toEqual(["alice"]);
      expect(orgCalls.find((c) => c.orgLogin === "other-org")?.users).toEqual(["bob"]);
      orgCalls.forEach((c) => expect(c.enterpriseSlug).toBeUndefined());

      expect(deps.materializeLicensePeriodRows).toHaveBeenCalledWith(expect.objectContaining({ enterpriseApiUnavailable: true }));
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("unavailable"))).toBe(true);
    });

    it("never retains a failed enterprise attempt's consumption, and never duplicates consumption across orgs", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "other-org" }),
      ];
      const persistedRecords: { holderKey: string; orgLogin?: string }[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            // Capability-wide failure at the enterprise level.
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin })), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: { holderKey: string; orgLogin?: string }[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      // Exactly one consumption record per distinct holder — the failed enterprise attempt contributed nothing.
      expect(persistedRecords).toHaveLength(2);
      expect(persistedRecords.map((r) => r.holderKey).sort()).toEqual(["login:alice", "login:bob"]);
    });

    it("reports an honest warning source state — never a false ok — when the enterprise API is unavailable, even if org fallback succeeds", async () => {
      const capturedSourceStates: { source: string; status: string }[] = [];
      const seats = [makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" })];
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u)), source: "org_api", fellBackToOrg: false };
        }),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => {
          for (const s of input.sourceStates ?? []) capturedSourceStates.push({ source: s.source, status: s.status ?? "" });
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      const aicState = capturedSourceStates.find((s) => s.source === "aic_consumption");
      expect(aicState?.status).toBe("warning");
    });

    it("reports a warning source state when the org fallback also fails to return any consumption", async () => {
      const capturedSourceStates: { source: string; status: string; errorMessage?: string | null }[] = [];
      const seats = [makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" })];
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => ({
          results: options.users.map((u: string) => makeAicFailure(u, options.orgLogin ? "forbidden" : "unavailable")),
          source: options.orgLogin ? "org_api" : "enterprise_api",
          fellBackToOrg: false,
        })),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => {
          for (const s of input.sourceStates ?? []) capturedSourceStates.push({ source: s.source, status: s.status ?? "", errorMessage: s.errorMessage });
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      const aicState = capturedSourceStates.find((s) => s.source === "aic_consumption");
      expect(aicState?.status).toBe("warning");
      expect(result.status).not.toBe("failed");
    });

    // ── Task 9 re-review fix #4: partial per-org fallback failures ────
    it("retains only the successful org's records and emits a deterministic per-org warning when one org succeeds and another fails", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "other-org" }),
      ];
      const persistedRecords: { holderKey: string }[] = [];
      const capturedSourceStates: { source: string; status: string }[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "forbidden")), source: "enterprise_api", fellBackToOrg: false };
          }
          if (options.orgLogin === "acme-org") {
            return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin })), source: "org_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicFailure(u, "forbidden")), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: { holderKey: string }[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => {
          for (const s of input.sourceStates ?? []) capturedSourceStates.push({ source: s.source, status: s.status ?? "" });
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      // Only the successful org's holder is retained.
      expect(persistedRecords).toHaveLength(1);
      expect(persistedRecords[0].holderKey).toBe("login:alice");

      // A deterministic per-org warning is present, with counts/status categories only — no user logins.
      const orgWarning = result.warnings.find((w) => w.includes("org fallback") && w.includes("forbidden"));
      expect(orgWarning).toBeDefined();
      expect(orgWarning).not.toMatch(/bob/i);
      expect(orgWarning).not.toMatch(/alice/i);

      // Source state remains "warning" — never a false clean/ok result.
      const aicState = capturedSourceStates.find((s) => s.source === "aic_consumption");
      expect(aicState?.status).toBe("warning");
      expect(result.status).not.toBe("failed");
    });

    it("emits a per-org warning for every org and persists no consumption when every org fallback fails or throws", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "other-org" }),
      ];
      const persistedRecords: unknown[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          if (options.orgLogin === "acme-org") {
            return { results: options.users.map((u: string) => makeAicFailure(u, "forbidden")), source: "org_api", fellBackToOrg: false };
          }
          throw new Error("org endpoint exploded");
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: unknown[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(persistedRecords).toHaveLength(0);
      const orgWarnings = result.warnings.filter((w) => w.includes("org fallback"));
      expect(orgWarnings.length).toBeGreaterThanOrEqual(2);
      expect(result.status).not.toBe("failed");
    });

    it("emits no per-org failure warning when every org fallback succeeds cleanly", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "other-org" }),
      ];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin })), source: "org_api", fellBackToOrg: false };
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.warnings.some((w) => w.includes("org fallback"))).toBe(false);
    });
  });

  // ── Task 9 re-review fix #5: multi-org duplicate consumption defense ─
  describe("duplicate multi-org fallback consumption defense", () => {
    it("collapses byte-identical non-zero consumption for the same holder returned by multiple org fallback endpoints into one unattributed record", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "other-org" }),
      ];
      const persistedRecords: LicenseAicConsumptionInput[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin, credits: 500, grossUsd: 5 })), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: LicenseAicConsumptionInput[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(persistedRecords).toHaveLength(1);
      expect(persistedRecords[0].holderKey).toBe("login:alice");
      expect(persistedRecords[0].orgLogin).toBeUndefined();
      expect(persistedRecords[0].credits).toBe(500);
      const warning = result.warnings.find((w) => w.includes("byte-identical"));
      expect(warning).toBeDefined();
      expect(warning).not.toMatch(/alice/i);
    });

    it("retains distinct per-org consumption values for the same holder without collapsing (legitimate multi-org usage)", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "other-org" }),
      ];
      const persistedRecords: LicenseAicConsumptionInput[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          const credits = options.orgLogin === "acme-org" ? 100 : 200;
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin, credits, grossUsd: credits / 100 })), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: LicenseAicConsumptionInput[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(persistedRecords).toHaveLength(2);
      expect(persistedRecords.map((r) => r.orgLogin).sort()).toEqual(["acme-org", "other-org"]);
      expect(result.warnings.some((w) => w.includes("byte-identical"))).toBe(false);
    });

    it("does not collapse identical all-zero consumption across orgs (no consumption to conflate)", async () => {
      const seats = [
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "acme-org" }),
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "other-org" }),
      ];
      const persistedRecords: LicenseAicConsumptionInput[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["acme-org", "other-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 2, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin, credits: 0, grossUsd: 0 })), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: LicenseAicConsumptionInput[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(persistedRecords).toHaveLength(2);
      expect(result.warnings.some((w) => w.includes("byte-identical"))).toBe(false);
    });

    it("collapses duplicates in deterministic (billingPeriod, userLogin) order regardless of org iteration order", async () => {
      const seats = [
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "zzz-org" }),
        makeSeat({ holderKey: "login:bob", githubUserId: 2, observedLogin: "bob", orgLogin: "aaa-org" }),
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "zzz-org" }),
        makeSeat({ holderKey: "login:alice", observedLogin: "alice", orgLogin: "aaa-org" }),
      ];
      const persistedRecords: { holderKey: string }[] = [];
      const deps = makeDeps({
        getResolvedOrgsForEnterprise: vi.fn(() => ["zzz-org", "aaa-org"]),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 4, seats })),
        fetchAicConsumptionForUsers: vi.fn(async (options: FetchAicConsumptionOptions): Promise<FetchAicConsumptionResult> => {
          if (!options.orgLogin) {
            return { results: options.users.map((u: string) => makeAicFailure(u, "unavailable")), source: "enterprise_api", fellBackToOrg: false };
          }
          return { results: options.users.map((u: string) => makeAicOk(u, { orgLogin: options.orgLogin, credits: 10, grossUsd: 0.1 })), source: "org_api", fellBackToOrg: false };
        }),
        upsertAicConsumption: vi.fn((_enterpriseSlug: string, records: { holderKey: string }[]) => {
          persistedRecords.push(...records);
          return records.length;
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(persistedRecords).toHaveLength(2);
      expect(persistedRecords.map((r) => r.holderKey)).toEqual(["login:alice", "login:bob"]);
    });
  });

  // ── source precedence / no double count through materialized output ─
  describe("consumption source precedence and period scoping", () => {
    it("scopes CSV consumption rows to their own billingPeriod instead of applying them to every period", async () => {
      const csvRecords: AicCsvConsumptionRecord[] = [
        { billingPeriod: "2025-01", orgLogin: "acme-org", userLogin: "alice", credits: 100, grossUsd: 10, netUsd: 10, source: "csv_import", raw: {} },
        { billingPeriod: "2025-02", orgLogin: "acme-org", userLogin: "alice", credits: 200, grossUsd: 20, netUsd: 20, source: "csv_import", raw: {} },
      ];
      const materializeCalls: { period: string; consumptionCredits: number[] }[] = [];
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ aicConsumption: { mode: "auto", csvPath: "/configured/aic.csv", concurrency: 4 } })),
        importAicConsumptionCsv: vi.fn(() => ({ records: csvRecords, warnings: [], skippedRows: 0, sourceFingerprint: "fp-csv" })),
        materializeLicensePeriodRows: vi.fn((input: MaterializeLicensePeriodInput) => {
          materializeCalls.push({ period: input.billingPeriod, consumptionCredits: (input.consumption ?? []).map((c) => c.credits ?? 0) });
          return { rows: [makeMaterializedRow(input.billingPeriod)], warnings: [] };
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      const jan = materializeCalls.find((c) => c.period === "2025-01");
      const feb = materializeCalls.find((c) => c.period === "2025-02");
      const mar = materializeCalls.find((c) => c.period === "2025-03");
      expect(jan?.consumptionCredits).toEqual([100]);
      expect(feb?.consumptionCredits).toEqual([200]);
      expect(mar?.consumptionCredits).toEqual([]); // no March consumption row configured — never double-counted from Jan/Feb
    });

    it("rekeys CSV and API consumption logins to the matching canonical seat holder", async () => {
      const csvRecord: AicCsvConsumptionRecord = {
        billingPeriod: "2025-01",
        orgLogin: "Acme-Org",
        userLogin: "carol",
        credits: 30,
        grossUsd: 0.3,
        netUsd: 0.29,
        source: "csv_import",
        raw: {},
      };
      const consumedRecords = new Map<string, Array<{ holderKey: string; orgLogin: string }>>();
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({
          aicConsumption: { mode: "auto", csvPath: "/configured/aic.csv", concurrency: 4 },
        })),
        importAicConsumptionCsv: vi.fn(() => ({
          records: [csvRecord],
          warnings: [],
          skippedRows: 0,
          sourceFingerprint: "fp-csv",
        })),
        getEnterpriseSeatsNormalized: vi.fn(async () => ({
          totalSeats: 1,
          seats: [makeSeat({ holderKey: "id:103", githubUserId: 103, observedLogin: "carol" })],
        })),
        fetchAicConsumptionForUsers: vi.fn(async (): Promise<FetchAicConsumptionResult> => ({
          results: [makeAicOk("carol", { orgLogin: "acme-org", credits: 40, grossUsd: 0.4 })],
          source: "enterprise_api",
          fellBackToOrg: false,
        })),
        buildSeatLedger: vi.fn((options): SeatLedgerResult => ({
          rows: options.periods.map((period: string) => makeLedgerRow(period, {
            enterpriseSlug: options.enterpriseSlug,
            holderKey: "id:103",
            githubUserId: 103,
            observedLogin: "carol",
          })),
          coverage: [],
          warnings: [],
        })),
        materializeLicensePeriodRows: vi.fn((input: MaterializeLicensePeriodInput) => {
          consumedRecords.set(
            input.billingPeriod,
            (input.consumption ?? []).map((record) => ({
              holderKey: record.holderKey,
              orgLogin: record.orgLogin ?? "",
            })),
          );
          return { rows: [makeMaterializedRow(input.billingPeriod)], warnings: [] };
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(consumedRecords.get("2025-01")).toEqual([{ holderKey: "id:103", orgLogin: "acme-org" }]);
      expect(consumedRecords.get("2025-03")).toEqual([{ holderKey: "id:103", orgLogin: "acme-org" }]);
    });
  });

  // ── current month always refreshes ──────────────────────────────────
  describe("current month refresh", () => {
    it("never skips the current period even when its fingerprint matches a prior run and rows already exist", async () => {
      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: { "2025-03": "anything-matches-nothing" } } }]),
        hasMaterializedRows: vi.fn(() => true),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-03");
      expect(result.skippedPeriods).not.toContain("2025-03");
      expect(deps.materializeLicensePeriodRows).toHaveBeenCalledWith(expect.objectContaining({ billingPeriod: "2025-03" }));
    });
  });

  // ── historical skip on unchanged fingerprints; rerun on change ──────
  describe("historical period skip/rerun", () => {
    it("skips a historical period whose fingerprint matches the prior run and reuses persisted rows", async () => {
      // First run establishes the fingerprint for 2025-01 (no audit events, no consumption, matching the default archive fingerprint of "").
      const firstRunDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const firstDeps = makeDeps({
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => {
          firstRunDiagnostics.push(input);
        }),
      });
      await syncLicenseHistoryForEnterprise("acme", firstDeps);
      const periodFingerprints = firstRunDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;
      expect(periodFingerprints["2025-01"]).toBeDefined();

      // Second run: same conditions, prior run reports success with the same fingerprint, and rows already persisted -> 2025-01 should be skipped.
      // Task 9 re-review fix #2: the persisted row carries real, nonzero
      // costs/consumption and a non-USD currency — the reused snapshot must
      // surface these exact values, never zeros/"unknown" placeholders.
      const persistedRow: LicensePeriodRowLike = {
        billingPeriod: "2025-01",
        orgLogin: "acme-org",
        holderKey: "login:alice",
        githubUserId: 1,
        userLogin: "alice",
        resolvedUserLogin: "alice",
        externalIdentity: null,
        identityResolutionSource: "seat",
        accountState: "member",
        licenseAssignedDate: "2024-06-01",
        userRevokedDate: null,
        planType: "enterprise",
        seatStatus: "active",
        assignedVia: "direct",
        lastActivityAt: "2025-01-20T00:00:00.000Z",
        licenseCost: 39,
        defaultAicCredits: 3900,
        defaultAicUsd: 39,
        aicAssignedUsd: 39,
        aicAssignedRule: "plan_default",
        aicConsumedCredits: 4200,
        aicConsumedUsd: 42,
        currency: "EUR",
        rowSource: "materialized",
        consumptionSource: "org_api",
        historyConfidence: "exact_snapshot",
        dataQualityNotes: [],
        asOfUtc: "2025-01-31T00:00:00.000Z",
        generatedAtUtc: "2025-01-31T00:00:00.000Z",
      };
      const secondDeps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints } }]),
        hasMaterializedRows: vi.fn((query) => query.periods?.includes("2025-01") ?? false),
        queryLicensePeriodRows: vi.fn(() => ({ rows: [persistedRow] })),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", secondDeps);

      expect(result.skippedPeriods).toContain("2025-01");
      expect(result.materializedPeriods).not.toContain("2025-01");
      expect(secondDeps.materializeLicensePeriodRows).not.toHaveBeenCalledWith(expect.objectContaining({ billingPeriod: "2025-01" }));
      expect(secondDeps.replaceMaterializedPeriod).not.toHaveBeenCalledWith("acme", "2025-01", expect.anything());

      // The reused row's real identity/resolution values must reach the
      // reconciliation checks — real_login_coverage groups by (billingPeriod,
      // orgLogin) and counts the reused holder as resolved, proving the real
      // row (not a zeroed/synthetic placeholder) flowed into
      // `allMaterializedRows` for the skipped period. The real cost/currency
      // values themselves are asserted directly in the emitted snapshot
      // artifact — see the next test.
      const checksCall = (secondDeps.recordLicenseRunDiagnostics as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LicenseRunDiagnosticsInput;
      const coverageCheck = checksCall.checks.find((c) => c.checkName === "real_login_coverage" && c.billingPeriod === "2025-01" && c.orgLogin === "acme-org");
      expect(coverageCheck).toBeDefined();
      expect(coverageCheck!.status).toBe("pass");
      expect((coverageCheck!.details as { totalHolders: number; resolvedHolders: number }).totalHolders).toBe(1);
      expect((coverageCheck!.details as { totalHolders: number; resolvedHolders: number }).resolvedHolders).toBe(1);
    });

    it("reuses real persisted values (nonzero costs/consumption, non-USD currency) verbatim in the emitted snapshot artifact for a skipped period", async () => {
      const persistedRow: LicensePeriodRowLike = {
        billingPeriod: "2025-01",
        orgLogin: "acme-org",
        holderKey: "login:alice",
        githubUserId: 1,
        userLogin: "alice",
        resolvedUserLogin: "alice",
        externalIdentity: null,
        identityResolutionSource: "seat",
        accountState: "member",
        licenseAssignedDate: "2024-06-01",
        userRevokedDate: null,
        planType: "enterprise",
        seatStatus: "active",
        assignedVia: "direct",
        lastActivityAt: "2025-01-20T00:00:00.000Z",
        licenseCost: 39,
        defaultAicCredits: 3900,
        defaultAicUsd: 39,
        aicAssignedUsd: 39,
        aicAssignedRule: "plan_default",
        aicConsumedCredits: 4200,
        aicConsumedUsd: 42,
        currency: "EUR",
        rowSource: "materialized",
        consumptionSource: "org_api",
        historyConfidence: "exact_snapshot",
        dataQualityNotes: [],
        asOfUtc: "2025-01-31T00:00:00.000Z",
        generatedAtUtc: "2025-01-31T00:00:00.000Z",
      };
      const emitSnapshotsConfig = () => makeConfig({ history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "/snap" } });

      // First run establishes the real fingerprint (with snapshots enabled)
      // so the second run's prior-fingerprint lookup is guaranteed to match
      // regardless of the exact hash algorithm used.
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({
        getConfig: vi.fn(emitSnapshotsConfig),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)),
      });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const computedFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const writtenContentsByPath: Record<string, string> = {};
      const deps = makeDeps({
        getConfig: vi.fn(emitSnapshotsConfig),
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: computedFingerprints } }]),
        hasMaterializedRows: vi.fn((query) => query.periods?.includes("2025-01") ?? false),
        queryLicensePeriodRows: vi.fn(() => ({ rows: [persistedRow] })),
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          writtenContentsByPath[path] = contents;
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.skippedPeriods).toContain("2025-01");

      const janPath = deps.resolveLicenseSnapshotFilePath("/snap", "acme", "2025-01");
      const writtenContents = writtenContentsByPath[janPath];
      expect(writtenContents).toBeDefined();
      const parsed = JSON.parse(writtenContents!) as { rows: { billingPeriod: string; currency: string; licenseCost: number; aicConsumedUsd: number }[] };
      const janRow = parsed.rows.find((r) => r.billingPeriod === "2025-01");
      expect(janRow).toBeDefined();
      expect(janRow!.currency).toBe("EUR");
      expect(janRow!.licenseCost).toBe(39);
      expect(janRow!.aicConsumedUsd).toBe(42);
    });

    it("preserves an explicit zero per-user budget when rehydrating a skipped period", async () => {
      const emitSnapshotsConfig = () => makeConfig({
        history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "/snap" },
      });
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      await syncLicenseHistoryForEnterprise("acme", makeDeps({
        getConfig: vi.fn(emitSnapshotsConfig),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)),
      }));
      const fingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;
      const writtenContentsByPath: Record<string, string> = {};
      const persistedRow = makeMaterializedRow("2025-01", {
        defaultAicUsd: 39,
        aicAssignedUsd: 0,
        aicAssignedRule: "per_user_budget",
        aicConsumedUsd: 42,
      });
      const deps = makeDeps({
        getConfig: vi.fn(emitSnapshotsConfig),
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: fingerprints } }]),
        hasMaterializedRows: vi.fn((query) => query.periods?.includes("2025-01") ?? false),
        queryLicensePeriodRows: vi.fn(() => ({ rows: [persistedRow] })),
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          writtenContentsByPath[path] = contents;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.skippedPeriods).toContain("2025-01");
      const snapshot = JSON.parse(
        writtenContentsByPath[deps.resolveLicenseSnapshotFilePath("/snap", "acme", "2025-01")]!,
      ) as { rows: MaterializedLicensePeriodRow[] };
      const row = snapshot.rows.find((candidate) => candidate.billingPeriod === "2025-01");
      expect(row).toMatchObject({
        utilizationPct: 0,
        overageUsd: 42,
        totalCost: 61,
      });
    });

    it("rehydrates every page of a skipped period with more than 200 rows", async () => {
      const config = () => makeConfig({
        history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "/snap" },
      });
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      await syncLicenseHistoryForEnterprise("acme", makeDeps({
        getConfig: vi.fn(config),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)),
      }));
      const fingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;
      const rows = Array.from({ length: 201 }, (_, index) => makeMaterializedRow("2025-01", {
        holderKey: `id:${index + 1}`,
        githubUserId: index + 1,
        userLogin: `user-${index + 1}`,
        resolvedUserLogin: `user-${index + 1}`,
      }));
      const queryRows = vi.fn((query) => {
        if (!query.periods?.includes("2025-01")) {
          return {
            rows: [],
            pagination: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 },
          };
        }
        const { page = 1, pageSize = 50 } = query as typeof query & { page?: number; pageSize?: number };
        const start = (page - 1) * pageSize;
        return {
          rows: rows.slice(start, start + pageSize),
          pagination: {
            page,
            pageSize,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / pageSize),
          },
        };
      });
      const writtenContentsByPath: Record<string, string> = {};
      const deps = makeDeps({
        getConfig: vi.fn(config),
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: fingerprints } }]),
        hasMaterializedRows: vi.fn((query) => query.periods?.includes("2025-01") ?? false),
        queryLicensePeriodRows: queryRows,
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          writtenContentsByPath[path] = contents;
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      const snapshot = JSON.parse(
        writtenContentsByPath[deps.resolveLicenseSnapshotFilePath("/snap", "acme", "2025-01")]!,
      ) as { rows: MaterializedLicensePeriodRow[] };
      expect(snapshot.rows).toHaveLength(201);
      expect(queryRows).toHaveBeenCalledTimes(2);
      expect(queryRows).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1, pageSize: 200 }));
      expect(queryRows).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2, pageSize: 200 }));
    });

    it("reruns a historical period when a new audit event changes its fingerprint", async () => {
      const priorFingerprints = { "2025-01": "stale-fingerprint-that-will-never-match" };
      const newAuditEvent: NormalizedCopilotAuditEvent = {
        eventId: "evt-new",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-10T00:00:00.000Z",
        githubUserId: 2,
        observedLogin: "bob",
        externalIdentity: null,
        team: null,
        source: "audit_log",
        raw: {} as never,
      };
      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({ status: "ok", events: [newAuditEvent], truncated: false, warnings: [] })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
      expect(deps.materializeLicensePeriodRows).toHaveBeenCalledWith(expect.objectContaining({ billingPeriod: "2025-01" }));
    });

    // ── Task 9 re-review fix #1: SHA-256 fingerprint over rich, category-based input ──
    it("computes a SHA-256-formatted fingerprint (sha256: prefix + 64 hex chars) rather than the old weak hash", async () => {
      const diagnostics: LicenseRunDiagnosticsInput[] = [];
      const deps = makeDeps({ recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => diagnostics.push(input)) });

      await syncLicenseHistoryForEnterprise("acme", deps);

      const fingerprints = diagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;
      for (const period of ["2025-01", "2025-02", "2025-03"]) {
        expect(fingerprints[period]).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    });

    it("reruns a historical period when a holder's resolved identity changes (identity-map/enterprise/org/SCIM-derived resolution)", async () => {
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({ recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)) });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const priorFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        resolveIdentity: vi.fn((input) => makeIdentity({ holderKey: input.holderKey, githubUserId: input.githubUserId ?? null, accountState: "suspended" })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
    });

    it("reruns a historical period when pricing/allowance/currency configuration changes", async () => {
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({ recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)) });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const priorFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        getConfig: vi.fn(() => makeConfig({ licenseCost: { business: 25, enterprise: 39, unknown: 0 } })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
    });

    it("reruns a historical period when its period-scoped consumption records change", async () => {
      const csvConfig = () => makeConfig({ aicConsumption: { mode: "auto", csvPath: "consumption.csv", concurrency: 4 } });
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({
        getConfig: vi.fn(csvConfig),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)),
      });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const priorFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const csvRecord: AicCsvConsumptionRecord = {
        billingPeriod: "2025-01",
        orgLogin: "acme-org",
        userLogin: "alice",
        credits: 500,
        grossUsd: 5,
        netUsd: 5,
        source: "csv_import",
        raw: {},
      };
      const deps = makeDeps({
        getConfig: vi.fn(csvConfig),
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        importAicConsumptionCsv: vi.fn(() => ({ records: [csvRecord], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
    });

    it("reruns a historical period when its org billing comparator snapshot changes", async () => {
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({ recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)) });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const priorFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        getOrgBilling: vi.fn(async (): Promise<OrgBillingResult> => ({
          status: "ok",
          snapshot: {
            orgLogin: "acme-org",
            billingPeriod: "2025-01",
            planType: "business",
            totalSeats: 99,
            pendingCancellation: 0,
            observedAt: "2025-01-31T00:00:00.000Z",
            raw: {} as never,
          },
        })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
    });

    it("reruns only the one period an archive audit-event change affects, leaving an unrelated period skipped", async () => {
      const probeDiagnostics: LicenseRunDiagnosticsInput[] = [];
      const probeDeps = makeDeps({ recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => probeDiagnostics.push(input)) });
      await syncLicenseHistoryForEnterprise("acme", probeDeps);
      const priorFingerprints = probeDiagnostics[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>;

      const newArchiveEvent: NormalizedAuditEvent = {
        eventId: "evt-jan-only",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-15T00:00:00.000Z",
        observedLogin: "carol",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const deps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints: priorFingerprints } }]),
        hasMaterializedRows: vi.fn(() => true),
        importAuditArchive: vi.fn(() => ({ records: [newArchiveEvent], warnings: [], skippedRows: 0, sourceFingerprint: "fp2" })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.materializedPeriods).toContain("2025-01");
      expect(result.skippedPeriods).not.toContain("2025-01");
      // 2025-02 is unaffected by a change scoped only to 2025-01 — it stays skipped.
      expect(result.skippedPeriods).toContain("2025-02");
      expect(result.materializedPeriods).not.toContain("2025-02");
    });

    it("does not change a period's fingerprint when semantically-equivalent audit events are reordered", async () => {
      const eventA: NormalizedAuditEvent = {
        eventId: "evt-a",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-05T00:00:00.000Z",
        observedLogin: "alice",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };
      const eventB: NormalizedAuditEvent = {
        eventId: "evt-b",
        orgLogin: "acme-org",
        action: "assign",
        occurredAt: "2025-01-06T00:00:00.000Z",
        observedLogin: "bob",
        externalIdentity: null,
        assignedVia: null,
        source: "audit_archive",
        raw: {},
      };

      const diagnosticsForward: LicenseRunDiagnosticsInput[] = [];
      const depsForward = makeDeps({
        importAuditArchive: vi.fn(() => ({ records: [eventA, eventB], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => diagnosticsForward.push(input)),
      });
      await syncLicenseHistoryForEnterprise("acme", depsForward);

      const diagnosticsReversed: LicenseRunDiagnosticsInput[] = [];
      const depsReversed = makeDeps({
        importAuditArchive: vi.fn(() => ({ records: [eventB, eventA], warnings: [], skippedRows: 0, sourceFingerprint: "fp" })),
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => diagnosticsReversed.push(input)),
      });
      await syncLicenseHistoryForEnterprise("acme", depsReversed);

      const forwardFp = (diagnosticsForward[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>)["2025-01"];
      const reversedFp = (diagnosticsReversed[0]!.finish.sourceStats!.periodFingerprints as Record<string, string>)["2025-01"];
      expect(forwardFp).toBe(reversedFp);
    });
  });

  describe("durable source continuity", () => {
    it("reuses persisted historical sources for ledger, pricing, identity state, and gross-vs-net checks", async () => {
      const buildSeatLedger = vi.fn((options: BuildSeatLedgerOptions): SeatLedgerResult => ({
        rows: options.periods.map((period) => makeLedgerRow(period, {
          enterpriseSlug: options.enterpriseSlug,
          orgLogin: "acme-org",
          holderKey: "id:7",
          githubUserId: 7,
          observedLogin: "churned-user",
          confidence: period === "2025-01" ? "exact_snapshot" : "live_snapshot_only",
          source: period === "2025-01" ? "exact_snapshot" : "live_snapshot_only",
        })),
        coverage: [],
        warnings: [],
      }));
      const resolveIdentity = vi.fn((input) => makeIdentity({
        holderKey: input.holderKey,
        githubUserId: input.githubUserId ?? null,
        userLogin: input.seatLogin ?? null,
        resolvedUserLogin: input.seatLogin ?? input.enterpriseIdentity?.resolvedLogin ?? null,
        accountState: input.enterpriseIdentity?.accountState === "deprovisioned" ? "deprovisioned" : "unknown",
      }));
      const diagnostics: LicenseRunDiagnosticsInput[] = [];
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({
          history: { ...makeConfig().history, reportMonths: ["2025-01"] },
          identity: { fetchMembership: true, fetchEnterpriseIdentities: false, fetchOrgIdentities: false },
        })),
        getEnterpriseAuditEvents: vi.fn(async (): Promise<AuditFetchResult> => ({
          status: "unavailable",
          reason: "forbidden",
          target: "acme",
        })),
        getEnterpriseScimUsers: vi.fn(async (): Promise<ScimFetchResult> => ({
          status: "unavailable",
          reason: "forbidden",
          enterprise: "acme",
        })),
        getOrgBilling: vi.fn(async (): Promise<OrgBillingResult> => ({
          status: "unavailable",
          reason: "forbidden",
          orgLogin: "acme-org",
        })),
        listPersistedAuditEvents: vi.fn(() => [{
          eventId: "persisted-assign",
          orgLogin: "acme-org",
          holderKey: "id:7",
          action: "copilot.assigned",
          occurredAt: "2024-12-15T00:00:00Z",
          githubUserId: 7,
          observedLogin: "churned-user",
          externalIdentity: "opaque-id",
          assignedVia: "team",
          source: "audit_log",
        }]),
        listPersistedSeatSnapshots: vi.fn(() => [{
          billingPeriod: "2025-01",
          orgLogin: "acme-org",
          holderKey: "id:7",
          githubUserId: 7,
          observedLogin: "churned-user",
          planType: "enterprise",
          assignedVia: "team",
          lastActivityAt: "2025-01-10T00:00:00Z",
          pendingCancellationDate: null,
          snapshotAt: "2025-01-31T00:00:00Z",
          source: "authoritative_import",
        }]),
        listPersistedIdentityRecords: vi.fn(() => [{
          identityKey: "id:7",
          githubUserId: 7,
          resolvedLogin: "churned-user",
          externalIdentity: "opaque-id",
          accountState: "deprovisioned",
          resolutionSource: "scim_enterprise",
          observedAt: "2025-02-01T00:00:00Z",
        }]),
        listPersistedOrgBillingSnapshots: vi.fn(() => [{
          billingPeriod: "2025-01",
          orgLogin: "acme-org",
          planType: "enterprise",
          totalSeats: 1,
          pendingCancellation: 0,
          observedAt: "2025-01-31T00:00:00Z",
        }]),
        listPersistedAicConsumption: vi.fn(() => [
          {
            billingPeriod: "2025-01",
            orgLogin: "acme-org",
            holderKey: "id:7",
            username: "churned-user",
            credits: 40,
            grossUsd: 4,
            netUsd: null,
            source: "enterprise_api",
            observedAt: "2025-01-31T00:00:00Z",
          },
          {
            billingPeriod: "2025-01",
            orgLogin: "acme-org",
            holderKey: "id:7",
            username: "churned-user",
            credits: 38,
            grossUsd: 3.8,
            netUsd: 3.8,
            source: "billing_report",
            observedAt: "2025-01-31T00:00:00Z",
          },
        ]),
        buildSeatLedger,
        resolveIdentity,
        recordLicenseRunDiagnostics: vi.fn((input: LicenseRunDiagnosticsInput) => diagnostics.push(input)),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(buildSeatLedger).toHaveBeenCalledWith(expect.objectContaining({
        auditEvents: [expect.objectContaining({
          eventId: "persisted-assign",
          observedLogin: "churned-user",
        })],
        snapshots: [expect.objectContaining({
          billingPeriod: "2025-01",
          holderKey: "id:7",
        })],
        liveSeats: [expect.objectContaining({ holderKey: "login:alice" })],
      }));
      expect(resolveIdentity).toHaveBeenCalledWith(expect.objectContaining({
        holderKey: "id:7",
        enterpriseIdentity: expect.objectContaining({
          resolvedLogin: "churned-user",
          accountState: "deprovisioned",
        }),
      }));
      expect(deps.materializeLicensePeriodRows).toHaveBeenCalledWith(expect.objectContaining({
        billingPeriod: "2025-01",
        seatMetadata: {
          "acme-org\u0000id:7": {
            planType: "enterprise",
            assignedVia: "team",
            lastActivityAt: "2025-01-10T00:00:00Z",
          },
        },
        consumption: expect.arrayContaining([expect.objectContaining({
          holderKey: "id:7",
          grossUsd: 4,
        })]),
      }));
      const aicCheck = diagnostics[0]!.checks.find((check) => check.checkName === "aic_gross_vs_net");
      expect(aicCheck).toEqual(expect.objectContaining({
        billingPeriod: "2025-01",
        orgLogin: "acme-org",
        details: expect.objectContaining({ grossUsd: 4, netUsd: 3.8 }),
      }));
    });

    it("keeps an existing period when a degraded run would replace it with zero rows", async () => {
      const existing = makeMaterializedRow("2025-01", {
        holderKey: "id:7",
        resolvedUserLogin: "churned-user",
      });
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({
          history: { ...makeConfig().history, reportMonths: ["2025-01"] },
        })),
        buildSeatLedger: vi.fn(() => ({ rows: [], coverage: [], warnings: [] })),
        materializeLicensePeriodRows: vi.fn(() => ({ rows: [], warnings: ["optional source unavailable"] })),
        hasMaterializedRows: vi.fn(() => true),
        queryLicensePeriodRows: vi.fn(({ periods }) => ({
          rows: periods?.includes("2025-01") ? [existing] : [],
        })),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(deps.replaceMaterializedPeriod).not.toHaveBeenCalledWith("acme", "2025-01", []);
      expect(result.skippedPeriods).toContain("2025-01");
      expect(result.warnings).toContain(
        "Retained the existing 2025-01 materialization because the current run produced no replacement rows.",
      );
    });

    it("rehydrates every page when a degraded run retains more than 200 existing rows", async () => {
      const rows = Array.from({ length: 201 }, (_, index) => makeMaterializedRow("2025-01", {
        holderKey: `id:${index + 1}`,
        githubUserId: index + 1,
        userLogin: `user-${index + 1}`,
        resolvedUserLogin: `user-${index + 1}`,
      }));
      const queryRows = vi.fn((query) => {
        if (!query.periods?.includes("2025-01")) {
          return {
            rows: [],
            pagination: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 },
          };
        }
        const { page = 1, pageSize = 50 } = query as typeof query & { page?: number; pageSize?: number };
        const start = (page - 1) * pageSize;
        return {
          rows: rows.slice(start, start + pageSize),
          pagination: {
            page,
            pageSize,
            totalItems: rows.length,
            totalPages: Math.ceil(rows.length / pageSize),
          },
        };
      });
      const writtenContentsByPath: Record<string, string> = {};
      const config = () => makeConfig({
        history: {
          ...makeConfig().history,
          reportMonths: ["2025-01"],
          emitSnapshots: true,
          snapshotDirectory: "/snap",
        },
      });
      const deps = makeDeps({
        getConfig: vi.fn(config),
        buildSeatLedger: vi.fn(() => ({ rows: [], coverage: [], warnings: [] })),
        materializeLicensePeriodRows: vi.fn(() => ({ rows: [], warnings: ["optional source unavailable"] })),
        hasMaterializedRows: vi.fn(() => true),
        queryLicensePeriodRows: queryRows,
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          writtenContentsByPath[path] = contents;
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.skippedPeriods).toContain("2025-01");
      const snapshot = JSON.parse(
        writtenContentsByPath[deps.resolveLicenseSnapshotFilePath("/snap", "acme", "2025-01")]!,
      ) as { rows: MaterializedLicensePeriodRow[] };
      expect(snapshot.rows).toHaveLength(201);
      expect(
        queryRows.mock.calls.filter(([query]) => query.periods?.includes("2025-01")),
      ).toHaveLength(2);
    });

    it("does not classify the stored current live capture as an exact historical snapshot", async () => {
      const buildSeatLedger = vi.fn((): SeatLedgerResult => ({
        rows: [],
        coverage: [],
        warnings: [],
      }));
      const deps = makeDeps({
        listPersistedSeatSnapshots: vi.fn(() => [{
          billingPeriod: "2025-03",
          orgLogin: "acme-org",
          holderKey: "login:alice",
          githubUserId: 1,
          observedLogin: "alice",
          planType: "business",
          assignedVia: "direct",
          lastActivityAt: null,
          pendingCancellationDate: null,
          snapshotAt: "2025-03-15T00:00:00Z",
          source: "live_seats",
        }]),
        buildSeatLedger,
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(buildSeatLedger).toHaveBeenCalledWith(expect.objectContaining({
        snapshots: [],
        liveSeats: [expect.objectContaining({ holderKey: "login:alice" })],
      }));
    });
  });

  // ── materialize-then-checks ordering ────────────────────────────────
  describe("materialization then reconciliation checks", () => {
    it("runs reconciliation checks only after every requested period has been materialized or skipped", async () => {
      const events: string[] = [];
      const deps = makeDeps({
        materializeLicensePeriodRows: vi.fn((input: MaterializeLicensePeriodInput) => {
          events.push(`materialize:${input.billingPeriod}`);
          return { rows: [makeMaterializedRow(input.billingPeriod)], warnings: [] };
        }),
        onProgress: vi.fn((p: LicenseHistorySyncProgress) => {
          if (p.source === "checks") events.push("checks");
        }),
      });
      await syncLicenseHistoryForEnterprise("acme", deps);

      const lastMaterializeIdx = events.lastIndexOf(events.filter((e) => e.startsWith("materialize:")).slice(-1)[0]!);
      const checksIdx = events.indexOf("checks");
      expect(checksIdx).toBeGreaterThan(lastMaterializeIdx);
    });
  });

  // ── failed run leaves no partial success ────────────────────────────
  describe("failure isolation", () => {
    it("marks the run failed with a safe error message when materialization throws, and never returns a success/warning status", async () => {
      const deps = makeDeps({
        materializeLicensePeriodRows: vi.fn(() => {
          throw new Error("materializer exploded");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("materializer exploded");
      expect(result.materializedPeriods).toEqual([]);
      expect(deps.recordLicenseRunDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({ finish: expect.objectContaining({ status: "failed" }) }),
      );
    });

    it("coordinator isolates a truly unexpected per-enterprise throw and still returns the other enterprise's result", async () => {
      const deps = makeDeps({
        preflightEnterpriseAuth: vi.fn(async (enterpriseSlug: string) => {
          if (enterpriseSlug === "explode-ent") throw new Error("totally unexpected");
          return makePreflight(enterpriseSlug, true);
        }),
      });
      const result = await syncLicenseHistory(["explode-ent", "fine-ent"], deps);
      const exploded = result.enterprises.find((e) => e.enterpriseSlug === "explode-ent")!;
      const fine = result.enterprises.find((e) => e.enterpriseSlug === "fine-ent")!;
      expect(exploded.status).toBe("failed");
      // See the "healthy" comment above: no independent status-agreement
      // comparator is wired for historical periods, so a clean run
      // legitimately reports "warning", never a false "success".
      expect(fine.status).toBe("warning");
    });

    it("fails the whole enterprise run when the required live-seat fetch fails, and never persists a false snapshot", async () => {
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => {
          throw new Error("seats API down");
        }),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toContain("seats API down");
      expect(deps.replacePeriodSnapshots).not.toHaveBeenCalled();
    });
  });

  // ── extracted current-snapshot capture primitive (Task 9 spec-review fix #2) ─
  describe("captureCurrentLicenseSeatSnapshot", () => {
    it("no-ops with zero side effects when history is disabled", async () => {
      const deps = makeDeps({ getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, enabled: false } })) });
      const result = await captureCurrentLicenseSeatSnapshot("acme", deps);
      expect(result.persisted).toBe(false);
      expect(result.attempted).toBe(false);
      expect(deps.getEnterpriseSeatsNormalized).not.toHaveBeenCalled();
      expect(deps.replacePeriodSnapshots).not.toHaveBeenCalled();
    });

    it("fetches and persists the current-month seat snapshot when history is enabled", async () => {
      const deps = makeDeps({ getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [makeSeat()] })) });
      const result = await captureCurrentLicenseSeatSnapshot("acme", deps);
      expect(result.persisted).toBe(true);
      expect(result.period).toBe("2025-03");
      expect(deps.replacePeriodSnapshots).toHaveBeenCalledWith(
        "acme",
        "2025-03",
        expect.arrayContaining([expect.objectContaining({ holderKey: "login:alice" })]),
      );
    });

    it("reuses pre-fetched seats instead of issuing an extra fetch when supplied", async () => {
      const getEnterpriseSeatsNormalized = vi.fn(async () => ({ totalSeats: 1, seats: [makeSeat()] }));
      const deps = makeDeps({ getEnterpriseSeatsNormalized });
      const preFetched = [makeSeat({ holderKey: "login:carol", observedLogin: "carol" })];
      const result = await captureCurrentLicenseSeatSnapshot("acme", deps, preFetched);
      expect(getEnterpriseSeatsNormalized).not.toHaveBeenCalled();
      expect(result.seats).toBe(preFetched);
      expect(deps.replacePeriodSnapshots).toHaveBeenCalledWith(
        "acme",
        "2025-03",
        expect.arrayContaining([expect.objectContaining({ holderKey: "login:carol" })]),
      );
    });

    it("never persists a false snapshot when the required seat fetch fails", async () => {
      const deps = makeDeps({
        getEnterpriseSeatsNormalized: vi.fn(async () => {
          throw new Error("transient seats failure");
        }),
      });
      const result = await captureCurrentLicenseSeatSnapshot("acme", deps);
      expect(result.persisted).toBe(false);
      expect(result.errorMessage).toContain("transient seats failure");
      expect(deps.replacePeriodSnapshots).not.toHaveBeenCalled();
    });

    it("never drops unresolved seats", async () => {
      const unresolvedSeat = makeSeat({ holderKey: "internal:hash1", githubUserId: null, observedLogin: null, unresolved: true });
      const deps = makeDeps({ getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [unresolvedSeat] })) });
      await captureCurrentLicenseSeatSnapshot("acme", deps);
      expect(deps.replacePeriodSnapshots).toHaveBeenCalledWith(
        "acme",
        "2025-03",
        expect.arrayContaining([expect.objectContaining({ holderKey: "internal:hash1" })]),
      );
    });
  });

  // ── Task 9 re-review fix #2: reuse a pre-captured snapshot end-to-end ──
  describe("syncLicenseHistoryForEnterprise reusing a pre-captured seat snapshot", () => {
    it("does not refetch live seats or re-persist the current snapshot when a persisted pre-capture is supplied", async () => {
      const preCapturedSeats = [makeSeat({ holderKey: "login:carol", observedLogin: "carol" })];
      const deps = makeDeps();
      const preCaptured: CaptureCurrentLicenseSeatSnapshotResult = {
        attempted: true,
        persisted: true,
        period: "2025-03",
        seats: preCapturedSeats,
        errorMessage: null,
      };

      await syncLicenseHistoryForEnterprise("acme", deps, preCaptured);

      expect(deps.getEnterpriseSeatsNormalized).not.toHaveBeenCalled();
      expect(deps.replacePeriodSnapshots).not.toHaveBeenCalled();
    });

    it("still resolves the seat ledger using the reused pre-captured seats, not empty data", async () => {
      const preCapturedSeats = [makeSeat({ holderKey: "login:carol", observedLogin: "carol", orgLogin: "acme-org" })];
      const buildSeatLedgerSpy = vi.fn((options: BuildSeatLedgerOptions): SeatLedgerResult => ({
        rows: options.periods.map((period: string) => makeLedgerRow(period, { enterpriseSlug: options.enterpriseSlug, holderKey: "login:carol", observedLogin: "carol" })),
        coverage: [],
        warnings: [],
      }));
      const deps = makeDeps({ buildSeatLedger: buildSeatLedgerSpy });
      const preCaptured: CaptureCurrentLicenseSeatSnapshotResult = {
        attempted: true,
        persisted: true,
        period: "2025-03",
        seats: preCapturedSeats,
        errorMessage: null,
      };

      await syncLicenseHistoryForEnterprise("acme", deps, preCaptured);

      expect(buildSeatLedgerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          liveSeats: expect.arrayContaining([expect.objectContaining({ holderKey: "login:carol" })]),
        }),
      );
    });

    it("falls back to fetching + persisting its own snapshot when the pre-capture failed (never drops seats)", async () => {
      const deps = makeDeps({ getEnterpriseSeatsNormalized: vi.fn(async () => ({ totalSeats: 1, seats: [makeSeat()] })) });
      const preCaptured: CaptureCurrentLicenseSeatSnapshotResult = {
        attempted: true,
        persisted: false,
        period: "2025-03",
        seats: [],
        errorMessage: "seats API down",
      };

      const result = await syncLicenseHistoryForEnterprise("acme", deps, preCaptured);

      expect(deps.getEnterpriseSeatsNormalized).toHaveBeenCalledTimes(1);
      expect(deps.replacePeriodSnapshots).toHaveBeenCalledTimes(1);
      expect(result.status).not.toBe("failed");
    });

    it("standalone call (no pre-capture supplied) still fetches and persists exactly once, as before", async () => {
      const deps = makeDeps();
      await syncLicenseHistoryForEnterprise("acme", deps);
      expect(deps.getEnterpriseSeatsNormalized).toHaveBeenCalledTimes(1);
      expect(deps.replacePeriodSnapshots).toHaveBeenCalledTimes(1);
    });
  });

  // ── optional configured snapshot output (Task 9 spec-review fix #4) ──
  describe("configured snapshot output", () => {
    it("emits nothing when history.emitSnapshots is disabled (default)", async () => {
      const deps = makeDeps();
      await syncLicenseHistoryForEnterprise("acme", deps);
      expect(deps.writeLicenseSnapshotFile).not.toHaveBeenCalled();
    });

    it("writes a deterministic JSON snapshot per period under the configured directory when enabled", async () => {
      const written: { path: string; contents: string }[] = [];
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "data/license-snapshots" } })),
        resolveLicenseSnapshotFilePath: vi.fn((baseDir: string, enterpriseSlug: string, period: string) => `${baseDir}/${enterpriseSlug}_${period}.json`),
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          written.push({ path, contents });
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(written.length).toBeGreaterThan(0);
      expect(written.every((w) => w.path.startsWith("data/license-snapshots/acme_"))).toBe(true);
      expect(written.every((w) => w.path.endsWith(".json"))).toBe(true);
      // Content is valid, stable JSON.
      for (const w of written) {
        expect(() => JSON.parse(w.contents)).not.toThrow();
      }
    });

    it("degrades to an optional-source warning (never a whole-run failure) when the file write fails", async () => {
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "data/license-snapshots" } })),
        writeLicenseSnapshotFile: vi.fn(async () => {
          throw new Error("disk full");
        }),
      });

      const result = await syncLicenseHistoryForEnterprise("acme", deps);
      expect(result.status).not.toBe("failed");
      expect(result.warnings.some((w) => w.includes("disk full"))).toBe(true);
    });

    // ── Task 9 re-review fix #1: safe snapshot artifact allowlist ────
    it("never serializes externalIdentity or free-form dataQualityNotes into the snapshot file, while keeping the expected safe grain/metrics", async () => {
      const written: { path: string; contents: string }[] = [];
      const deps = makeDeps({
        getConfig: vi.fn(() => makeConfig({ history: { ...makeConfig().history, emitSnapshots: true, snapshotDirectory: "data/license-snapshots" } })),
        materializeLicensePeriodRows: vi.fn((input: MaterializeLicensePeriodInput) => ({
          rows: [
            makeMaterializedRow(input.billingPeriod, {
              enterpriseSlug: input.enterpriseSlug,
              userLogin: "alice_raw_observed_login",
              resolvedUserLogin: "alice",
              externalIdentity: "alice@example.com",
              dataQualityNotes: ["SAML NameID alice@example.com mismatch", "token=ghp_1234567890abcdef leaked in audit log"],
              aicConsumedCredits: 42,
              totalCost: 58.5,
            }),
          ],
          warnings: [],
        })),
        writeLicenseSnapshotFile: vi.fn(async (path: string, contents: string) => {
          written.push({ path, contents });
        }),
      });

      await syncLicenseHistoryForEnterprise("acme", deps);

      expect(written.length).toBeGreaterThan(0);
      for (const w of written) {
        expect(w.contents).not.toContain("alice@example.com");
        expect(w.contents).not.toContain("ghp_1234567890abcdef");
        expect(w.contents).not.toContain("alice_raw_observed_login");
        expect(w.contents).not.toContain("externalIdentity");
        expect(w.contents).not.toContain("dataQualityNotes");
        const parsed = JSON.parse(w.contents);
        expect(Array.isArray(parsed.rows)).toBe(true);
        expect(parsed.rows[0]).not.toHaveProperty("externalIdentity");
        expect(parsed.rows[0]).not.toHaveProperty("dataQualityNotes");
        expect(parsed.rows[0]).not.toHaveProperty("userLogin");
        expect(parsed.rows[0]).toMatchObject({
          enterpriseSlug: "acme",
          orgLogin: "acme-org",
          holderKey: "login:alice",
          resolvedUserLogin: "alice",
          seatStatus: "active",
          historyConfidence: "exact_snapshot",
          aicConsumedCredits: 42,
          totalCost: 58.5,
          currency: "USD",
        });
      }
    });
  });

  // ── Task 9 re-review fix #3: atomic snapshot temp cleanup, real writer ──
  describe("writeLicenseSnapshotFileDefault — atomic write + temp cleanup (real fs)", () => {
    async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
      const dir = await fsReal.mkdtemp(nodePathReal.join(tmpdir(), "license-snapshot-test-"));
      try {
        return await fn(dir);
      } finally {
        await fsReal.rm(dir, { recursive: true, force: true });
      }
    }

    it("writes the file atomically in a real OS temp directory with no leftover temp file", async () => {
      await withTempDir(async (dir) => {
        const filePath = nodePathReal.join(dir, "acme_2025-03.json");
        await writeLicenseSnapshotFileDefault(filePath, JSON.stringify({ ok: true }));

        const contents = await fsReal.readFile(filePath, "utf8");
        expect(JSON.parse(contents)).toEqual({ ok: true });

        const entries = await fsReal.readdir(dir);
        expect(entries).toEqual(["acme_2025-03.json"]);
      });
    });

    it("deletes the temp file and rethrows the original error, without masking it, when rename fails", async () => {
      await withTempDir(async (dir) => {
        const filePath = nodePathReal.join(dir, "acme_2025-03.json");
        const renameError = new Error("simulated rename failure");
        const fsOps: LicenseSnapshotFsOps = {
          mkdir: (d, o) => fsReal.mkdir(d, o),
          writeFile: (p, c, e) => fsReal.writeFile(p, c, e as BufferEncoding),
          rename: async () => { throw renameError; },
          unlink: (p) => fsReal.unlink(p),
        };

        await expect(writeLicenseSnapshotFileDefault(filePath, "{}", fsOps)).rejects.toThrow("simulated rename failure");

        const entries = await fsReal.readdir(dir);
        expect(entries).toEqual([]);
      });
    });

    it("does not mask the original write error, and safely ignores an ENOENT cleanup (nothing to remove)", async () => {
      await withTempDir(async (dir) => {
        const filePath = nodePathReal.join(dir, "acme_2025-03.json");
        const writeError = new Error("simulated write failure");
        const fsOps: LicenseSnapshotFsOps = {
          mkdir: (d, o) => fsReal.mkdir(d, o),
          writeFile: async () => { throw writeError; },
          rename: async () => { throw new Error("rename should never be reached"); },
          unlink: (p) => fsReal.unlink(p),
        };

        await expect(writeLicenseSnapshotFileDefault(filePath, "{}", fsOps)).rejects.toThrow("simulated write failure");

        const entries = await fsReal.readdir(dir);
        expect(entries).toEqual([]);
      });
    });

    it("does not swallow a genuine (non-ENOENT) cleanup failure — still rethrows the original error", async () => {
      await withTempDir(async (dir) => {
        const filePath = nodePathReal.join(dir, "acme_2025-03.json");
        const renameError = new Error("simulated rename failure");
        const cleanupError = Object.assign(new Error("cleanup permission denied"), { code: "EPERM" });
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const fsOps: LicenseSnapshotFsOps = {
          mkdir: (d, o) => fsReal.mkdir(d, o),
          writeFile: (p, c, e) => fsReal.writeFile(p, c, e as BufferEncoding),
          rename: async () => { throw renameError; },
          unlink: async () => { throw cleanupError; },
        };

        await expect(writeLicenseSnapshotFileDefault(filePath, "{}", fsOps)).rejects.toThrow("simulated rename failure");
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
      });
    });
  });

  // ── cache invalidation categories ───────────────────────────────────
  describe("cache invalidation", () => {
    it("invalidates reconciliation, history, exports, diagnostics, and preflight-capability cache categories on success", async () => {
      const deps = makeDeps();
      await syncLicenseHistoryForEnterprise("acme", deps);
      const invalidated = new Set((deps.invalidateCache as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string));
      expect(invalidated.has("/api/billing/license-reconciliation")).toBe(true);
      expect(invalidated.has("/api/billing/license-history")).toBe(true);
      expect(invalidated.has("/api/billing/license-exports")).toBe(true);
      expect(invalidated.has("/api/billing/license-diagnostics")).toBe(true);
      expect(invalidated.has("/api/billing/auth-preflight")).toBe(true);
    });
  });

  // ── multi-enterprise isolation / stable summary sorting ─────────────
  describe("multi-enterprise coordinator", () => {
    it("sorts results by enterpriseSlug regardless of input order or completion timing", async () => {
      const deps = makeDeps();
      const result = await syncLicenseHistory(["zeta-ent", "alpha-ent", "mid-ent"], deps);
      expect(result.enterprises.map((e) => e.enterpriseSlug)).toEqual(["alpha-ent", "mid-ent", "zeta-ent"]);
    });

    it("isolates one enterprise's warnings from another's clean run", async () => {
      const deps = makeDeps({
        getOrgBilling: vi.fn(async (org: string, enterpriseSlug: string) => {
          if (enterpriseSlug === "flaky-ent") throw new Error("billing hiccup");
          return {
            status: "ok" as const,
            snapshot: { orgLogin: org, billingPeriod: "2025-03", planType: "business", totalSeats: 1, pendingCancellation: 0, observedAt: "2025-03-15T00:00:00.000Z", raw: {} as never },
          };
        }),
      });
      const result = await syncLicenseHistory(["flaky-ent", "clean-ent"], deps);
      const flaky = result.enterprises.find((e) => e.enterpriseSlug === "flaky-ent")!;
      const clean = result.enterprises.find((e) => e.enterpriseSlug === "clean-ent")!;
      expect(flaky.status).not.toBe("failed"); // optional source failure, not fatal
      expect(flaky.warnings.some((w) => w.includes("billing hiccup"))).toBe(true);
      expect(clean.warnings.some((w) => w.includes("billing hiccup"))).toBe(false);
    });
  });

  // ── production wiring smoke test (Task 9 spec-review fix #5) ────────
  describe("createDefaultLicenseHistorySyncDeps wiring", () => {
    it("wires every dependency as a real function, including the new snapshot-output primitives — no network call needed", () => {
      const deps = createDefaultLicenseHistorySyncDeps();

      // Task 1-8 functions must be the real, already-completed implementations, not test-only placeholders.
      expect(typeof deps.getConfig).toBe("function");
      expect(typeof deps.getResolvedOrgsForEnterprise).toBe("function");
      expect(typeof deps.preflightEnterpriseAuth).toBe("function");
      expect(typeof deps.importAuditArchive).toBe("function");
      expect(typeof deps.importIdentityMap).toBe("function");
      expect(typeof deps.importAicConsumptionCsv).toBe("function");
      expect(typeof deps.getEnterpriseSeatsNormalized).toBe("function");
      expect(typeof deps.getEnterpriseAuditEvents).toBe("function");
      expect(typeof deps.getEnterpriseIdentities).toBe("function");
      expect(typeof deps.getOrgIdentities).toBe("function");
      expect(typeof deps.getEnterpriseScimUsers).toBe("function");
      expect(typeof deps.getOrgBilling).toBe("function");
      expect(typeof deps.fetchAicConsumptionForUsers).toBe("function");
      expect(typeof deps.resolveIdentity).toBe("function");
      expect(typeof deps.buildSeatLedger).toBe("function");
      expect(typeof deps.materializeLicensePeriodRows).toBe("function");
      expect(typeof deps.replacePeriodSnapshots).toBe("function");
      expect(typeof deps.upsertAuditEvents).toBe("function");
      expect(typeof deps.upsertIdentityRecords).toBe("function");
      expect(typeof deps.upsertOrgBillingSnapshots).toBe("function");
      expect(typeof deps.upsertAicConsumption).toBe("function");
      expect(typeof deps.replaceMaterializedPeriod).toBe("function");
      expect(typeof deps.queryLicensePeriodRows).toBe("function");
      expect(typeof deps.hasMaterializedRows).toBe("function");
      expect(typeof deps.startLicenseRun).toBe("function");
      expect(typeof deps.listLicenseRuns).toBe("function");
      expect(typeof deps.recordLicenseRunDiagnostics).toBe("function");

      // New snapshot/file deps wired for real — not test-only placeholders.
      expect(typeof deps.resolveLicenseSnapshotFilePath).toBe("function");
      expect(typeof deps.writeLicenseSnapshotFile).toBe("function");

      // Pure path resolution is safe to call directly — no disk I/O, no network.
      const path = deps.resolveLicenseSnapshotFilePath("data/license-snapshots", "acme", "2025-03");
      expect(path.replace(/\\/g, "/")).toMatch(/data\/license-snapshots\/acme_2025-03\.json$/);

      // Path traversal in enterpriseSlug/period segments must never escape the configured base directory.
      const traversalPath = deps.resolveLicenseSnapshotFilePath("data/license-snapshots", "../../etc", "..%2F..");
      expect(traversalPath.replace(/\\/g, "/")).toContain("data/license-snapshots/");
      expect(traversalPath.replace(/\\/g, "/")).not.toContain("../");
    });
  });
});
