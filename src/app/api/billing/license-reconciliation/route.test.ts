import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getLicenseReconciliationDataset: vi.fn(),
  computeLicenseKPIs: vi.fn(),
  computePlanBreakdown: vi.fn(),
  computeOrgBreakdown: vi.fn(),
  computeUtilizationBuckets: vi.fn(),
  sortLicenseRows: vi.fn(),
  getCopilotCostBasis: vi.fn(),
  getCopilotBillingBreakdown: vi.fn(),
}));

const historyRepoState = vi.hoisted(() => ({
  queryLicensePeriodRows: vi.fn(),
  getMaterializedPeriodKPIs: vi.fn(),
  getMaterializedPlanBreakdown: vi.fn(),
  getMaterializedOrgBreakdown: vi.fn(),
  getMaterializedPeriods: vi.fn(),
  getEarliestMaterializedPeriod: vi.fn(),
  getMaterializedUtilizationBuckets: vi.fn(),
  getLatestLicenseQualitySummary: vi.fn(),
  hasMaterializedRows: vi.fn(),
}));

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  getLicensingConfig: vi.fn(),
  getEnterpriseSlugs: vi.fn(),
}));

const scopeState = vi.hoisted(() => ({
  parseScopeFilter: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual };
});

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
  getEnterpriseSlugs: (...args: unknown[]) => configState.getEnterpriseSlugs(...args),
}));

// Keep the real `LicensingConfigError` class (route.ts checks `instanceof`
// against it) but let the test control what `getLicensingConfig` returns/throws.
vi.mock("@/lib/config/dashboard-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config/dashboard-config")>(
    "@/lib/config/dashboard-config"
  );
  return {
    ...actual,
    getLicensingConfig: (...args: unknown[]) => configState.getLicensingConfig(...args),
  };
});

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (...args: unknown[]) => scopeState.parseScopeFilter(...args),
}));

// The route imports getCopilotCostBasis for the shared Billing/Licensing cost
// strip. Without this mock the import reaches a real SQLite connection and runs
// schema migrations, which blows the 5s test timeout.
vi.mock("@/lib/db/billing-repo", () => ({
  getCopilotCostBasis: (...a: unknown[]) => repoState.getCopilotCostBasis(...a),
  getCopilotBillingBreakdown: (...a: unknown[]) => repoState.getCopilotBillingBreakdown(...a),
}));

vi.mock("@/lib/db/license-repo", () => ({
  getLicenseReconciliationDataset: (...a: unknown[]) => repoState.getLicenseReconciliationDataset(...a),
  computeLicenseKPIs: (...a: unknown[]) => repoState.computeLicenseKPIs(...a),
  computePlanBreakdown: (...a: unknown[]) => repoState.computePlanBreakdown(...a),
  computeOrgBreakdown: (...a: unknown[]) => repoState.computeOrgBreakdown(...a),
  computeUtilizationBuckets: (...a: unknown[]) => repoState.computeUtilizationBuckets(...a),
  sortLicenseRows: (...a: unknown[]) => repoState.sortLicenseRows(...a),
}));

vi.mock("@/lib/db/license-history-repo", () => ({
  DETAIL_SORT_COLUMNS: [
    "billing_period",
    "org_login",
    "user_login",
    "resolved_user_login",
    "plan_type",
    "seat_status",
    "account_state",
    "history_confidence",
    "license_cost",
    "aic_consumed_credits",
    "aic_consumed_usd",
    "default_aic_credits",
    "default_aic_usd",
    "aic_assigned_usd",
    "last_activity_at",
    "as_of_utc",
    "total_cost",
  ],
  ROLLUP_SORT_COLUMNS: [
    "resolved_user_login",
    "seat_count",
    "org_count",
    "period_count",
    "license_cost",
    "aic_consumed_credits",
    "aic_consumed_usd",
    "default_aic_credits",
    "default_aic_usd",
    "aic_assigned_usd",
    "utilization_pct",
    "total_cost",
  ],
  queryLicensePeriodRows: (...a: unknown[]) => historyRepoState.queryLicensePeriodRows(...a),
  getMaterializedPeriodKPIs: (...a: unknown[]) => historyRepoState.getMaterializedPeriodKPIs(...a),
  getMaterializedPlanBreakdown: (...a: unknown[]) => historyRepoState.getMaterializedPlanBreakdown(...a),
  getMaterializedOrgBreakdown: (...a: unknown[]) => historyRepoState.getMaterializedOrgBreakdown(...a),
  getMaterializedPeriods: (...a: unknown[]) => historyRepoState.getMaterializedPeriods(...a),
  getEarliestMaterializedPeriod: (...a: unknown[]) =>
    historyRepoState.getEarliestMaterializedPeriod(...a),
  getMaterializedUtilizationBuckets: (...a: unknown[]) =>
    historyRepoState.getMaterializedUtilizationBuckets(...a),
  getLatestLicenseQualitySummary: (...a: unknown[]) =>
    historyRepoState.getLatestLicenseQualitySummary(...a),
  hasMaterializedRows: (...a: unknown[]) => historyRepoState.hasMaterializedRows(...a),
}));

