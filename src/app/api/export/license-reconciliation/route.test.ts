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

// These wrappers back both this route's own `withTimeout` usage AND the
// re-imported `../route` module's top-level `withRateLimit`/`withTimeout`/
// `withCache` wiring (importing `resolveReconciliationFilters` from `../route`
// executes that module's top-level `export const GET = ...` construction too).
vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300, SHORT: 120 } }));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual };
});

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
}));

vi.mock("@/lib/config/dashboard-config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config/dashboard-config")>(
    "@/lib/config/dashboard-config",
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

function req(url: string): NextRequest {
  return new NextRequest(url);
}

const BASE_URL = "http://localhost/api/export/license-reconciliation";

function makeDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enterpriseSlug: "acme",
    billingPeriod: "2026-01",
    orgLogin: "acme-eng",
    holderKey: "acme:acme-eng:alice",
    githubUserId: 1,
    userLogin: "alice",
    resolvedUserLogin: "alice",
    externalIdentity: "should-never-appear@example.com",
    identityResolutionSource: "github_login",
    accountState: "member",
    licenseAssignedDate: "2025-12-01",
    userRevokedDate: null,
    planType: "business",
    seatStatus: "active",
    assignedVia: "direct",
    lastActivityAt: "2026-01-15T00:00:00.000Z",
    licenseCost: 19,
    defaultAicCredits: 300,
    defaultAicUsd: 3,
    aicAssignedUsd: 3,
    aicAssignedRule: "plan_default",
    aicConsumedCredits: 100,
    aicConsumedUsd: 1,
    currency: "USD",
    rowSource: "audit_reconstructed",
    consumptionSource: "billing_premium_requests",
    historyConfidence: "audit_reconstructed",
    dataQualityNotes: ["free-form-note-should-not-appear"],
    asOfUtc: "2026-01-31T23:59:59.000Z",
    generatedAtUtc: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRollupRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enterpriseSlug: "acme",
    resolvedUserLogin: "alice",
    periods: ["2026-01", "2026-02"],
    orgLogins: ["acme-eng"],
    planTypes: ["business"],
    seatCount: 1,
    orgCount: 1,
    periodCount: 2,
    licenseCost: 38,
    defaultAicCredits: 600,
    defaultAicUsd: 6,
    aicAssignedUsd: 6,
    aicConsumedCredits: 200,
    aicConsumedUsd: 2,
    utilizationPct: 33.3,
    currency: "USD",
    historyConfidence: "audit_reconstructed",
    ...overrides,
  };
}

