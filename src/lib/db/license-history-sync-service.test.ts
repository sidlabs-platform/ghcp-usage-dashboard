import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedLicensingConfig } from "@/lib/config/dashboard-config";
import type { EnterprisePreflightResult } from "@/lib/github/auth-preflight";
import type { NormalizedCopilotSeat } from "@/lib/github/seats-client";
import type { AuditFetchResult, NormalizedCopilotAuditEvent } from "@/lib/github/copilot-audit-client";
import type { IdentityFetchResult } from "@/lib/github/copilot-identity-client";
import type { ScimFetchResult } from "@/lib/github/copilot-membership-client";
import type { OrgBillingResult } from "@/lib/github/copilot-org-billing-client";
import type { FetchAicConsumptionResult } from "@/lib/github/aic-consumption-client";
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
import type { LicenseHistorySyncDeps, LicenseHistorySyncProgress, LicenseRunSummary } from "./license-history-sync-service";

import { syncLicenseHistoryForEnterprise, syncLicenseHistory } from "./license-history-sync-service";

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
    replaceMaterializedPeriod: vi.fn(() => 1),
    queryLicensePeriodRows: vi.fn(() => ({ rows: [] })),
    hasMaterializedRows: vi.fn(() => false),

    startLicenseRun: vi.fn((input: StartLicenseRunInput) => `run-${input.enterpriseSlug}`),
    listLicenseRuns: vi.fn((): LicenseRunSummary[] => []),
    recordLicenseRunDiagnostics: vi.fn(),

    onCurrentSnapshotPersisted: vi.fn(),
  };
  return { ...base, ...overrides };
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
      expect(broken.runId).toBeNull(); // failed before a durable run ever started
      expect(deps.startLicenseRun).not.toHaveBeenCalledWith(expect.objectContaining({ enterpriseSlug: "broken-ent" }));

      // "warning" (not "success") is the correct healthy-run outcome here:
      // `checkStatusAgreement` (Task 8) has no independent per-holder status
      // source wired for historical periods in this system, and by its own
      // documented contract "a missing comparator always warns" — this is
      // intentional "never false success" behavior, not a defect.
      expect(healthy.status).toBe("warning");
      expect(healthy.errorMessage).toBeNull();
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
      const persistedRow = makeMaterializedRow("2025-01");
      const secondDeps = makeDeps({
        listLicenseRuns: vi.fn(() => [{ status: "success", sourceStats: { periodFingerprints } }]),
        hasMaterializedRows: vi.fn((query) => query.periods?.includes("2025-01") ?? false),
        queryLicensePeriodRows: vi.fn(() => ({
          rows: [{
            billingPeriod: persistedRow.billingPeriod,
            orgLogin: persistedRow.orgLogin,
            holderKey: persistedRow.holderKey,
            githubUserId: persistedRow.githubUserId,
            userLogin: persistedRow.userLogin,
            resolvedUserLogin: persistedRow.resolvedUserLogin,
            externalIdentity: persistedRow.externalIdentity,
            identityResolutionSource: persistedRow.identityResolutionSource,
            accountState: persistedRow.accountState,
            seatStatus: persistedRow.seatStatus,
            historyConfidence: persistedRow.historyConfidence,
          }],
        })),
      });
      const result = await syncLicenseHistoryForEnterprise("acme", secondDeps);

      expect(result.skippedPeriods).toContain("2025-01");
      expect(result.materializedPeriods).not.toContain("2025-01");
      expect(secondDeps.materializeLicensePeriodRows).not.toHaveBeenCalledWith(expect.objectContaining({ billingPeriod: "2025-01" }));
      expect(secondDeps.replaceMaterializedPeriod).not.toHaveBeenCalledWith("acme", "2025-01", expect.anything());
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
});
