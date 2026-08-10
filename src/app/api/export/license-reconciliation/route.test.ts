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
  queryLicensePeriodExport: vi.fn(),
  getMaterializedPeriodKPIs: vi.fn(),
  getMaterializedPlanBreakdown: vi.fn(),
  getMaterializedOrgBreakdown: vi.fn(),
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

// Tag the wrappers (rather than plain pass-through identity) so tests can
// assert the exact composition order of the exported `GET` — proving
// `withRateLimit(withTimeout(handler))` with no caching wrapper in between —
// while still transparently forwarding every call through to the inner
// handler. These wrappers also back the re-imported `../route` module's own
// top-level `withRateLimit`/`withTimeout`/`withCache` wiring (importing
// `resolveReconciliationFilters` from `../route` executes that module's
// top-level `export const GET = ...` construction too), but that module's
// composition is asserted separately by its own test file.
vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (h: (...args: unknown[]) => unknown) => {
    const wrapped = (...args: unknown[]) => h(...args);
    (wrapped as { __wrappedBy?: string }).__wrappedBy = "timeout";
    (wrapped as { __inner?: unknown }).__inner = h;
    return wrapped;
  },
}));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({
  withRateLimit: (h: (...args: unknown[]) => unknown) => {
    const wrapped = (...args: unknown[]) => h(...args);
    (wrapped as { __wrappedBy?: string }).__wrappedBy = "rateLimit";
    (wrapped as { __inner?: unknown }).__inner = h;
    return wrapped;
  },
}));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300, SHORT: 120 } }));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils");
  return { ...actual };
});

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...args: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...args),
  getEnterpriseSlugs: (...args: unknown[]) => configState.getEnterpriseSlugs(...args),
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
  queryLicensePeriodExport: (...a: unknown[]) => historyRepoState.queryLicensePeriodExport(...a),
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

const APPROVED_DETAIL_COLUMNS = [
  "user_login",
  "license_assigned_date",
  "gh_copilot_license_cost",
  "default_aic_user_level",
  "aic_billing_dollar_assigned",
  "aic_consumed",
  "user_status",
  "user_revoked_date",
  "org_login",
  "plan_type",
  "seat_status",
  "assigned_via",
  "last_activity_at",
  "external_identity",
  "github_user_id",
  "resolved_user_login",
  "identity_resolution_source",
  "account_state",
  "aic_assigned_rule_used",
  "default_aic_usd",
  "aic_consumed_usd",
  "currency",
  "billing_period",
  "row_source",
  "login_recovery_source",
  "history_confidence",
  "as_of_utc",
  "data_quality_notes",
  "data_generated_at_utc",
];

const DASHBOARD_DETAIL_COLUMNS = [
  "enterprise",
  "holder_key",
  "consumption_source",
  "over_budget",
  "total_cost",
];