function paginated(rows: unknown[], overrides: Partial<{ page: number; pageSize: number; totalItems: number; totalPages: number }> = {}) {
  return {
    view: "detail",
    rows,
    pagination: { page: 1, pageSize: 200, totalItems: rows.length, totalPages: 1, ...overrides },
  };
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
  configState.getLicensingConfig.mockReturnValue({ currency: "USD", creditToUsd: 0.01 });
  repoState.getLicenseReconciliationRows.mockReturnValue([]);
  historyRepoState.hasMaterializedRows.mockReturnValue(false);
  historyRepoState.queryLicensePeriodRows.mockReturnValue(paginated([]));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("license reconciliation CSV export route", () => {
  it("returns 404 when the licensing feature is not enabled", async () => {
    configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(false);
    const res = await GET(req(`${BASE_URL}?days=28`));
    expect(res.status).toBe(404);
  });

  it("propagates a 400 validation error from the shared filter resolver", async () => {
    const res = await GET(req(`${BASE_URL}?periods=not-a-month`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("propagates the LicensingConfigError as 422 with details, same as the JSON route", async () => {
    const { LicensingConfigError } = await import("@/lib/config/dashboard-config");
    configState.getLicensingConfig.mockImplementation(() => {
      throw new LicensingConfigError(["licensing.creditToUsd must be a non-negative finite number (got -1)"]);
    });
    const res = await GET(req(`${BASE_URL}?days=28`));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_licensing_config");
  });

  it("exports historical detail rows with the exact deterministic column order, RFC4180 quoting, and no externalIdentity/free-form data", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodRows.mockReturnValue(
      paginated([
        makeDetailRow({
          orgLogin: 'org, with "quotes"\nand a newline',
          userLogin: null,
          resolvedUserLogin: null,
          licenseAssignedDate: undefined,
          userRevokedDate: null,
        }),
      ]),
    );

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=detail`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="/);
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);

    const text = await res.text();
    expect(text).not.toContain("should-never-appear@example.com");
    expect(text).not.toContain("externalIdentity");
    expect(text).not.toContain("free-form-note-should-not-appear");

    const lines = text.trim().split("\n");
    const headerLine = lines.find((l) => l.startsWith("Enterprise,"));
    expect(headerLine).toBe(
      [
        "Enterprise",
        "Period",
        "Org",
        "Login",
        "Holder Key",
        "Plan Type",
        "Account State",
        "Seat Status",
        "Assigned Via",
        "License Assigned Date",
        "User Revoked Date",
        "Row Source",
        "Consumption Source",
        "History Confidence",
        "Default AIC Credits",
        "AIC Assigned USD",
        "AIC Consumed Credits",
        "AIC Consumed USD",
        "Over Budget",
        "License Cost",
        "Currency",
        "As Of (UTC)",
        "Generated At (UTC)",
      ].join(","),
    );

    const headerIdx = lines.indexOf(headerLine!);
    const dataLine = lines[headerIdx + 1];
    // Quoted org value (comma/quotes/newline collapsed onto one CSV cell).
    expect(dataLine).toContain('"org, with ""quotes""');
    // null/undefined login/dates must render as empty string, never literal "null"/"undefined".
    expect(dataLine).not.toContain("null");
    expect(dataLine).not.toContain("undefined");
  });

  it("exports historical rollup rows with the rollup column order and aggregated fields", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodRows.mockReturnValue({
      view: "rollup",
      rows: [makeRollupRow()],
      pagination: { page: 1, pageSize: 200, totalItems: 1, totalPages: 1 },
    });

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=rollup`));
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split("\n");
    const headerLine = lines.find((l) => l.startsWith("Enterprise,"));
    expect(headerLine).toBe(
      [
        "Enterprise",
        "Periods",
        "Orgs",
        "Login",
        "Plan Types",
        "Seat Count",
        "Org Count",
        "Period Count",
        "History Confidence",
        "Default AIC Credits",
        "AIC Assigned USD",
        "AIC Consumed Credits",
        "AIC Consumed USD",
        "Utilization %",
        "Over Budget",
        "License Cost",
        "Currency",
      ].join(","),
    );
    const headerIdx = lines.indexOf(headerLine!);
    expect(lines[headerIdx + 1]).toContain("acme");
    expect(lines[headerIdx + 1]).toContain("2026-01;2026-02");
  });

  it("loops repository pages internally (bounded by the repo's own page cap) rather than requiring a client N-page loop, and returns the exact total row count", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    const page1Rows = Array.from({ length: 200 }, (_, i) => makeDetailRow({ holderKey: `k${i}`, resolvedUserLogin: `user${i}` }));
    const page2Rows = Array.from({ length: 50 }, (_, i) => makeDetailRow({ holderKey: `k2-${i}`, resolvedUserLogin: `user2-${i}` }));
    historyRepoState.queryLicensePeriodRows.mockImplementation((q: { page?: number }) => {
      if (q.page === 2) {
        return { view: "detail", rows: page2Rows, pagination: { page: 2, pageSize: 200, totalItems: 250, totalPages: 2 } };
      }
      return { view: "detail", rows: page1Rows, pagination: { page: 1, pageSize: 200, totalItems: 250, totalPages: 2 } };
    });

    const res = await GET(req(`${BASE_URL}?periods=2026-01`));
    expect(res.status).toBe(200);
    expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledTimes(2);
    const text = await res.text();
    const lines = text.trim().split("\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("Enterprise,"));
    const dataLines = lines.slice(headerIdx + 1);
    expect(dataLines).toHaveLength(250);
  });

  it("rejects (before building output) when the historical result set exceeds the export row cap", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodRows.mockReturnValue(
      paginated([], { totalItems: 999_999, totalPages: 5000 }),
    );

    const res = await GET(req(`${BASE_URL}?periods=2026-01`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
    // Only the peek call (page 1) should have happened — never looped further.
    expect(historyRepoState.queryLicensePeriodRows).toHaveBeenCalledTimes(1);
  });

  it("falls back to the live snapshot query when no materialized history exists for the scope, mapping rows onto the same detail columns", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(false);
    repoState.getLicenseReconciliationRows.mockReturnValue([
      {
        user_login: "bob",
        orgs: ["acme-eng"],
        org_count: 1,
        seat_count: 1,
        plan_type: "business",
        license_assigned_date: "2025-12-01",
        last_activity_at: "2026-01-15T00:00:00.000Z",
        activity_status: "active_30d",
        assigned_via: "direct",
        user_status: "active",
        seat_status: "active",
        user_revoked_date: null,
        license_cost: 19,
        default_aic_credits: 300,
        default_aic_usd: 3,
        aic_assigned_usd: 3,
        aic_assigned_rule: "plan_default",
        aic_consumed_credits: 100,
        aic_consumed_usd: 1,
        utilization_pct: 33.3,
        over_budget: false,
        total_cost: 20,
      },
    ]);

    const res = await GET(req(`${BASE_URL}?days=28`));
    expect(res.status).toBe(200);
    expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).toContain("bob");
    expect(text).toContain("live_snapshot_only");
  });

  it("rejects the live-snapshot fallback export when the legacy row count exceeds the export cap", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(false);
    repoState.getLicenseReconciliationRows.mockReturnValue(
      Array.from({ length: 10_001 }, (_, i) => ({
        user_login: `user${i}`,
        orgs: ["acme-eng"],
        org_count: 1,
        seat_count: 1,
        plan_type: "business",
        license_assigned_date: null,
        last_activity_at: null,
        activity_status: "never",
        assigned_via: "direct",
        user_status: "active",
        seat_status: "active",
        user_revoked_date: null,
        license_cost: 19,
        default_aic_credits: 300,
        default_aic_usd: 3,
        aic_assigned_usd: 3,
        aic_assigned_rule: "plan_default",
        aic_consumed_credits: 0,
        aic_consumed_usd: 0,
        utilization_pct: 0,
        over_budget: false,
        total_cost: 19,
      })),
    );

    const res = await GET(req(`${BASE_URL}?days=28`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
  });

  it("includes Report/Period/View/Exported At metadata comment rows before the header, matching the sibling export pattern", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodRows.mockReturnValue(paginated([makeDetailRow()]));

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=detail`));
    const text = await res.text();
    expect(text).toMatch(/^Report,/);
    expect(text).toContain("Period,2026-01");
    expect(text).toContain("View,detail");
    expect(text).toContain("Exported At,");
  });
});
