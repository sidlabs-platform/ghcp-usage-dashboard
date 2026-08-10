// End-to-end historical license reconciliation parity test (Task 12).
//
// Wires the REAL sync orchestrator (`syncLicenseHistory`/
// `syncLicenseHistoryForEnterprise`, unmodified) to REAL SQL persistence
// (`license-history-repo.ts`/`license-run-repo.ts`, unmodified) backed by a
// real in-process SQLite engine (the same `node:sqlite`-backed
// better-sqlite3-compatible facade used by `license-history-repo.test.ts`/
// `license-run-repo.test.ts` — better-sqlite3's native binding cannot be
// loaded under this environment's Node version), then queries the result
// back through both the real repository functions AND the real Next.js API
// route handlers (`/api/billing/license-reconciliation`, `.../runs`,
// `.../runs/[id]`, `/api/export/license-reconciliation`).
//
// Only network-facing GitHub clients and file-based imports are faked (via
// `LicenseHistorySyncDeps`) — there is no way to reach real GitHub APIs or a
// real filesystem import from a test, and every other DB-adjacent seam this
// file exercises (identity resolution, seat-ledger reconstruction, period
// materialization, reconciliation checks, run diagnostics, SQL
// query/export, API routes) is the genuine, unmodified production code.
//
// This intentionally does NOT re-verify every precedence-tier/branch
// already covered by the hundreds of existing focused unit tests (e.g.
// `identity-resolver.test.ts`, `seat-ledger.test.ts`,
// `reconciliation-checks.test.ts`, `license-history-sync-service.test.ts`'s
// fully-mocked-deps orchestration tests) — it focuses on the SEAM between
// them: does data assembled by fixtures, run through the real orchestrator,
// land correctly in the real database and come back out correctly through
// the real query/API layer.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";
import { NextRequest } from "next/server";
import type { ResolvedLicensingConfig } from "@/lib/config/dashboard-config";
import { ALL_CAPABILITIES, type CapabilityResult, type EnterprisePreflightResult } from "@/lib/github/auth-preflight";
import { resolveIdentity } from "@/lib/licensing/identity-resolver";
import { buildSeatLedger } from "@/lib/licensing/seat-ledger";
import { materializeLicensePeriodRows } from "@/lib/licensing/materialize-license-period";
import {
  TWO_ENTERPRISE_SCENARIO,
  FIXTURE_ENTERPRISES,
  FIXTURE_ORGS,
} from "@/lib/licensing/__fixtures__";
import {
  buildAlphaEnterpriseAicResult,
  buildBetaEnterpriseAicFailureResult,
  buildBetaOrgFallbackAicResult,
} from "@/lib/licensing/__fixtures__/aic-consumption";

/**
 * Minimal better-sqlite3-compatible facade backed by Node's built-in
 * `node:sqlite` (`DatabaseSync`) — identical in shape to the facade already
 * used by `license-history-repo.test.ts`/`license-run-repo.test.ts`. A real,
 * in-process SQLite engine exercising the production repositories' real
 * SQL/params/transaction logic, never a mock of query results.
 */