import { GET } from "./route";
import { LicensingConfigError } from "@/lib/config/dashboard-config";

function req(url = "http://localhost/api/billing/license-reconciliation?days=28"): NextRequest {
  return new NextRequest(url);
}

/** The `{ rows, coverage }` shape `getLicenseReconciliationDataset` returns, with a zero residual. */
function dataset(rows: unknown[]) {
  return {
    rows,
    coverage: {
      attributedCredits: 0,
      attributedUsd: 0,
      matchedCredits: 0,
      matchedUsd: 0,
      unmatchedCredits: 0,
      unmatchedUsd: 0,
      unmatchedUsers: 0,
    },
  };
}

beforeEach(() => {
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  configState.getEnterpriseSlugs.mockReturnValue(["acme", "other-ent"]);
  scopeState.parseScopeFilter.mockReturnValue({
    selectedTeams: [],
    selectedOrgs: [],
    selectedEnterprises: [],
    hasFilter: false,
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
  });
  repoState.getLicenseReconciliationDataset.mockReturnValue(dataset([]));
  repoState.computeLicenseKPIs.mockReturnValue({});
  repoState.computePlanBreakdown.mockReturnValue([]);
  repoState.computeOrgBreakdown.mockReturnValue([]);
  repoState.computeUtilizationBuckets.mockReturnValue([]);
  repoState.sortLicenseRows.mockReturnValue([]);
  repoState.getCopilotCostBasis.mockReturnValue(null);
  historyRepoState.hasMaterializedRows.mockReturnValue(false);
  historyRepoState.queryLicensePeriodRows.mockReturnValue({
    view: "detail",
    rows: [],
    pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
  });
  historyRepoState.getMaterializedPeriodKPIs.mockReturnValue({});
  historyRepoState.getMaterializedPlanBreakdown.mockReturnValue([]);
  historyRepoState.getMaterializedOrgBreakdown.mockReturnValue([]);
  historyRepoState.getMaterializedPeriods.mockReturnValue([]);
  historyRepoState.getEarliestMaterializedPeriod.mockReturnValue(null);
  historyRepoState.getMaterializedUtilizationBuckets.mockReturnValue([]);
  repoState.getCopilotBillingBreakdown.mockReturnValue(null);
  historyRepoState.getLatestLicenseQualitySummary.mockReturnValue({ pass: 0, warning: 0, fail: 0 });
  configState.getLicensingConfig.mockReturnValue({
    currency: "USD",
    creditToUsd: 0.01,
    history: { auditRetentionDays: 400 },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation route", () => {
  it("returns 200 with the resolved licensing config when it is valid", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.config).toEqual({ currency: "USD", creditToUsd: 0.01 });
  });

  it("returns a stable 422 invalid_licensing_config response with the exact validation details, and no stack trace or extra fields, when licensing config is invalid", async () => {
    const details = [
      'licensing.history.reportMonths ("not-a-month") is invalid: Invalid report month "not-a-month": expected format YYYY-MM',
      "licensing.creditToUsd must be a non-negative finite number (got -1)",
    ];
    configState.getLicensingConfig.mockImplementation(() => {
      throw new LicensingConfigError(details);
    });

    const res = await GET(req());
    expect(res.status).toBe(422);
    const body = await res.json();

    // Stable, minimal shape: exactly `error` + `details`, nothing else (no
    // `stack`, `message`, file paths, or other internals leaked).
    expect(Object.keys(body).sort()).toEqual(["details", "error"]);
    expect(body.error).toBe("invalid_licensing_config");
    expect(body.details).toEqual(details);
  });

  it("does not use the licensing 422 shape for unrelated errors, and does not leak their message", async () => {
    // The secret sentinel below ("hunter2") deliberately matches what the
    // assertion checks for, so this test actually proves the route redacts
    // the thrown error's message rather than passing vacuously regardless of
    // route behavior.
    repoState.getLicenseReconciliationDataset.mockImplementation(() => {
      throw new Error("db connection exploded: password=hunter2");
    });

    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("returns enabled:false and skips getLicensingConfig when billing is disabled", async () => {
    configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ enabled: false });
    expect(configState.getLicensingConfig).not.toHaveBeenCalled();
  });

  it("passes org scope to the shared Copilot cost basis query", async () => {
    scopeState.parseScopeFilter.mockReturnValue({
      selectedTeams: [],
      selectedOrgs: ["octo-org"],
      selectedEnterprises: ["acme"],
      hasFilter: true,
      allowedLogins: new Set(["alice"]),
      enterpriseSlugs: ["acme"],
    });

    const res = await GET(
      req("http://localhost/api/billing/license-reconciliation?periods=2026-07&orgs=octo-org&enterprises=acme"),
    );

    expect(res.status).toBe(200);
    expect(repoState.getCopilotCostBasis).toHaveBeenCalledWith(
      "2026-07-01",
      "2026-07-31",
      { allowedLogins: ["alice"], scopeOrgs: ["octo-org"] },
      ["acme"],
      "2026-07",
    );
  });

  describe("period window (the per-user rows and the cost basis must describe the same days)", () => {
    it("computes live-snapshot rows over the selected month, not the days default", async () => {
      // `parseDateRangeParams` falls back to a rolling 28-day window when no
      // `days`/`startDate` is sent. A `periods` selection sends neither, so
      // without an explicit override the per-user tiles reported the last 28
      // days while the cost-basis strip reported the selected calendar month.
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?periods=2026-07"));
      expect(res.status).toBe(200);
      expect(repoState.getLicenseReconciliationDataset).toHaveBeenCalledWith(
        expect.objectContaining({ start: "2026-07-01", end: "2026-07-31" }),
      );
    });

    it("hands the live query and the cost basis identical bounds, for a month and for a rolling window alike", async () => {
      for (const query of ["periods=2026-06", "days=7", "startDate=2026-07-02&endDate=2026-07-09"]) {
        vi.clearAllMocks();
        configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
        configState.getEnterpriseSlugs.mockReturnValue(["acme", "other-ent"]);
        configState.getLicensingConfig.mockReturnValue({
          currency: "USD",
          creditToUsd: 0.01,
          history: { auditRetentionDays: 400 },
        });
        scopeState.parseScopeFilter.mockReturnValue({
          selectedTeams: [],
          selectedOrgs: [],
          selectedEnterprises: [],
          hasFilter: false,
          allowedLogins: undefined,
          enterpriseSlugs: undefined,
        });
        repoState.getLicenseReconciliationDataset.mockReturnValue(dataset([]));
        repoState.computeLicenseKPIs.mockReturnValue({});
        repoState.computePlanBreakdown.mockReturnValue([]);
        repoState.computeOrgBreakdown.mockReturnValue([]);
        repoState.computeUtilizationBuckets.mockReturnValue([]);
        repoState.sortLicenseRows.mockReturnValue([]);
        repoState.getCopilotCostBasis.mockReturnValue(null);
        historyRepoState.hasMaterializedRows.mockReturnValue(false);
        historyRepoState.getEarliestMaterializedPeriod.mockReturnValue(null);
        historyRepoState.getLatestLicenseQualitySummary.mockReturnValue({ pass: 0, warning: 0, fail: 0 });

        const res = await GET(req(`http://localhost/api/billing/license-reconciliation?${query}`));
        expect(res.status).toBe(200);

        const basisArgs = repoState.getCopilotCostBasis.mock.calls[0];
        const liveArgs = repoState.getLicenseReconciliationDataset.mock.calls[0][0] as {
          start: string;
          end: string;
        };
        expect([liveArgs.start, liveArgs.end]).toEqual([basisArgs[0], basisArgs[1]]);
      }
    });

    it("keeps a rolling `days` window rolling instead of widening it to whole months, and does not label it as a month", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
      try {
        const res = await GET(req("http://localhost/api/billing/license-reconciliation?days=7"));
        expect(res.status).toBe(200);
        const args = repoState.getCopilotCostBasis.mock.calls[0];
        expect(args[0]).not.toBe("2026-08-01");
        // Explicit null, not undefined: a 7-day window sitting inside August is
        // not "August 2026" and must not be labelled as such.
        expect(args[4]).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("backward-compatible live fallback (no materialized history)", () => {
    it("falls back to the live query and marks coverage.mode/dataSource as live_snapshot_only when no materialized rows exist", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(false);
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.coverage.mode).toBe("live_snapshot_only");
      expect(body.dataSource).toBe("live_snapshot_only");
      expect(repoState.getLicenseReconciliationDataset).toHaveBeenCalledTimes(1);
      expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    });

    it("never returns a 500 or triggers a resync when falling back", async () => {
      const res = await GET(req());
      expect(res.status).not.toBe(500);
    });

    it("returns the period-scoped billing breakdown in live-snapshot mode", async () => {
      const breakdown = { startDate: "2026-05-01", endDate: "2026-05-31", period: "2026-05", hasBilledData: true };
      repoState.getCopilotBillingBreakdown.mockReturnValue(breakdown);
      const res = await GET(req());
      const body = await res.json();
      expect(body.dataSource).toBe("live_snapshot_only");
      expect(body.billingBreakdown).toEqual(breakdown);
    });

    it("computes the breakdown over exactly the window the cost basis uses", async () => {
      await GET(req("http://localhost/api/billing/license-reconciliation?periods=2026-05"));
      const basisArgs = repoState.getCopilotCostBasis.mock.calls[0];
      const breakdownArgs = repoState.getCopilotBillingBreakdown.mock.calls[0];
      // Same bounds, same scope, same period hint — the two cannot disagree.
      expect(breakdownArgs).toEqual(basisArgs);
    });

    it("returns billingBreakdown: null instead of failing when the billing query throws", async () => {
      repoState.getCopilotBillingBreakdown.mockImplementation(() => {
        throw new Error("no such table: billing_usage_records");
      });
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.billingBreakdown).toBeNull();
    });

    it("reports missing historical coverage without replacing it with successful zeroes", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
      repoState.computeUtilizationBuckets.mockReturnValue([
        { label: "0%", min: 0, max: 0, count: 2 },
      ]);

      try {
        const res = await GET(
          req("http://localhost/api/billing/license-reconciliation?periods=2026-01,2026-02"),
        );
        const body = await res.json();

        expect(body.coverage).toEqual({
          mode: "live_snapshot_only",
          periods: ["2026-01", "2026-02"],
          view: "detail",
          requestedPeriods: ["2026-01", "2026-02"],
          materializedPeriods: [],
          missingPeriods: ["2026-01", "2026-02"],
          earliestRecoverablePeriod: "2025-07",
          warnings: [
            "No materialized historical data is available for the requested periods; showing the live snapshot instead.",
          ],
        });
        expect(body.qualitySummary).toEqual({ pass: 0, warning: 0, fail: 0 });
        expect(body.utilizationBuckets).toEqual([{ label: "0%", min: 0, max: 0, count: 2 }]);
        expect(body.warnings).toContain(
          "No materialized historical data is available for the requested periods; showing the live snapshot instead.",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("retains latest durable quality failures when materialized rows are unavailable", async () => {
      historyRepoState.getLatestLicenseQualitySummary.mockReturnValue({
        pass: 3,
        warning: 1,
        fail: 2,
      });

      const res = await GET(
        req("http://localhost/api/billing/license-reconciliation?periods=2026-01"),
      );
      const body = await res.json();

      expect(body.qualitySummary).toEqual({ pass: 3, warning: 1, fail: 2 });
      expect(body.warnings).toContain(
        "Latest reconciliation diagnostics include 1 warning check.",
      );
      expect(body.warnings).toContain(
        "Latest reconciliation diagnostics include 2 failed checks.",
      );
      expect(historyRepoState.getLatestLicenseQualitySummary).toHaveBeenCalledWith({
        enterpriseSlugs: ["acme", "other-ent"],
        periods: ["2026-01"],
        orgLogins: undefined,
      });
    });
  });

  describe("historical mode (materialized rows exist)", () => {
    beforeEach(() => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
    });

    it("queries only repo methods (rows/KPIs/breakdowns) and never the legacy live query", async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.coverage.mode).toBe("historical");
      expect(body.dataSource).toBe("historical");
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledTimes(1);
      expect(historyRepoState.getMaterializedPeriodKPIs).toHaveBeenCalledTimes(1);
      expect(historyRepoState.getMaterializedPlanBreakdown).toHaveBeenCalledTimes(1);
      expect(historyRepoState.getMaterializedOrgBreakdown).toHaveBeenCalledTimes(1);
      expect(repoState.getLicenseReconciliationDataset).not.toHaveBeenCalled();
    });

    it("returns the period-scoped billing breakdown in historical mode too", async () => {
      const breakdown = { startDate: "2026-05-01", endDate: "2026-05-31", period: "2026-05", hasBilledData: true };
      repoState.getCopilotBillingBreakdown.mockReturnValue(breakdown);
      const res = await GET(req());
      const body = await res.json();
      expect(body.dataSource).toBe("historical");
      expect(body.billingBreakdown).toEqual(breakdown);
    });

    it("returns a valid empty historical payload (rows [], zero KPIs) when history exists but a narrow filter matches nothing, without falling back", async () => {
      historyRepoState.queryLicensePeriodRows.mockReturnValue({
        view: "detail",
        rows: [],
        pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
      });
      historyRepoState.getMaterializedPeriodKPIs.mockReturnValue({ totalRows: 0, totalUsers: 0 });
      historyRepoState.getMaterializedPlanBreakdown.mockReturnValue([]);
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?search=nobody-matches-this"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.coverage.mode).toBe("historical");
      expect(body.rows).toEqual([]);
      // Projected onto the same KPI contract the live-snapshot branch returns,
      // so the client renders one shape regardless of which pipeline answered.
      expect(body.kpis).toEqual({
        totalUsers: 0,
        totalSeats: 0,
        activeSeats: 0,
        activeUsers: 0,
        pendingCancellation: 0,
        inactive30d: 0,
        zeroConsumptionSeats: 0,
        totalLicenseCost: 0,
        totalAllowanceCredits: 0,
        totalAssignedUsd: 0,
        totalConsumedCredits: 0,
        totalConsumedUsd: 0,
        overallUtilizationPct: 0,
        overBudgetUsers: 0,
        totalCostOfOwnership: 0,
        currency: "USD",
        unmatchedConsumedCredits: 0,
        unmatchedConsumedUsd: 0,
        unmatchedUsers: 0,
        dataSource: "historical",
      });
      expect(body.planBreakdown).toEqual([]);
    });

    it("checks hasMaterializedRows against the base scope only, excluding narrow filters like search/plan/accountState", async () => {
      await GET(
        req(
          "http://localhost/api/billing/license-reconciliation?search=alice&plan=enterprise&accountState=member&seatStatus=active&historyConfidence=exact_snapshot",
        ),
      );
      const baseQuery = historyRepoState.hasMaterializedRows.mock.calls[0][0];
      expect(baseQuery).not.toHaveProperty("search");
      expect(baseQuery).not.toHaveProperty("planTypes");
      expect(baseQuery).not.toHaveProperty("accountStates");
      expect(baseQuery).not.toHaveProperty("seatStatuses");
      expect(baseQuery).not.toHaveProperty("historyConfidence");
    });

    it("supports view=detail and view=rollup, forwarding the view to queryLicensePeriodRows", async () => {
      await GET(req("http://localhost/api/billing/license-reconciliation?view=rollup"));
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledWith(
        expect.objectContaining({ view: "rollup" }),
      );
    });

    it("supports stable server-side pagination and passes through totals from the repo", async () => {
      historyRepoState.queryLicensePeriodRows.mockReturnValue({
        view: "detail",
        rows: [{ userLogin: "alice" }],
        pagination: { page: 2, pageSize: 10, totalItems: 15, totalPages: 2 },
      });
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?page=2&pageSize=10"));
      const body = await res.json();
      expect(body.pagination).toEqual({ page: 2, pageSize: 10, totalItems: 15, totalPages: 2 });
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 10 }),
      );
    });

    it("passes explicit periods through to coverage.periods and the repo filter query", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?periods=2026-01,2026-02"));
      const body = await res.json();
      expect(body.coverage.periods).toEqual(["2026-01", "2026-02"]);
      expect(historyRepoState.getMaterializedPeriodKPIs).toHaveBeenCalledWith(
        expect.objectContaining({ periods: ["2026-01", "2026-02"] }),
      );
    });

    it("returns truthful partial coverage, SQL-backed utilization, and bounded latest-run quality diagnostics", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
      historyRepoState.getMaterializedPeriods.mockReturnValue(["2026-01"]);
      historyRepoState.getMaterializedUtilizationBuckets.mockReturnValue([
        { label: "0%", min: 0, max: 0, count: 1 },
        { label: ">100%", min: 100, max: null, count: 2 },
      ]);
      historyRepoState.getLatestLicenseQualitySummary.mockReturnValue({
        pass: 7,
        warning: 2,
        fail: 1,
      });

      try {
        const res = await GET(
          req("http://localhost/api/billing/license-reconciliation?periods=2026-01,2026-02"),
        );
        const body = await res.json();

        expect(body.coverage).toEqual({
          mode: "historical",
          periods: ["2026-01", "2026-02"],
          view: "detail",
          requestedPeriods: ["2026-01", "2026-02"],
          materializedPeriods: ["2026-01"],
          missingPeriods: ["2026-02"],
          earliestRecoverablePeriod: "2025-07",
          warnings: ["Historical data is unavailable for requested period: 2026-02."],
        });
        expect(body.qualitySummary).toEqual({ pass: 7, warning: 2, fail: 1 });
        expect(body.utilizationBuckets).toEqual([
          { label: "0%", min: 0, max: 0, count: 1 },
          { label: ">100%", min: 100, max: null, count: 2 },
        ]);
        expect(body.warnings).toEqual([
          "Historical data is unavailable for requested period: 2026-02.",
          "Latest reconciliation diagnostics include 2 warning checks.",
          "Latest reconciliation diagnostics include 1 failed check.",
        ]);
        expect(historyRepoState.getMaterializedPeriods).toHaveBeenCalledWith(
          expect.objectContaining({ periods: ["2026-01", "2026-02"] }),
        );
        expect(historyRepoState.getMaterializedUtilizationBuckets).toHaveBeenCalledWith(
          expect.objectContaining({ periods: ["2026-01", "2026-02"] }),
        );
        expect(historyRepoState.getLatestLicenseQualitySummary).toHaveBeenCalledWith(
          expect.objectContaining({ periods: ["2026-01", "2026-02"] }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("extends earliest recoverability to the scoped materialized history extent", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
      historyRepoState.getEarliestMaterializedPeriod.mockReturnValue("2024-02");

      try {
        const res = await GET(
          req("http://localhost/api/billing/license-reconciliation?periods=2026-01"),
        );
        const body = await res.json();

        expect(body.coverage.earliestRecoverablePeriod).toBe("2024-02");
        expect(historyRepoState.getEarliestMaterializedPeriod).toHaveBeenCalledWith({
          enterpriseSlugs: undefined,
          allowedLogins: undefined,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies enterprise and org scope to coverage, utilization, and quality helpers", async () => {
      scopeState.parseScopeFilter.mockReturnValue({
        selectedTeams: [],
        selectedOrgs: ["octo-org"],
        selectedEnterprises: ["acme"],
        hasFilter: true,
        allowedLogins: new Set(["alice"]),
        enterpriseSlugs: ["acme"],
      });

      await GET(
        req(
          "http://localhost/api/billing/license-reconciliation?periods=2026-01&enterprises=acme&orgs=octo-org&plan=enterprise",
        ),
      );

      expect(historyRepoState.getMaterializedPeriods).toHaveBeenCalledWith({
        enterpriseSlugs: ["acme"],
        periods: ["2026-01"],
        allowedLogins: ["alice"],
      });
      expect(historyRepoState.getMaterializedUtilizationBuckets).toHaveBeenCalledWith(
        expect.objectContaining({
          enterpriseSlugs: ["acme"],
          periods: ["2026-01"],
          allowedLogins: ["alice"],
          planTypes: ["enterprise"],
        }),
      );
      expect(historyRepoState.getLatestLicenseQualitySummary).toHaveBeenCalledWith({
        enterpriseSlugs: ["acme"],
        periods: ["2026-01"],
        orgLogins: ["octo-org"],
      });
    });
  });

  describe("periods/custom/days precedence and validation", () => {
    it("uses explicit periods over startDate/endDate/days when provided", async () => {
      const res = await GET(
        req(
          "http://localhost/api/billing/license-reconciliation?periods=2026-03&startDate=2020-01-01&endDate=2020-01-31&days=5",
        ),
      );
      const body = await res.json();
      expect(body.coverage.periods).toEqual(["2026-03"]);
    });

    it("uses custom startDate/endDate over days when periods is absent", async () => {
      const res = await GET(
        req("http://localhost/api/billing/license-reconciliation?startDate=2026-02-01&endDate=2026-02-15&days=5"),
      );
      const body = await res.json();
      expect(body.coverage.periods).toEqual(["2026-02"]);
    });

    it("falls back to days/default when neither periods nor custom dates are given", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?days=10"));
      expect(res.status).toBe(200);
    });

    it("rejects a malformed periods token with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?periods=not-a-month"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid report month/);
    });

    it("rejects a reversed periods range with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?periods=2026-05..2026-01"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/end is before start/);
    });

    it("rejects a periods range spanning more than 120 months", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?periods=2000-01..2020-01"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/exceeding the maximum of 120/);
    });

    it("rejects an invalid days value with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?days=99999"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/exceeds maximum/);
    });

    it("rejects a reversed startDate/endDate range with a descriptive 400", async () => {
      const res = await GET(
        req("http://localhost/api/billing/license-reconciliation?startDate=2026-02-15&endDate=2026-02-01"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/startDate must be on or before endDate/);
    });
  });

  describe("view/enum filter validation", () => {
    it("rejects an invalid view with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?view=summary"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid view/);
    });

    it("rejects an invalid plan filter value with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?plan=gold"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid plan value/);
    });

    it("rejects an invalid accountState filter value with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?accountState=banned"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid accountState value/);
    });

    it("rejects an invalid seatStatus filter value with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?seatStatus=zombie"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid seatStatus value/);
    });

    it("rejects an invalid historyConfidence filter value with a descriptive 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?historyConfidence=guessed"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid historyConfidence value/);
    });

    it("accepts valid plan/accountState/seatStatus/historyConfidence values", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
      const res = await GET(
        req(
          "http://localhost/api/billing/license-reconciliation?plan=enterprise&accountState=member&seatStatus=active&historyConfidence=exact_snapshot",
        ),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("scope/allowedLogins fail-closed", () => {
    it("passes an empty allowedLogins array through to the historical filter query when the team/org scope resolves to zero members", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
      scopeState.parseScopeFilter.mockReturnValue({
        selectedTeams: ["ghost-team"],
        selectedOrgs: [],
        selectedEnterprises: [],
        hasFilter: true,
        allowedLogins: new Set<string>(),
        enterpriseSlugs: undefined,
      });
      await GET(req());
      const baseQuery = historyRepoState.hasMaterializedRows.mock.calls[0][0];
      expect(baseQuery.allowedLogins).toEqual([]);
    });

    it("passes the resolved allowedLogins array through unrestricted (undefined) when no team/org scope is applied", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
      await GET(req());
      const baseQuery = historyRepoState.hasMaterializedRows.mock.calls[0][0];
      expect(baseQuery.allowedLogins).toBeUndefined();
    });
  });

  describe("enterprise slug scope validation", () => {
    it("rejects an unknown enterprise slug among otherwise-valid ones with a structured 400, without calling the repository", async () => {
      scopeState.parseScopeFilter.mockReturnValue({
        selectedTeams: [],
        selectedOrgs: [],
        selectedEnterprises: ["acme", "bogus-ent"],
        hasFilter: true,
        allowedLogins: undefined,
        enterpriseSlugs: ["acme", "bogus-ent"],
      });
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?enterprises=acme,bogus-ent"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/bogus-ent/);
      expect(historyRepoState.hasMaterializedRows).not.toHaveBeenCalled();
      expect(repoState.getLicenseReconciliationDataset).not.toHaveBeenCalled();
    });

    it("rejects an unknown enterprise slug derived from a composite team scope param (entSlug:teamSlug)", async () => {
      const res = await GET(
        req("http://localhost/api/billing/license-reconciliation?teams=bogus-ent:teamA"),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/bogus-ent/);
      expect(historyRepoState.hasMaterializedRows).not.toHaveBeenCalled();
    });

    it("accepts a valid multi-enterprise scope (all configured), without rejection", async () => {
      scopeState.parseScopeFilter.mockReturnValue({
        selectedTeams: [],
        selectedOrgs: [],
        selectedEnterprises: ["acme", "other-ent"],
        hasFilter: true,
        allowedLogins: undefined,
        enterpriseSlugs: ["acme", "other-ent"],
      });
      const res = await GET(
        req("http://localhost/api/billing/license-reconciliation?enterprises=acme,other-ent"),
      );
      expect(res.status).toBe(200);
    });

    it("never rejects when no enterprises/teams scope param is supplied at all", async () => {
      const res = await GET(req());
      expect(res.status).toBe(200);
    });
  });

  describe("strict numeric page/pageSize validation", () => {
    beforeEach(() => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
    });

    it("rejects a fractional page value with a 400 instead of silently truncating", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?page=1.5"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/page/i);
      expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    });

    it("rejects a page value beyond the documented maximum with a 400", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?page=100001"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/page/i);
    });

    it("rejects a fractional pageSize value with a 400 instead of silently truncating", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?pageSize=10.5"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/pageSize/i);
    });

    it("rejects a pageSize above the aligned repo cap (200) with a 400 instead of silently clamping", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?pageSize=500"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/pageSize/i);
    });

    it("accepts a valid pageSize at the 200 cap", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?pageSize=200"));
      expect(res.status).toBe(200);
    });
  });

  describe("sort validation", () => {
    beforeEach(() => {
      historyRepoState.hasMaterializedRows.mockReturnValue(true);
    });

    it("rejects an unsupported sort field with a descriptive 400 instead of silently falling back", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?sort=not_a_real_field"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/sort/i);
      expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    });

    it("accepts sort=total_cost and forwards it to the historical query", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?sort=total_cost"));
      expect(res.status).toBe(200);
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledWith(
        expect.objectContaining({ sortField: "total_cost" }),
      );
    });

    it("accepts detail-view sort fields supported by the historical repository", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?view=detail&sort=billing_period"));
      expect(res.status).toBe(200);
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledWith(
        expect.objectContaining({ view: "detail", sortField: "billing_period" }),
      );
    });

    it("accepts rollup-view sort fields supported by the historical repository", async () => {
      const res = await GET(req("http://localhost/api/billing/license-reconciliation?view=rollup&sort=org_count"));
      expect(res.status).toBe(200);
      expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledWith(
        expect.objectContaining({ view: "rollup", sortField: "org_count" }),
      );
    });

    it("falls back to total-cost sorting when a historical sort reaches live-snapshot mode", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(false);
      const liveRows = [{ user_login: "octocat", total_cost: 10 }];
      repoState.getLicenseReconciliationDataset.mockReturnValue(dataset(liveRows));
      repoState.sortLicenseRows.mockReturnValue(liveRows);

      const res = await GET(req("http://localhost/api/billing/license-reconciliation?view=detail&sort=billing_period"));
      expect(res.status).toBe(200);
      expect(repoState.sortLicenseRows).toHaveBeenCalledWith(liveRows, "total_cost", "desc");
      const body = await res.json();
      expect(body.warnings).toContain(
        "billing_period sorting requires materialized history; sorting the live snapshot by total cost instead.",
      );
    });
  });
});
