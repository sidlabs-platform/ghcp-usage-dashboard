import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

const scopeMock = vi.fn(() => ({
  allowedLogins: undefined as Set<string> | undefined,
  enterpriseSlugs: undefined as string[] | undefined,
  selectedTeams: [] as string[],
  selectedOrgs: [] as string[],
}));
vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (...args: unknown[]) =>
    (scopeMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/lib/config/dashboard-config", () => ({
  getLicensingConfig: vi.fn(() => ({ creditToUsd: 0.01, currency: "USD" })),
}));

const hasBillingCostDataMock = vi.fn(() => false);
const billingCostMock = vi.fn(() => [] as { phase: number; developers: number; total_cost_usd: number }[]);
const creditsCostMock = vi.fn(() => [] as { phase: number; developers: number; total_cost_usd: number }[]);
const countEnterprisesMock = vi.fn(() => 1);
const seatCostMock = vi.fn(() => 0);

vi.mock("@/lib/db/metrics-repo", () => ({
  countEffectiveEnterprises: (...a: unknown[]) =>
    (countEnterprisesMock as unknown as (...x: unknown[]) => unknown)(...a),
  hasBillingCostData: (...a: unknown[]) =>
    (hasBillingCostDataMock as unknown as (...x: unknown[]) => unknown)(...a),
  getPhaseCostFromBilling: (...a: unknown[]) =>
    (billingCostMock as unknown as (...x: unknown[]) => unknown)(...a),
  getPhaseCostFromCredits: (...a: unknown[]) =>
    (creditsCostMock as unknown as (...x: unknown[]) => unknown)(...a),
  getSeatCostPerUserMonth: (...a: unknown[]) =>
    (seatCostMock as unknown as (...x: unknown[]) => unknown)(...a),
}));

const getMock = vi.fn(() => undefined as unknown);
vi.mock("@/lib/db/database", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      get: getMock,
      all: vi.fn(() => []),
    })),
  })),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function call(query = "days=28") {
  return getHandler().then((GET) =>
    GET(new NextRequest(`http://localhost/api/metrics/roi?${query}`)),
  );
}

function phaseRow(phase: number, developers: number, cost: number) {
  return { phase, developers, total_cost_usd: cost };
}

/** Enterprise phase entry carrying `total_pull_requests_merged`. */
function mergedPhase(phase: number, merged: number | undefined) {
  return {
    phase,
    label: `Phase ${phase}`,
    version: "v1",
    engaged_users: 10,
    user_initiated_interaction_avg: 1,
    code_generation_activity_avg: 1,
    code_acceptance_activity_avg: 1,
    loc_added_avg: 1,
    loc_deleted_avg: 0,
    pull_requests_created_avg: 0.1,
    pull_requests_merged_avg: 0.1,
    pull_requests_reviewed_avg: 0.1,
    median_minutes_to_merge_avg: null,
    ...(merged === undefined ? {} : { total_pull_requests_merged: merged }),
  };
}

function mockEnterpriseRow(phases: ReturnType<typeof mergedPhase>[]) {
  getMock.mockReturnValue({ totals_by_ai_adoption_phase: JSON.stringify(phases) });
}

beforeEach(() => {
  scopeMock.mockReturnValue({
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
    selectedTeams: [],
    selectedOrgs: [],
  });
  countEnterprisesMock.mockReturnValue(1);
  hasBillingCostDataMock.mockReturnValue(false);
  billingCostMock.mockReturnValue([]);
  creditsCostMock.mockReturnValue([]);
  seatCostMock.mockReturnValue(0);
  getMock.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("roi cost sourcing", () => {
  it("uses billed AI Credit amounts when billing data exists", async () => {
    hasBillingCostDataMock.mockReturnValue(true);
    billingCostMock.mockReturnValue([phaseRow(1, 10, 280), phaseRow(2, 5, 280)]);

    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.costSource).toBe("billing");
    expect(creditsCostMock).not.toHaveBeenCalled();

    const early = json.groups.find((g: { key: string }) => g.key === "early");
    // 280 USD / 10 devs over 28 days, normalized to a 30.44-day month.
    expect(early.developers).toBe(10);
    expect(early.costPerDevPerMonth).toBeCloseTo((280 / 10) * (30.44 / 28), 5);
  });

  it("falls back to credit consumption when billing is not synced", async () => {
    hasBillingCostDataMock.mockReturnValue(false);
    creditsCostMock.mockReturnValue([phaseRow(1, 4, 40)]);

    const json = await (await call()).json();

    expect(json.costSource).toBe("credits");
    expect(billingCostMock).not.toHaveBeenCalled();
    expect(creditsCostMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      0.01,
      expect.anything(),
    );
    expect(json.creditToUsd).toBe(0.01);
  });

  it("reports costSource none when developers exist but no spend is attributed", async () => {
    creditsCostMock.mockReturnValue([phaseRow(1, 12, 0), phaseRow(3, 3, 0)]);

    const json = await (await call()).json();

    expect(json.hasData).toBe(true);
    expect(json.costSource).toBe("none");
    const early = json.groups.find((g: { key: string }) => g.key === "early");
    expect(early.developers).toBe(12);
    expect(early.costPerDevPerMonth).toBe(0);
  });

  it("returns an empty payload rather than a 500 when there is no phase data", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasData).toBe(false);
    expect(json.hasPrData).toBe(false);
    expect(json.costSource).toBe("none");
    expect(json.groups).toEqual([]);
  });
});