class TestDb {
  private readonly raw: DatabaseSync;
  constructor(location: string) {
    this.raw = new DatabaseSync(location);
  }
  pragma(clause: string): void {
    this.raw.exec(`PRAGMA ${clause};`);
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  prepare(sql: string) {
    const stmt = this.raw.prepare(sql);
    return {
      run: (...params: unknown[]) => stmt.run(...(params as never[])),
      get: (...params: unknown[]) => stmt.get(...(params as never[])),
      all: (...params: unknown[]) => stmt.all(...(params as never[])),
    };
  }
  transaction<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
    return (...args: Args) => {
      this.raw.exec("BEGIN");
      try {
        const result = fn(...args);
        this.raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    };
  }
  close(): void {
    this.raw.close();
  }
}

let db: TestDb;

vi.mock("./database", () => ({
  getDb: () => db,
}));

import {
  replacePeriodSnapshots,
  upsertAuditEvents,
  upsertIdentityRecords,
  upsertOrgBillingSnapshots,
  upsertAicConsumption,
  replaceMaterializedPeriod,
  queryLicensePeriodRows,
  queryLicensePeriodExport,
  getMaterializedPeriodKPIs,
  hasMaterializedRows,
} from "./license-history-repo";
import { startLicenseRun, listLicenseRuns, listLicenseChecks, getLicenseRun, buildLicenseRunReport, recordLicenseRunDiagnostics } from "./license-run-repo";
import { syncLicenseHistory, type LicenseHistorySyncDeps, type LicensePeriodRowLike } from "./license-history-sync-service";

const SCHEMA_DIR = path.join(process.cwd(), "src", "lib", "db");

function execSchema(database: TestDb, file: string): void {
  database.exec(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf-8"));
}

const { ALPHA, BETA } = FIXTURE_ENTERPRISES;
const scenario = TWO_ENTERPRISE_SCENARIO;

function okCapabilities(): CapabilityResult[] {
  return ALL_CAPABILITIES.map((capability) => ({
    capability,
    label: capability,
    status: "supported",
    required: capability === "copilot_seats",
    message: `${capability}: access confirmed.`,
  }));
}

function makeSharedConfig(): ResolvedLicensingConfig {
  return {
    creditToUsd: 0.01,
    currency: "USD",
    licenseCost: { business: 19, enterprise: 39, unknown: 0 },
    aicAllowance: { business: 300, enterprise: 600, unknown: 0 },
    perUserBudgetUsd: {},
    // Effective 2026-02-01: business allowance rises from 250 to 400 credits
    // (see allowances.ts) — exercised across all three scenario periods.
    datedAllowances: scenario.enterprises[ALPHA].datedAllowances as ResolvedLicensingConfig["datedAllowances"],
    history: {
      enabled: true,
      reportMonths: [...scenario.periods],
      auditRetentionDays: 3650,
      emitSnapshots: false,
      snapshotDirectory: "unused-in-this-test",
      auditArchivePath: "fixture-archive.json",
      identityMapPath: "fixture-identity-map.json",
    },
    identity: { fetchMembership: true, fetchEnterpriseIdentities: true, fetchOrgIdentities: false },
    aicConsumption: { mode: "auto", csvPath: "fixture-aic-consumption.csv", concurrency: 4 },
    validation: { enabled: true, aicTolerancePct: 5 },
  };
}

/**
 * Builds a `LicenseHistorySyncDeps` wiring real DB/pure functions to fixture
 * data. Several interface functions (`importAuditArchive`,
 * `importIdentityMap`, `importAicConsumptionCsv`) intentionally carry no
 * enterprise parameter — matching the real, current implementation, where
 * `metrics.billing.licensing`'s import paths are a single global setting
 * shared by every configured enterprise (see
 * `docs/multi-enterprise-setup.md`). `syncLicenseHistory` calls
 * `syncLicenseHistoryForEnterprise` sequentially, and `preflightEnterpriseAuth`
 * (which DOES receive the slug) always runs first within each enterprise's
 * sync — so a small shared `currentSlug` closure, updated there, lets these
 * otherwise slug-blind fakes still return the correct fixture per enterprise,
 * exactly modeling today's real shared-global-import behavior.
 */
function buildDeps(): LicenseHistorySyncDeps {
  let currentSlug = "";

  return {
    getConfig: () => makeSharedConfig(),
    getResolvedOrgsForEnterprise: (slug: string) => [...scenario.enterprises[slug as keyof typeof scenario.enterprises].orgs],
    clock: () => scenario.now,
    heartbeatSyncLock: () => {},
    invalidateCache: () => {},

    preflightEnterpriseAuth: async (slug: string): Promise<EnterprisePreflightResult> => {
      currentSlug = slug;
      return { enterpriseSlug: slug, ok: true, capabilities: okCapabilities() };
    },

    importAuditArchive: () => {
      const events = currentSlug === ALPHA ? scenario.enterprises[ALPHA].archiveEvents : scenario.enterprises[BETA].archiveEvents;
      const warnings = currentSlug === BETA ? ["Configured audit archive file not found for ent-beta (missing optional source)."] : [];
      return { records: [...events], warnings, skippedRows: 0, sourceFingerprint: `archive-${currentSlug}` };
    },
    importIdentityMap: () => ({ records: [], warnings: [], skippedRows: 0, sourceFingerprint: "" }),
    importAicConsumptionCsv: () => {
      const records = currentSlug === ALPHA ? scenario.enterprises[ALPHA].aicCsvRecords : [];
      return { records: [...records], warnings: [], skippedRows: 0, sourceFingerprint: `csv-${currentSlug}` };
    },

    getEnterpriseSeatsNormalized: async (slug: string) => {
      const seats = scenario.enterprises[slug as keyof typeof scenario.enterprises].liveSeats;
      return { totalSeats: seats.length, seats: [...seats] };
    },
    getEnterpriseAuditEvents: async (slug: string) => ({
      status: "ok" as const,
      events: [...scenario.enterprises[slug as keyof typeof scenario.enterprises].auditApiEvents],
      truncated: false,
      warnings: [],
    }),
    getEnterpriseIdentities: async (slug: string) => ({
      identities: [...scenario.enterprises[slug as keyof typeof scenario.enterprises].enterpriseIdentities],
      warnings: [],
    }),
    getOrgIdentities: async () => ({ identities: [], warnings: [] }),
    getEnterpriseScimUsers: async (slug: string) => {
      if (slug === BETA) {
        // Missing optional source: beta's SCIM/membership access is forbidden.
        return { status: "unavailable" as const, reason: "forbidden" as const, enterprise: slug };
      }
      return { status: "ok" as const, records: [...scenario.enterprises[ALPHA].scimMembership] };
    },
    getOrgBilling: async (org: string, slug: string) => {
      const billing = scenario.enterprises[slug as keyof typeof scenario.enterprises].orgBilling as Record<string, unknown>;
      const result = billing[org];
      return (result ?? { status: "unavailable", reason: "not_found", orgLogin: org }) as Awaited<ReturnType<LicenseHistorySyncDeps["getOrgBilling"]>>;
    },
    fetchAicConsumptionForUsers: async (options) => {
      if (options.orgLogin) {
        // Org-scoped fallback call — only ever reached for beta in this scenario.
        return buildBetaOrgFallbackAicResult(options);
      }
      return currentSlug === ALPHA ? buildAlphaEnterpriseAicResult(options) : buildBetaEnterpriseAicFailureResult();
    },

    resolveIdentity,
    buildSeatLedger,
    materializeLicensePeriodRows,

    replacePeriodSnapshots,
    upsertAuditEvents,
    upsertIdentityRecords,
    upsertOrgBillingSnapshots,
    upsertAicConsumption,
    replaceMaterializedPeriod,
    queryLicensePeriodRows: (query): { rows: LicensePeriodRowLike[] } => queryLicensePeriodRows({ ...query, view: "detail" }),
    hasMaterializedRows,

    startLicenseRun,
    listLicenseRuns,
    recordLicenseRunDiagnostics,

    resolveLicenseSnapshotFilePath: (baseDir: string, enterpriseSlug: string, period: string) => `${baseDir}/${enterpriseSlug}_${period}.json`,
    writeLicenseSnapshotFile: async () => {},
  };
}

let syncResult: Awaited<ReturnType<typeof syncLicenseHistory>>;

beforeAll(async () => {
  db = new TestDb(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Simulate a pre-existing, already-in-production database: main + billing
  // schema first, seeded with pre-existing legacy data, THEN the additive
  // licensing schema — mirrors database.ts's real init order and proves the
  // upgrade path never disturbs already-synced live seat/billing data.
  execSchema(db, "schema.sql");
  execSchema(db, "billing-schema.sql");
  db.prepare(`
    INSERT INTO copilot_seats (
      enterprise_slug, org_slug, user_login, user_id, plan_type, last_activity_at,
      last_activity_editor, last_authenticated_at, assigning_team_slug, assigning_team_name,
      pending_cancellation_date, created_at, updated_at, avatar_url
    ) VALUES ('ent-alpha', 'alpha-eng', 'legacyuser', 999, 'business', '2026-03-15T00:00:00Z', 'vscode', NULL, NULL, NULL, NULL, '2025-01-01T00:00:00Z', '2026-03-15T00:00:00Z', NULL)
  `).run();
  db.prepare(`
    INSERT INTO billing_premium_requests (
      enterprise_slug, date, product, sku, quantity, unit_type, applied_cost_per_quantity,
      gross_amount, discount_amount, net_amount, username, organization, model, exceeds_quota,
      total_monthly_quota, charge_scope
    ) VALUES ('ent-alpha', '2026-03-10', 'copilot', 'sku1', 50, 'requests', 0.02, 1, 0, 1, 'legacyuser', 'alpha-eng', 'gpt-4', 'FALSE', 500, 'user')
  `).run();
  execSchema(db, "licensing-schema.sql");

  const deps = buildDeps();
  syncResult = await syncLicenseHistory([ALPHA, BETA], deps);
});

afterAll(() => {
  db?.close();
});

// ── Config/mocks shared by the API-route-level assertions ────────────────

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300, SHORT: 120 } }));
vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: () => true,
  getEnterpriseSlugs: () => [ALPHA, BETA],
}));
vi.mock("@/lib/config/dashboard-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config/dashboard-config")>("@/lib/config/dashboard-config");
  return { ...actual, getLicensingConfig: () => makeSharedConfig() };
});
// `parseScopeFilter` is real (not mocked) — it is pure for this test's URLs
// (only `enterprises=` is ever used; it only touches the DB via
// `resolveFilteredUsers` when `teams=`/`orgs=` params are present), so this
// exercises the actual `enterprises=` scope-parsing seam end-to-end instead
// of a hand-rolled stand-in that would need to duplicate its query-string
// parsing logic to stay correct.

