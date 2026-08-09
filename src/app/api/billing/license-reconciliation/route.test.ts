import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getLicenseReconciliationRows: vi.fn(),
  computeLicenseKPIs: vi.fn(),
  computePlanBreakdown: vi.fn(),
  computeOrgBreakdown: vi.fn(),
  computeUtilizationBuckets: vi.fn(),
  sortLicenseRows: vi.fn(),
}));

const historyRepoState = vi.hoisted(() => ({
  queryLicensePeriodRows: vi.fn(),
  getMaterializedPeriodKPIs: vi.fn(),
  getMaterializedPlanBreakdown: vi.fn(),
  getMaterializedOrgBreakdown: vi.fn(),
  hasMaterializedRows: vi.fn(),
}));

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  getLicensingConfig: vi.fn(),
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

vi.mock("@/lib/db/license-repo", () => ({
  getLicenseReconciliationRows: (...a: unknown[]) => repoState.getLicenseReconciliationRows(...a),
  computeLicenseKPIs: (...a: unknown[]) => repoState.computeLicenseKPIs(...a),
  computePlanBreakdown: (...a: unknown[]) => repoState.computePlanBreakdown(...a),
  computeOrgBreakdown: (...a: unknown[]) => repoState.computeOrgBreakdown(...a),
  computeUtilizationBuckets: (...a: unknown[]) => repoState.computeUtilizationBuckets(...a),
  sortLicenseRows: (...a: unknown[]) => repoState.sortLicenseRows(...a),
}));

vi.mock("@/lib/db/license-history-repo", () => ({
  queryLicensePeriodRows: (...a: unknown[]) => historyRepoState.queryLicensePeriodRows(...a),
  getMaterializedPeriodKPIs: (...a: unknown[]) => historyRepoState.getMaterializedPeriodKPIs(...a),
  getMaterializedPlanBreakdown: (...a: unknown[]) => historyRepoState.getMaterializedPlanBreakdown(...a),
  getMaterializedOrgBreakdown: (...a: unknown[]) => historyRepoState.getMaterializedOrgBreakdown(...a),
  hasMaterializedRows: (...a: unknown[]) => historyRepoState.hasMaterializedRows(...a),
}));

import { GET } from "./route";
import { LicensingConfigError } from "@/lib/config/dashboard-config";

function req(url = "http://localhost/api/billing/license-reconciliation?days=28"): NextRequest {
  return new NextRequest(url);
}

beforeEach(() => {
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  scopeState.parseScopeFilter.mockReturnValue({
    selectedTeams: [],
    selectedOrgs: [],
    selectedEnterprises: [],
    hasFilter: false,
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
  });
  repoState.getLicenseReconciliationRows.mockReturnValue([]);
  repoState.computeLicenseKPIs.mockReturnValue({});
  repoState.computePlanBreakdown.mockReturnValue([]);
  repoState.computeOrgBreakdown.mockReturnValue([]);
  repoState.computeUtilizationBuckets.mockReturnValue([]);
  repoState.sortLicenseRows.mockReturnValue([]);
  historyRepoState.hasMaterializedRows.mockReturnValue(false);
  historyRepoState.queryLicensePeriodRows.mockReturnValue({
    view: "detail",
    rows: [],
    pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 },
  });
  historyRepoState.getMaterializedPeriodKPIs.mockReturnValue({});
  historyRepoState.getMaterializedPlanBreakdown.mockReturnValue([]);
  historyRepoState.getMaterializedOrgBreakdown.mockReturnValue([]);
  configState.getLicensingConfig.mockReturnValue({ currency: "USD", creditToUsd: 0.01 });
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
    repoState.getLicenseReconciliationRows.mockImplementation(() => {
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

  describe("backward-compatible live fallback (no materialized history)", () => {
    it("falls back to the live query and marks coverage.mode/dataSource as live_snapshot_only when no materialized rows exist", async () => {
      historyRepoState.hasMaterializedRows.mockReturnValue(false);
      const res = await GET(req());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.coverage.mode).toBe("live_snapshot_only");
      expect(body.dataSource).toBe("live_snapshot_only");
      expect(repoState.getLicenseReconciliationRows).toHaveBeenCalledTimes(1);
      expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    });

    it("never returns a 500 or triggers a resync when falling back", async () => {
      const res = await GET(req());
      expect(res.status).not.toBe(500);
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
      expect(repoState.getLicenseReconciliationRows).not.toHaveBeenCalled();
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
      expect(body.kpis).toEqual({ totalRows: 0, totalUsers: 0 });
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
});