function parseCsvRecord(record: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < record.length; i += 1) {
    const char = record[i];
    if (char === '"') {
      if (quoted && record[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

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

function exportResult(
  rows: unknown[],
  overrides: Partial<{ view: "detail" | "rollup"; totalItems: number }> = {},
) {
  return {
    tooLarge: false as const,
    view: "detail" as const,
    rows,
    totalItems: rows.length,
    ...overrides,
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
  configState.getLicensingConfig.mockReturnValue({ currency: "USD", creditToUsd: 0.01 });
  repoState.getLicenseReconciliationRows.mockReturnValue([]);
  historyRepoState.hasMaterializedRows.mockReturnValue(false);
  historyRepoState.queryLicensePeriodRows.mockReturnValue(paginated([]));
  historyRepoState.queryLicensePeriodExport.mockReturnValue(exportResult([]));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("license reconciliation CSV export route", () => {
  it("composes GET as withRateLimit(withTimeout(handler)) — no caching wrapper", () => {
    const outer = GET as unknown as { __wrappedBy?: string; __inner?: { __wrappedBy?: string; __inner?: unknown } };
    expect(outer.__wrappedBy).toBe("rateLimit");
    expect(outer.__inner?.__wrappedBy).toBe("timeout");
    // The innermost layer is the raw handler — no cache wrapper tag present.
    expect((outer.__inner?.__inner as { __wrappedBy?: string } | undefined)?.__wrappedBy).toBeUndefined();
  });

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

  it("exports historical detail rows with the approved contract before dashboard-only columns", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodExport.mockReturnValue(
      exportResult([
        makeDetailRow({
          userLogin: "observed-alice",
          resolvedUserLogin: "resolved-alice",
          externalIdentity: 'external, "identity"',
          dataQualityNotes: ["=untrusted note", 'free,form "note"'],
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
    const lines = text.trim().split("\r\n");
    const headerLine = lines.find((l) => l.startsWith("user_login,"));
    const header = parseCsvRecord(headerLine!);
    expect(header.slice(0, APPROVED_DETAIL_COLUMNS.length)).toEqual(APPROVED_DETAIL_COLUMNS);
    expect(header.slice(APPROVED_DETAIL_COLUMNS.length)).toEqual(DASHBOARD_DETAIL_COLUMNS);
    const headerIdx = lines.indexOf(headerLine!);
    const values = parseCsvRecord(lines[headerIdx + 1]);
    const row = Object.fromEntries(header.map((column, index) => [column, values[index]]));
    expect(row).toMatchObject({
      user_login: "observed-alice",
      license_assigned_date: "",
      gh_copilot_license_cost: "19",
      default_aic_user_level: "300",
      aic_billing_dollar_assigned: "3",
      aic_consumed: "100",
      user_status: "active",
      user_revoked_date: "",
      org_login: "acme-eng",
      external_identity: 'external, "identity"',
      github_user_id: "1",
      resolved_user_login: "resolved-alice",
      identity_resolution_source: "github_login",
      aic_assigned_rule_used: "plan_default",
      login_recovery_source: "github_login",
      data_quality_notes: '\'=untrusted note,free,form "note"',
      data_generated_at_utc: "2026-02-01T00:00:00.000Z",
      enterprise: "acme",
      holder_key: "acme:acme-eng:alice",
      consumption_source: "billing_premium_requests",
      over_budget: "false",
      total_cost: "20",
    });
    expect(values).not.toContain("null");
    expect(values).not.toContain("undefined");
  });

  it("marks historical rows without an active seat as inactive users", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodExport.mockReturnValue(
      exportResult([makeDetailRow({ seatStatus: "no_seat" })]),
    );

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=detail`));
    const lines = (await res.text()).trim().split("\r\n");
    const headerLine = lines.find((line) => line.startsWith("user_login,"))!;
    const header = parseCsvRecord(headerLine);
    const values = parseCsvRecord(lines[lines.indexOf(headerLine) + 1]);
    const record = Object.fromEntries(header.map((column, index) => [column, values[index]]));

    expect(record.user_status).toBe("inactive");
  });

  it("exports historical rollup rows with the rollup column order and aggregated fields", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodExport.mockReturnValue(
      exportResult([makeRollupRow()], { view: "rollup" }),
    );

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=rollup`));
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split("\r\n");
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

  it("calls the bounded export repository function exactly once for a historical export, never looping N pages against it", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    const rows = Array.from({ length: 250 }, (_, i) => makeDetailRow({ holderKey: `k${i}`, resolvedUserLogin: `user${i}` }));
    historyRepoState.queryLicensePeriodExport.mockReturnValue(exportResult(rows));

    const res = await GET(req(`${BASE_URL}?periods=2026-01`));
    expect(res.status).toBe(200);
    expect(historyRepoState.queryLicensePeriodExport).toHaveBeenCalledTimes(1);
    expect(historyRepoState.queryLicensePeriodRows).not.toHaveBeenCalled();
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("user_login,"));
    const dataLines = lines.slice(headerIdx + 1);
    expect(dataLines).toHaveLength(250);
  });

  it("rejects (before building output) when the bounded export repository call reports the result too large, without a second call", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodExport.mockReturnValue({ tooLarge: true, totalItems: 999_999 });

    const res = await GET(req(`${BASE_URL}?periods=2026-01`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too large/i);
    expect(historyRepoState.queryLicensePeriodExport).toHaveBeenCalledTimes(1);
  });

  it("maps live fallback rows onto the same approved detail contract", async () => {
    historyRepoState.hasMaterializedRows.mockReturnValue(false);
    repoState.getLicenseReconciliationRows.mockReturnValue([
      {
        user_login: "bob",
        resolved_user_login: "resolved-bob",
        external_identity: 'external, "bob"',
        github_user_id: 42,
        identity_resolution_source: "legacy_api",
        login_recovery_source: "identity_map",
        account_state: "member",
        data_quality_notes: ["live note", "second,note"],
        orgs: ["acme-eng"],
        org_count: 1,
        seat_count: 1,
        plan_type: "business",
        license_assigned_date: "2025-12-01",
        last_activity_at: "2026-01-15T00:00:00.000Z",
        activity_status: "active_30d",
        assigned_via: "direct",
        user_status: "active",
        seat_status: "pending_cancellation",
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
    expect(historyRepoState.queryLicensePeriodExport).not.toHaveBeenCalled();
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    const headerLine = lines.find((line) => line.startsWith("user_login,"));
    const header = parseCsvRecord(headerLine!);
    const values = parseCsvRecord(lines[lines.indexOf(headerLine!) + 1]);
    const row = Object.fromEntries(header.map((column, index) => [column, values[index]]));
    expect(header.slice(0, APPROVED_DETAIL_COLUMNS.length)).toEqual(APPROVED_DETAIL_COLUMNS);
    expect(row).toMatchObject({
      user_login: "bob",
      user_status: "active",
      external_identity: 'external, "bob"',
      github_user_id: "42",
      resolved_user_login: "resolved-bob",
      identity_resolution_source: "legacy_api",
      account_state: "member",
      login_recovery_source: "identity_map",
      data_quality_notes: "live note,second,note",
      billing_period: "live",
      row_source: "live_snapshot_only",
      history_confidence: "live_snapshot_only",
      total_cost: "20",
    });
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T04:21:33.096Z"));
    historyRepoState.hasMaterializedRows.mockReturnValue(true);
    historyRepoState.queryLicensePeriodExport.mockReturnValue(exportResult([makeDetailRow()]));

    const res = await GET(req(`${BASE_URL}?periods=2026-01&view=detail`));
    const text = await res.text();
    expect(text).toMatch(/^Report,/);
    expect(text).toContain("Period,2026-01");
    expect(text).toContain("View,detail");
    expect(text).toContain("Exported At,2026-08-10T04:21:33.096Z");
    // Rows are CRLF-separated, matching the RFC4180 requirement.
    expect(text).toContain("\r\n");
  });
});
