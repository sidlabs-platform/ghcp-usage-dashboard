/**
 * The Billing page and the License & AI Credits page used to quote different
 * Copilot spend for what a user believed was the same window, because Billing
 * resolved a rolling `days` range while Licensing resolved calendar `YYYY-MM`
 * periods. The two only ever coincided by accident.
 *
 * Both routes now derive their cost basis from `monthBounds()` and the single
 * shared `getCopilotCostBasis()` query. This test pins that contract at the
 * route boundary: for the same selected month, both endpoints must ask for the
 * *same window* and surface the *same* `costBasis` object.
 *
 * It deliberately asserts on the arguments rather than only the output — a
 * shared query called over two different windows would still return two
 * self-consistent-looking answers, which is exactly the bug this prevents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const PERIOD = "2026-08";

const costBasisSpy = vi.hoisted(() => vi.fn());

const configState = vi.hoisted(() => ({
  isBillingSubEnabledForAnyEnterprise: vi.fn(),
  isMetricEnabledForAnyEnterprise: vi.fn(),
  getLicensingConfig: vi.fn(),
  getEnterpriseSlugs: vi.fn(),
}));

const repoState = vi.hoisted(() => ({
  getLicenseReconciliationDataset: vi.fn(),
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
  getMaterializedPeriods: vi.fn(),
  getEarliestMaterializedPeriod: vi.fn(),
  getMaterializedUtilizationBuckets: vi.fn(),
  getLatestLicenseQualitySummary: vi.fn(),
  hasMaterializedRows: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/config/enterprise-config", () => ({
  isBillingSubEnabledForAnyEnterprise: (...a: unknown[]) =>
    configState.isBillingSubEnabledForAnyEnterprise(...a),
  isMetricEnabledForAnyEnterprise: (...a: unknown[]) =>
    configState.isMetricEnabledForAnyEnterprise(...a),
  getEnterpriseSlugs: (...a: unknown[]) => configState.getEnterpriseSlugs(...a),
}));

vi.mock("@/lib/config/dashboard-config", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/config/dashboard-config")>(
      "@/lib/config/dashboard-config"
    );
  return {
    ...actual,
    getLicensingConfig: (...a: unknown[]) => configState.getLicensingConfig(...a),
  };
});

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: () => ({
    selectedTeams: [],
    selectedOrgs: [],
    selectedEnterprises: [],
    hasFilter: false,
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
  }),
}));

vi.mock("@/lib/db/teams-repo", () => ({ resolveFilteredUsers: () => [] }));

// One shared module mock serves both routes, mirroring production: there is a
// single `getCopilotCostBasis` implementation and both surfaces call it.
vi.mock("@/lib/db/billing-repo", () => ({
  getCopilotCostBasis: (...a: unknown[]) => costBasisSpy(...a),
  getOverviewKPIs: () => ({}),
  getDailyAggregates: () => [],
  getProductBreakdown: () => [],
  getOrgBreakdown: () => [],
  getUserBreakdown: () => [],
  getCostCenterBreakdown: () => [],
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
  DETAIL_SORT_COLUMNS: ["billing_period"],
  ROLLUP_SORT_COLUMNS: ["resolved_user_login"],
  queryLicensePeriodRows: (...a: unknown[]) => historyRepoState.queryLicensePeriodRows(...a),
  getMaterializedPeriodKPIs: (...a: unknown[]) => historyRepoState.getMaterializedPeriodKPIs(...a),
  getMaterializedPlanBreakdown: (...a: unknown[]) =>
    historyRepoState.getMaterializedPlanBreakdown(...a),
  getMaterializedOrgBreakdown: (...a: unknown[]) =>
    historyRepoState.getMaterializedOrgBreakdown(...a),
  getMaterializedPeriods: (...a: unknown[]) => historyRepoState.getMaterializedPeriods(...a),
  getEarliestMaterializedPeriod: (...a: unknown[]) =>
    historyRepoState.getEarliestMaterializedPeriod(...a),
  getMaterializedUtilizationBuckets: (...a: unknown[]) =>
    historyRepoState.getMaterializedUtilizationBuckets(...a),
  getLatestLicenseQualitySummary: (...a: unknown[]) =>
    historyRepoState.getLatestLicenseQualitySummary(...a),
  hasMaterializedRows: (...a: unknown[]) => historyRepoState.hasMaterializedRows(...a),
}));

import { GET as billingGET } from "./overview/route";
import { GET as licenseGET } from "./license-reconciliation/route";

const BASIS = {
  startDate: "2026-08-01",
  endDate: "2026-08-20",
  period: PERIOD,
  seatCostNet: 37692.29,
  seatCostGross: 37692.29,
  seatQuantity: 969,
  creditsBilled: 130629.24,
  creditCostNet: 0,
  creditCostGross: 1306.29,
  creditsAttributed: 128264.64,
  attributedUsers: 32,
  attributionCoveragePct: 98.19,
  attributionComplete: false,
  totalCopilotNet: 37692.29,
};

beforeEach(() => {
  costBasisSpy.mockReturnValue(BASIS);
  configState.isBillingSubEnabledForAnyEnterprise.mockReturnValue(true);
  configState.isMetricEnabledForAnyEnterprise.mockReturnValue(true);
  configState.getEnterpriseSlugs.mockReturnValue(["acme"]);
  configState.getLicensingConfig.mockReturnValue({
    currency: "USD",
    creditToUsd: 0.01,
    history: { auditRetentionDays: 400 },
  });
  repoState.getLicenseReconciliationDataset.mockReturnValue({ rows: [], coverage: { attributedCredits: 0, attributedUsd: 0, matchedCredits: 0, matchedUsd: 0, unmatchedCredits: 0, unmatchedUsd: 0, unmatchedUsers: 0 } });
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
  historyRepoState.getMaterializedPeriods.mockReturnValue([]);
  historyRepoState.getEarliestMaterializedPeriod.mockReturnValue(null);
  historyRepoState.getMaterializedUtilizationBuckets.mockReturnValue([]);
  historyRepoState.getLatestLicenseQualitySummary.mockReturnValue({
    pass: 0,
    warning: 0,
    fail: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function billingBasis(period: string) {
  const res = await billingGET(
    new NextRequest(`http://localhost/api/billing/overview?period=${period}`)
  );
  return { res, body: await res.json(), args: costBasisSpy.mock.calls.at(-1) };
}

async function licenseBasis(period: string) {
  const res = await licenseGET(
    new NextRequest(
      `http://localhost/api/billing/license-reconciliation?periods=${period}`
    )
  );
  return { res, body: await res.json(), args: costBasisSpy.mock.calls.at(-1) };
}

describe("Billing and License & AI Credits agree on Copilot cost", () => {
  it("asks for the identical window when the same month is selected", async () => {
    const billing = await billingBasis(PERIOD);
    vi.clearAllMocks();
    costBasisSpy.mockReturnValue(BASIS);
    const license = await licenseBasis(PERIOD);

    expect(billing.args).toBeDefined();
    expect(license.args).toBeDefined();

    // Arg 0 = window start, arg 1 = window end. These are what used to diverge.
    expect(billing.args![0]).toBe("2026-08-01");
    expect(license.args![0]).toBe(billing.args![0]);
    expect(license.args![1]).toBe(billing.args![1]);
  });

  it("surfaces the identical costBasis payload on both endpoints", async () => {
    const billing = await billingBasis(PERIOD);
    const license = await licenseBasis(PERIOD);

    expect(billing.body.costBasis).toEqual(BASIS);
    expect(license.body.costBasis).toEqual(billing.body.costBasis);
  });

  it("pins the Billing window to the calendar month, not a rolling range", async () => {
    // Derived from "today" so the assertion cannot rot: two months back is
    // always fully elapsed, so it must report the month's true last day.
    const now = new Date();
    const past = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const pastPeriod = `${past.getUTCFullYear()}-${String(past.getUTCMonth() + 1).padStart(2, "0")}`;
    const lastDay = new Date(Date.UTC(past.getUTCFullYear(), past.getUTCMonth() + 1, 0))
      .getUTCDate();

    const { body } = await billingBasis(pastPeriod);
    expect(body.period).toBe(pastPeriod);
    expect(body.startDate).toBe(`${pastPeriod}-01`);
    expect(body.endDate).toBe(`${pastPeriod}-${lastDay}`);
  });

  it("clamps an in-progress month to today so per-day averages stay honest", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const currentPeriod = today.slice(0, 7);

    const { body } = await billingBasis(currentPeriod);
    expect(body.startDate).toBe(`${currentPeriod}-01`);
    // Never advertise a window that runs into the future.
    expect(body.endDate <= today).toBe(true);
  });

  it("rejects a malformed period instead of silently falling back to a rolling window", async () => {
    const res = await billingGET(
      new NextRequest("http://localhost/api/billing/overview?period=2026-13")
    );
    expect(res.status).toBe(400);
    expect(costBasisSpy).not.toHaveBeenCalled();
  });

  it("keeps rendering the page when the shared cost query fails", async () => {
    costBasisSpy.mockImplementation(() => {
      throw new Error("billing_usage_records is missing");
    });

    const billing = await billingGET(
      new NextRequest(`http://localhost/api/billing/overview?period=${PERIOD}`)
    );
    const license = await licenseGET(
      new NextRequest(
        `http://localhost/api/billing/license-reconciliation?periods=${PERIOD}`
      )
    );

    expect(billing.status).toBe(200);
    expect(license.status).toBe(200);
    expect((await billing.json()).costBasis).toBeNull();
    expect((await license.json()).costBasis).toBeNull();
  });
});