describe("roi grouping", () => {
  it("folds phases 0+1 into early and 2+3 into agent-first", async () => {
    creditsCostMock.mockReturnValue([
      phaseRow(0, 5, 10),
      phaseRow(1, 15, 30),
      phaseRow(2, 8, 80),
      phaseRow(3, 2, 20),
    ]);

    const json = await (await call()).json();

    const early = json.groups.find((g: { key: string }) => g.key === "early");
    const agent = json.groups.find((g: { key: string }) => g.key === "agent");

    expect(early.developers).toBe(20);
    expect(early.totalCostUsd).toBe(40);
    expect(early.phases).toEqual([0, 1]);

    expect(agent.developers).toBe(10);
    expect(agent.totalCostUsd).toBe(100);
    expect(agent.phases).toEqual([2, 3]);
  });
});

describe("roi merged pull requests", () => {
  it("normalizes merged PRs per developer against the 28-day rolling window", async () => {
    creditsCostMock.mockReturnValue([phaseRow(2, 10, 100)]);
    mockEnterpriseRow([mergedPhase(2, 140)]);

    const json = await (await call()).json();

    expect(json.hasPrData).toBe(true);
    const agent = json.groups.find((g: { key: string }) => g.key === "agent");
    expect(agent.prsMerged).toBe(140);
    expect(agent.prsMergedPerDevPerMonth).toBeCloseTo((140 / 10) * (30.44 / 28), 5);
  });

  it("keeps the PR normalization fixed at 28 days even for other ranges", async () => {
    creditsCostMock.mockReturnValue([phaseRow(2, 10, 100)]);
    mockEnterpriseRow([mergedPhase(2, 140)]);

    const json = await (await call("days=14")).json();

    const agent = json.groups.find((g: { key: string }) => g.key === "agent");
    expect(agent.prsMergedPerDevPerMonth).toBeCloseTo((140 / 10) * (30.44 / 28), 5);
    // Cost still normalizes against the requested range.
    expect(agent.costPerDevPerMonth).toBeCloseTo((100 / 10) * (30.44 / 14), 5);
  });

  it("sets hasPrData false when total_pull_requests_merged is absent (older data)", async () => {
    creditsCostMock.mockReturnValue([phaseRow(2, 10, 100)]);
    mockEnterpriseRow([mergedPhase(2, undefined)]);

    const json = await (await call()).json();

    expect(json.hasData).toBe(true);
    expect(json.hasPrData).toBe(false);
    const agent = json.groups.find((g: { key: string }) => g.key === "agent");
    expect(agent.prsMerged).toBe(0);
    expect(agent.prsMergedPerDevPerMonth).toBe(0);
  });

  it("suppresses PR figures across multiple unfiltered enterprises", async () => {
    countEnterprisesMock.mockReturnValue(3);
    creditsCostMock.mockReturnValue([phaseRow(2, 10, 100)]);
    mockEnterpriseRow([mergedPhase(2, 140)]);

    const json = await (await call()).json();

    expect(json.hasPrData).toBe(false);
    expect(json.groups.find((g: { key: string }) => g.key === "agent").prsMerged).toBe(0);
  });

  it("survives malformed adoption-phase JSON", async () => {
    creditsCostMock.mockReturnValue([phaseRow(2, 10, 100)]);
    getMock.mockReturnValue({ totals_by_ai_adoption_phase: "{not json" });

    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasPrData).toBe(false);
  });
});

describe("roi scope and validation", () => {
  it("returns an empty payload when a scope filter resolves to zero users", async () => {
    scopeMock.mockReturnValue({
      allowedLogins: new Set<string>(),
      enterpriseSlugs: undefined,
      selectedTeams: ["team-a"],
      selectedOrgs: [],
    });

    const res = await call();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasData).toBe(false);
    expect(json.filtered).toBe(true);
    expect(json.groups).toEqual([]);
    // Must not fall through to an unscoped query.
    expect(creditsCostMock).not.toHaveBeenCalled();
    expect(billingCostMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid days parameter with a 400", async () => {
    const res = await call("days=abc");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