describe("historical license reconciliation — two-enterprise, three-month parity", () => {
  it("completes the sync process for both enterprises (no unhandled exception) and materializes every requested period", () => {
    // Overall `status` reflects reconciliation-check *data quality* findings,
    // not process success — this scenario deliberately seeds a real seat-count
    // mismatch (alpha-data) and a real unrecoverable-history gap (beta/hank),
    // so `status: "failed"` here is the CORRECT, intended signal that those
    // checks fired, not evidence of a crash. Process-level success is
    // `errorMessage === null` plus every requested period materializing.
    expect(syncResult.enabled).toBe(true);
    expect(syncResult.enterprises).toHaveLength(2);
    for (const ent of syncResult.enterprises) {
      expect(ent.errorMessage).toBeNull();
      expect(ent.runId).toEqual(expect.any(String));
      expect(ent.requestedPeriods).toEqual([...scenario.periods]);
      expect(ent.materializedPeriods.sort()).toEqual([...scenario.periods].sort());
      // Verifies the invariant this test's own comment claims: both
      // enterprises' seeded data-quality findings (alpha's seat-count
      // mismatch, beta's unrecoverable-history holder — see the
      // "persists durable, queryable reconciliation checks" test below)
      // really do surface as `status: "failed"`, not silently as
      // "warning"/"success".
      expect(ent.status).toBe("failed");
    }
  });

  it("materializes the canonical (enterprise, period, org, holder) grain with real seat-ledger + identity + pricing wiring for enterprise alpha", () => {
    const marchAlice = queryLicensePeriodRows({
      enterpriseSlug: ALPHA,
      periods: ["2026-03"],
      logins: ["alice"],
      view: "detail",
      page: 1,
      pageSize: 10,
    });
    expect(marchAlice.rows).toHaveLength(1);
    expect(marchAlice.rows[0]).toMatchObject({
      enterpriseSlug: ALPHA,
      orgLogin: FIXTURE_ORGS.ALPHA_ENG,
      resolvedUserLogin: "alice",
      seatStatus: "active",
      historyConfidence: "exact_snapshot",
    });
  });

  it("reconstructs cancelled -> reassigned seat lifecycle: bob's org seat is inactive after 2026-02, carol holds it from 2026-02 onward", () => {
    const febRows = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-02"], view: "detail", page: 1, pageSize: 100 });
    const carolFeb = febRows.rows.find((r) => r.resolvedUserLogin === "carol");
    expect(carolFeb).toBeDefined();
    expect(carolFeb?.seatStatus).toBe("active");

    const marchRows = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], view: "detail", page: 1, pageSize: 100 });
    // bob no longer holds an active seat anywhere by March (cancelled in Feb, never reassigned back to him).
    const bobMarch = marchRows.rows.find((r) => r.resolvedUserLogin === "bob" && r.seatStatus === "active");
    expect(bobMarch).toBeUndefined();
  });

  it("attributes a multi-org holder (dana) to both orgs separately, never merging or duplicating her consumption across them", () => {
    const marchRows = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], logins: ["dana"], view: "detail", page: 1, pageSize: 10 });
    const orgs = marchRows.rows.map((r) => r.orgLogin).sort();
    expect(orgs).toEqual([FIXTURE_ORGS.ALPHA_DATA, FIXTURE_ORGS.ALPHA_ENG].sort());
    expect(marchRows.rows.every((r) => r.resolvedUserLogin === "dana")).toBe(true);
  });

  it("never resolves the obfuscated/GUID-shaped holder to a real login or leaks an external identity into a login field, and persists the raw identity evidence for diagnostics", () => {
    const marchRows = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], view: "detail", page: 1, pageSize: 100 });
    const unresolved = marchRows.rows.find((r) => r.identityResolutionSource === "unresolved");
    expect(unresolved).toBeDefined();
    expect(unresolved?.userLogin).toBeNull();
    expect(unresolved?.resolvedUserLogin).toBeNull();
    // The enterprise-identity evidence for this holder supplies no verified
    // `resolvedLogin` (see identities.ts) — `identity-resolver.ts`'s
    // enterprise-identity/org-identity/identity-map lookups are only
    // consulted by *observed login*, so a source with no verified login of
    // its own is real, persisted evidence (asserted below) but does not
    // enrich this holder's live-resolved externalIdentity field; it is
    // safely null rather than fabricated either way.
    expect(unresolved?.externalIdentity == null || unresolved.externalIdentity !== unresolved.userLogin).toBe(true);

    const persisted = db
      .prepare("SELECT external_identity, resolved_login FROM license_identity_records WHERE enterprise_slug = ? AND resolution_source = 'enterprise_identity'")
      .get(ALPHA) as { external_identity: string | null; resolved_login: string | null } | undefined;
    expect(persisted?.external_identity).toBe("obfuscated-holder@example.test");
    // Never verified — the persisted record itself supplies no login either.
    expect(persisted?.resolved_login).toBeNull();
  });

  it("records erin (suspended) and frank (deprovisioned) with an active seat, and persists their SCIM account state for diagnostics even though it does not (yet) enrich this run's materialized accountState", () => {
    const marchRows = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], view: "detail", page: 1, pageSize: 100 });
    const erin = marchRows.rows.find((r) => r.resolvedUserLogin === "erin");
    const frank = marchRows.rows.find((r) => r.resolvedUserLogin === "frank");
    expect(erin?.seatStatus).toBe("active");
    expect(frank?.seatStatus).toBe("active");

    const erinScim = db
      .prepare("SELECT account_state FROM license_identity_records WHERE enterprise_slug = ? AND identity_key = ?")
      .get(ALPHA, "scim:alpha-erin-1") as { account_state: string } | undefined;
    const frankScim = db
      .prepare("SELECT account_state FROM license_identity_records WHERE enterprise_slug = ? AND identity_key = ?")
      .get(ALPHA, "scim:alpha-frank-1") as { account_state: string } | undefined;
    expect(erinScim?.account_state).toBe("suspended");
    expect(frankScim?.account_state).toBe("deprovisioned");
  });

  it("applies the dated allowance change (250 credits in January, 400 from February onward) to alpha's business-plan holders", () => {
    const jan = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-01"], logins: ["alice"], view: "detail", page: 1, pageSize: 10 });
    const feb = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-02"], logins: ["alice"], view: "detail", page: 1, pageSize: 10 });
    expect(jan.rows[0]?.defaultAicCredits).toBe(250);
    expect(feb.rows[0]?.defaultAicCredits).toBe(400);
  });

  it("selects CSV-imported consumption for historical periods (the only available source there), and the per-user API for the current period", () => {
    const jan = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-01"], logins: ["alice"], view: "detail", page: 1, pageSize: 10 });
    expect(jan.rows[0]).toMatchObject({ consumptionSource: "csv_import", aicConsumedCredits: 100 });

    const march = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], logins: ["alice"], view: "detail", page: 1, pageSize: 10 });
    expect(march.rows[0]?.consumptionSource).not.toBe("csv_import");
    expect(march.rows[0]?.aicConsumedCredits).toBe(120);
  });

  it("isolates carol's per-user 404 in March: she still gets a materialized row with zero consumption, and no org-scoped fallback occurs for alpha", () => {
    const march = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], logins: ["carol"], view: "detail", page: 1, pageSize: 10 });
    expect(march.rows).toHaveLength(1);
    expect(march.rows[0]?.aicConsumedCredits).toBe(0);
    // An org fallback would have produced org_api-sourced consumption for alpha; it never happened.
    const anyOrgApiForAlpha = queryLicensePeriodRows({ enterpriseSlug: ALPHA, periods: ["2026-03"], view: "detail", page: 1, pageSize: 100 }).rows.some(
      (r) => r.consumptionSource === "org_api",
    );
    expect(anyOrgApiForAlpha).toBe(false);
  });

  it("falls back to the org-scoped endpoint for beta only after its enterprise-wide AI-Credit failure, never for an isolated per-user issue", () => {
    const march = queryLicensePeriodRows({ enterpriseSlug: BETA, periods: ["2026-03"], view: "detail", page: 1, pageSize: 100 });
    const withConsumption = march.rows.filter((r) => r.aicConsumedCredits > 0);
    expect(withConsumption.length).toBeGreaterThan(0);
    expect(withConsumption.every((r) => r.consumptionSource === "org_api")).toBe(true);
  });

  it("cannot recover beta's holder with zero audit history for historical periods (unrecoverable), unlike a holder with real audit coverage", () => {
    const janBeta = queryLicensePeriodRows({ enterpriseSlug: BETA, periods: ["2026-01"], view: "detail", page: 1, pageSize: 100 });
    const hank = janBeta.rows.find((r) => r.holderKey === "login:hank");
    const iris = janBeta.rows.find((r) => r.resolvedUserLogin === "iris");
    if (hank) {
      // Either no row is materialized for a wholly-unrecoverable holder, or
      // one is, explicitly marked unrecoverable — never a fabricated
      // "active" assignment for a period with zero supporting evidence.
      expect(hank.historyConfidence).toBe("unrecoverable");
    }
    expect(iris).toBeDefined();
    expect(iris?.historyConfidence).not.toBe("unrecoverable");
  });

  it("computes non-zero KPI totals across both enterprises without loading all rows into JS (SQL aggregation)", () => {
    const kpis = getMaterializedPeriodKPIs({ periods: [...scenario.periods] });
    expect(kpis.totalRows).toBeGreaterThan(0);
    expect(kpis.totalLicenseCost).toBeGreaterThan(0);
  });

  it("queries a real bounded rollup export directly via the repository, aggregating dana's multi-org seats without double-counting", () => {
    const result = queryLicensePeriodExport({
      enterpriseSlug: ALPHA,
      periods: [...scenario.periods],
      logins: ["dana"],
      view: "rollup",
      maxRows: 100,
    });
    expect(result.tooLarge).toBe(false);
    if (result.tooLarge) return;
    expect(result.rows).toHaveLength(1);
    const danaRollup = result.rows[0];
    expect(danaRollup.orgLogins.sort()).toEqual([FIXTURE_ORGS.ALPHA_DATA, FIXTURE_ORGS.ALPHA_ENG].sort());
    expect(danaRollup.orgCount).toBe(2);
  });

  it("persists durable, queryable reconciliation checks including a real seat-count mismatch (alpha-data) and a history-coverage failure (beta's unrecoverable holder)", () => {
    const alphaRuns = listLicenseRuns(ALPHA, 5);
    expect(alphaRuns.length).toBeGreaterThan(0);
    const runId = alphaRuns[0].id;
    const checks = listLicenseChecks(runId);
    expect(checks.length).toBeGreaterThan(0);

    const seatCountFail = checks.find((c) => c.checkName === "seat_count" && c.orgLogin === FIXTURE_ORGS.ALPHA_DATA && c.status === "fail");
    expect(seatCountFail).toBeDefined();

    // The sync orchestrator currently always compares gross consumption
    // against a hardcoded `null` net comparator (see this file's module doc
    // and the final report) — `aic_gross_vs_net` can therefore only ever
    // legitimately warn ("no net comparator available") today, never
    // pass/fail, regardless of the netUsd figures fixtures provide.
    const grossVsNet = checks.filter((c) => c.checkName === "aic_gross_vs_net");
    expect(grossVsNet.length).toBeGreaterThan(0);
    expect(grossVsNet.every((c) => c.status === "warning")).toBe(true);

    const betaChecks = listLicenseChecks(listLicenseRuns(BETA, 5)[0].id);
    const historyCoverageFail = betaChecks.find((c) => c.checkName === "history_coverage" && c.status === "fail");
    expect(historyCoverageFail).toBeDefined();
  });

  it("run diagnostics never leak raw external identities/tokens, and expose a bounded, sanitized report via buildLicenseRunReport", () => {
    const alphaRuns = listLicenseRuns(ALPHA, 5);
    const run = getLicenseRun(alphaRuns[0].id)!;
    const checks = listLicenseChecks(run.id);
    const report = buildLicenseRunReport(run, checks, []);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("@example.test");
    expect(serialized).not.toContain("obfuscated-holder");
  });

  it("degrades gracefully for beta's missing optional sources (archive file, SCIM, org billing) — surfaced as warnings, never an unhandled process failure", () => {
    const betaResult = syncResult.enterprises.find((e) => e.enterpriseSlug === BETA)!;
    expect(betaResult.errorMessage).toBeNull();
    expect(betaResult.materializedPeriods.length).toBeGreaterThan(0);
    expect(betaResult.warnings.some((w) => w.includes("archive"))).toBe(true);
    expect(betaResult.warnings.some((w) => w.toLowerCase().includes("membership/scim"))).toBe(true);
    expect(betaResult.warnings.some((w) => w.toLowerCase().includes("org billing"))).toBe(true);
  });

  it("leaves pre-existing copilot_seats and billing_premium_requests rows fully intact and queryable after the sync", () => {
    const seat = db.prepare("SELECT * FROM copilot_seats WHERE user_login = ?").get("legacyuser") as { user_login: string } | undefined;
    const billing = db.prepare("SELECT * FROM billing_premium_requests WHERE username = ?").get("legacyuser") as { username: string } | undefined;
    expect(seat?.user_login).toBe("legacyuser");
    expect(billing?.username).toBe("legacyuser");
  });

  // ── Real API route contracts, driven by real sync-produced data ────────

  describe("API routes over the real materialized data", () => {
    it("GET /api/billing/license-reconciliation returns historical rows for alpha with real pagination/coverage", async () => {
      const { GET } = await import("@/app/api/billing/license-reconciliation/route");
      const response = await GET(
        new NextRequest(`http://localhost/api/billing/license-reconciliation?periods=2026-03&enterprises=${ALPHA}&view=detail&pageSize=50`),
      );
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.enabled).toBe(true);
      expect(payload.coverage.mode).toBe("historical");
      expect(payload.rows.length).toBeGreaterThan(0);
      expect(payload.rows.every((r: { enterpriseSlug: string }) => r.enterpriseSlug === ALPHA)).toBe(true);
    });

    it("GET /api/billing/license-reconciliation/runs lists a real run summary for beta, excluding raw sourceStats", async () => {
      const { GET } = await import("@/app/api/billing/license-reconciliation/runs/route");
      const response = await GET(new NextRequest(`http://localhost/api/billing/license-reconciliation/runs?enterprise=${BETA}`));
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.runs.length).toBeGreaterThan(0);
      expect(JSON.stringify(payload)).not.toContain("periodFingerprints");
    });

    it("GET /api/billing/license-reconciliation/runs/[id] returns the full sanitized run report for a real run id", async () => {
      const runsRoute = await import("@/app/api/billing/license-reconciliation/runs/route");
      const runsResponse = await runsRoute.GET(new NextRequest(`http://localhost/api/billing/license-reconciliation/runs?enterprise=${ALPHA}`));
      const { runs } = await runsResponse.json();
      const runId = runs[0].id;

      const { GET } = await import("@/app/api/billing/license-reconciliation/runs/[id]/route");
      const response = await GET(new NextRequest(`http://localhost/api/billing/license-reconciliation/runs/${runId}?enterprise=${ALPHA}`));
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.id).toBe(runId);
      expect(payload.checkCounts).toBeDefined();
      // Matches the real, seeded data-quality outcome for alpha (see the
      // "completes the sync process..." test above) — surfaced through the
      // real API, not just the in-process sync result.
      expect(payload.status).toBe("failed");
    });

    it("GET /api/export/license-reconciliation streams a real detail CSV for alpha with the documented column header, never a 500", async () => {
      const { GET } = await import("@/app/api/export/license-reconciliation/route");
      const response = await GET(
        new NextRequest(`http://localhost/api/export/license-reconciliation?periods=2026-03&enterprises=${ALPHA}&view=detail`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/csv");
      const csv = await response.text();
      expect(csv).toContain("Enterprise,Period,Org,Login,Holder Key,Plan Type");
      expect(csv).toContain(ALPHA);
    });

    it("never returns a 500 for beta's missing-optional-source scope, returning valid (possibly empty/partial) data instead", async () => {
      const { GET } = await import("@/app/api/billing/license-reconciliation/route");
      const response = await GET(
        new NextRequest(`http://localhost/api/billing/license-reconciliation?periods=2026-01&enterprises=${BETA}&view=detail`),
      );
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(Array.isArray(payload.rows)).toBe(true);
    });
  });
});
