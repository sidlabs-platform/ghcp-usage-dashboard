import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDateRange } from "@/lib/utils";

const state = vi.hoisted(() => ({
  scope: { allowedLogins: undefined as Set<string> | undefined, enterpriseSlugs: undefined as string[] | undefined, hasFilter: false },
  estimate: { exceeds: false, count: 0 },
  trendRows: [] as {
    day: string;
    completionSuggested: number;
    completionAccepted: number;
    agentAdded: number;
    agentDeleted: number;
    compGenCount: number;
    compAcceptCount: number;
    appAdded: number;
    appDeleted: number;
    appGenCount: number;
    appAcceptCount: number;
  }[],
  languageBreakdown: [] as unknown[],
  featureBreakdown: [] as unknown[],
  modelBreakdown: [] as unknown[],
  totals: {
    day: "",
    completionSuggested: 0,
    completionAccepted: 0,
    agentAdded: 0,
    agentDeleted: 0,
    compGenCount: 0,
    compAcceptCount: 0,
    appAdded: 0,
    appDeleted: 0,
    appGenCount: 0,
    appAcceptCount: 0,
  },
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  estimateRowCount: vi.fn(() => state.estimate),
  getCompletionDailyTrend: vi.fn(() => state.trendRows),
  getCompletionTotals: vi.fn(() => state.totals),
  getLanguageBreakdown: vi.fn(() => state.languageBreakdown),
  getFeatureBreakdown: vi.fn(() => state.featureBreakdown),
  getModelBreakdown: vi.fn(() => state.modelBreakdown),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

beforeEach(() => {
  state.scope = { allowedLogins: undefined, enterpriseSlugs: undefined, hasFilter: false };
  state.estimate = { exceeds: false, count: 0 };
  state.trendRows = [];
  state.languageBreakdown = [];
  state.featureBreakdown = [];
  state.modelBreakdown = [];
  state.totals = {
    day: "",
    completionSuggested: 0,
    completionAccepted: 0,
    agentAdded: 0,
    agentDeleted: 0,
    compGenCount: 0,
    compAcceptCount: 0,
    appAdded: 0,
    appDeleted: 0,
    appGenCount: 0,
    appAcceptCount: 0,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/metrics/code-generation", () => {
  it("returns valid empty response when no data exists", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dailyTrend).toHaveLength(7);
    expect(json.dailyTrend[0]).toMatchObject({ appAdded: 0, appDeleted: 0 });
    expect(json.kpis.appLocAdded).toBe(0);
    expect(json.kpis.appLocDeleted).toBe(0);
    expect(json.kpis.appCodeGenerations).toBe(0);
    expect(json.kpis.totalLocChanged).toBe(0);
  });

  it("returns 400 when the row-count guard is exceeded", async () => {
    state.estimate = { exceeds: true, count: 999999 };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=90"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid days", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=-5"));
    expect(res.status).toBe(400);
  });

  it("exposes daily appAdded/appDeleted in the dailyTrend series", async () => {
    const { end } = getDateRange(1);
    state.trendRows = [
      {
        day: end,
        completionSuggested: 100,
        completionAccepted: 80,
        agentAdded: 50,
        agentDeleted: 10,
        compGenCount: 20,
        compAcceptCount: 15,
        appAdded: 30,
        appDeleted: 4,
        appGenCount: 6,
        appAcceptCount: 5,
      },
    ];
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=1"));
    const json = await res.json();
    // days=1 yields exactly one dailyTrend entry for "today" — the mocked row's
    // `day` value is irrelevant to matching here since the map falls back to `day`
    // key lookups against the real date range, so we assert on the first entry.
    expect(json.dailyTrend).toHaveLength(1);
    expect(json.dailyTrend[0]).toMatchObject({ appAdded: 30, appDeleted: 4 });
  });

  it("an App-only feature cannot change completion acceptance rate", async () => {
    // App-heavy data: huge App gen/accept counts, small completion counts.
    // If App leaked into compGenCount/compAcceptCount, the rate would be
    // deflated/inflated. It must stay exactly completion-only (15/20 = 75%).
    state.totals = {
      day: "",
      completionSuggested: 200,
      completionAccepted: 150,
      agentAdded: 500,
      agentDeleted: 100,
      compGenCount: 20,
      compAcceptCount: 15,
      appAdded: 9000,
      appDeleted: 800,
      appGenCount: 9999,
      appAcceptCount: 1, // if this leaked in, rate would collapse toward 0
    };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    const json = await res.json();
    expect(json.kpis.completionAcceptanceRate).toBe(75); // 15 / 20 * 100, unaffected by App
  });

  it("computes totalLocChanged as completion + agent + App (added + deleted)", async () => {
    state.totals = {
      day: "",
      completionSuggested: 200,
      completionAccepted: 150,
      agentAdded: 500,
      agentDeleted: 100,
      compGenCount: 20,
      compAcceptCount: 15,
      appAdded: 60,
      appDeleted: 8,
      appGenCount: 9,
      appAcceptCount: 7,
    };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    const json = await res.json();
    // 150 (completionAccepted) + 500 (agentAdded) + 100 (agentDeleted) + 60 (appAdded) + 8 (appDeleted)
    expect(json.kpis.totalLocChanged).toBe(818);
    expect(json.kpis.appLocAdded).toBe(60);
    expect(json.kpis.appLocDeleted).toBe(8);
    expect(json.kpis.appCodeGenerations).toBe(9);
  });

  it("computes agentLocShare with completionAccepted + agentAdded + appAdded as the denominator", async () => {
    state.totals = {
      day: "",
      completionSuggested: 200,
      completionAccepted: 150,
      agentAdded: 500,
      agentDeleted: 100,
      compGenCount: 20,
      compAcceptCount: 15,
      appAdded: 350,
      appDeleted: 8,
      appGenCount: 9,
      appAcceptCount: 7,
    };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    const json = await res.json();
    // 500 / (150 + 500 + 350) * 100 = 500 / 1000 * 100 = 50
    expect(json.kpis.agentLocShare).toBe(50);
  });

  it("guards agentLocShare against a zero denominator", async () => {
    state.totals = {
      day: "",
      completionSuggested: 0,
      completionAccepted: 0,
      agentAdded: 0,
      agentDeleted: 0,
      compGenCount: 0,
      compAcceptCount: 0,
      appAdded: 0,
      appDeleted: 0,
      appGenCount: 0,
      appAcceptCount: 0,
    };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    const json = await res.json();
    expect(json.kpis.agentLocShare).toBe(0);
  });

  it("includes Cache-Control headers", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/code-generation?days=7"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });
});
