import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDateRange } from "@/lib/utils";

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({
  withRateLimit: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

const ZERO_USER_SUMMARY = {
  periodActiveUsers: 0,
  appActiveUsers: 0,
  adoptionRate: 0,
  sessions: 0,
  requests: 0,
  prompts: 0,
  promptTokens: 0,
  outputTokens: 0,
  avgTokensPerRequest: 0,
  codeGenerations: 0,
  codeAcceptances: 0,
  locAdded: 0,
  locDeleted: 0,
  locChanged: 0,
  supportedRows: 0,
};

const state = vi.hoisted(() => ({
  scope: {
    allowedLogins: undefined as Set<string> | undefined,
    enterpriseSlugs: undefined as string[] | undefined,
    hasFilter: false,
    selectedTeams: [] as string[],
    selectedOrgs: [] as string[],
  },
  estimate: { exceeds: false, count: 0 },
  effectiveEnterprises: 1,
  userSummary: {
    periodActiveUsers: 0,
    appActiveUsers: 0,
    adoptionRate: 0,
    sessions: 0,
    requests: 0,
    prompts: 0,
    promptTokens: 0,
    outputTokens: 0,
    avgTokensPerRequest: 0,
    codeGenerations: 0,
    codeAcceptances: 0,
    locAdded: 0,
    locDeleted: 0,
    locChanged: 0,
    supportedRows: 0,
  },
  adoptionRows: [] as { day: string; activeUsers: number; sessions: number; requests: number; prompts: number }[],
  codeImpactRows: [] as { day: string; generations: number; acceptances: number; locAdded: number; locDeleted: number }[],
  modelBreakdown: [] as { name: string; interactions: number }[],
  languageBreakdown: [] as { name: string; interactions: number }[],
  enterpriseDaily: [] as {
    day: string;
    sourceActiveUsers: number;
    activeUsers: number;
    sessions: number;
    requests: number;
    prompts: number;
    promptTokens: number;
    outputTokens: number;
    generations: number;
    acceptances: number;
    locAdded: number;
    locDeleted: number;
    isSupported: boolean;
  }[],
  orgDaily: [] as {
    day: string;
    sourceActiveUsers: number;
    activeUsers: number;
    sessions: number;
    requests: number;
    prompts: number;
    promptTokens: number;
    outputTokens: number;
    generations: number;
    acceptances: number;
    locAdded: number;
    locDeleted: number;
    isSupported: boolean;
  }[],
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  countEffectiveEnterprises: vi.fn(() => state.effectiveEnterprises),
}));

const getEnterpriseCopilotAppDaily = vi.fn(() => state.enterpriseDaily);
const getOrganizationCopilotAppDaily = vi.fn(() => state.orgDaily);

vi.mock("@/lib/db/copilot-app-queries", () => ({
  estimateCopilotAppRowCount: vi.fn(() => state.estimate),
  getCopilotAppUserSummary: vi.fn(() => state.userSummary),
  getCopilotAppDailyUsage: vi.fn(() => state.adoptionRows),
  getCopilotAppDailyCodeImpact: vi.fn(() => state.codeImpactRows),
  getCopilotAppModelBreakdown: vi.fn(() => state.modelBreakdown),
  getCopilotAppLanguageBreakdown: vi.fn(() => state.languageBreakdown),
  getEnterpriseCopilotAppDaily: (...args: unknown[]) => getEnterpriseCopilotAppDaily(...(args as [])),
  getOrganizationCopilotAppDaily: (...args: unknown[]) => getOrganizationCopilotAppDaily(...(args as [])),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function resetState() {
  state.scope = {
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
    hasFilter: false,
    selectedTeams: [],
    selectedOrgs: [],
  };
  state.estimate = { exceeds: false, count: 0 };
  state.effectiveEnterprises = 1;
  state.userSummary = { ...ZERO_USER_SUMMARY };
  state.adoptionRows = [];
  state.codeImpactRows = [];
  state.modelBreakdown = [];
  state.languageBreakdown = [];
  state.enterpriseDaily = [];
  state.orgDaily = [];
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/metrics/copilot-app", () => {
  it("returns 400 for invalid days", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=-5"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the row-count guard is exceeded", async () => {
    state.estimate = { exceeds: true, count: 999999 };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=90"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Result set too large");
  });

  it("returns a full user-level response with activity", async () => {
    const { end } = getDateRange(1);
    state.userSummary = {
      periodActiveUsers: 100,
      appActiveUsers: 40,
      adoptionRate: 40,
      sessions: 200,
      requests: 500,
      prompts: 300,
      promptTokens: 10000,
      outputTokens: 5000,
      avgTokensPerRequest: 30,
      codeGenerations: 80,
      codeAcceptances: 60,
      locAdded: 400,
      locDeleted: 50,
      locChanged: 450,
      supportedRows: 100,
    };
    state.adoptionRows = [{ day: end, activeUsers: 40, sessions: 200, requests: 500, prompts: 300 }];
    state.codeImpactRows = [{ day: end, generations: 80, acceptances: 60, locAdded: 400, locDeleted: 50 }];
    state.modelBreakdown = [{ name: "gpt-4", interactions: 50 }];
    state.languageBreakdown = [{ name: "typescript", interactions: 30 }];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasCopilotAppData).toBe(true);
    expect(json.dataSource).toBe("users");
    expect(json.capabilities).toEqual({
      adopters: true,
      scopedFiltering: true,
      modelBreakdown: true,
      languageBreakdown: true,
    });
    expect(json.kpis.periodActiveUsers).toBe(100);
    expect(json.kpis.appActiveUsers).toBe(40);
    expect(json.kpis.adoptionRate).toBe(40);
    expect(json.adoptionTrend).toHaveLength(1);
    expect(json.adoptionTrend[0]).toMatchObject({ activeUsers: 40, sessions: 200, requests: 500, prompts: 300 });
    expect(json.codeImpactTrend).toHaveLength(1);
    expect(json.codeImpactTrend[0]).toMatchObject({ generations: 80, acceptances: 60, locAdded: 400, locDeleted: 50 });
    expect(json.modelBreakdown).toEqual([{ name: "gpt-4", interactions: 50 }]);
    expect(json.languageBreakdown).toEqual([{ name: "typescript", interactions: 30 }]);
  });

  it("marks hasCopilotAppData true for a supported-but-zero-activity user scope", async () => {
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 5 };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasCopilotAppData).toBe(true);
    expect(json.dataSource).toBe("users");
    expect(json.kpis.periodActiveUsers).toBe(0);
    expect(json.kpis.sessions).toBe(0);
  });

  it("zero-fills every missing calendar day in the trends", async () => {
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 1 };
    // No adoption/code-impact rows returned — every day in a 7-day range must
    // still appear, zero-filled.
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    const json = await res.json();
    expect(json.adoptionTrend).toHaveLength(7);
    expect(json.adoptionTrend.every((p: { activeUsers: number }) => p.activeUsers === 0)).toBe(true);
    expect(json.codeImpactTrend).toHaveLength(7);
    expect(json.codeImpactTrend.every((p: { generations: number }) => p.generations === 0)).toBe(true);
  });

  it("returns a stable all-zero legacy response with dataSource none and HTTP 200 when no source exists", async () => {
    // supportedRows 0, no filter, single enterprise, but aggregate tables empty too.
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.enterpriseDaily = [];
    state.orgDaily = [];
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.hasCopilotAppData).toBe(false);
    expect(json.dataSource).toBe("none");
    expect(json.capabilities).toEqual({
      adopters: false,
      scopedFiltering: false,
      modelBreakdown: false,
      languageBreakdown: false,
    });
    expect(json.kpis).toMatchObject({ periodActiveUsers: 0, sessions: 0, adoptionRate: 0 });
    expect(json.adoptionTrend).toHaveLength(7);
    expect(json.codeImpactTrend).toHaveLength(7);
    expect(json.modelBreakdown).toEqual([]);
    expect(json.languageBreakdown).toEqual([]);
  });

  it("falls back to the enterprise aggregate when exactly one enterprise is in scope and no filter is active", async () => {
    const { end } = getDateRange(1);
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.effectiveEnterprises = 1;
    state.enterpriseDaily = [
      {
        day: end,
        sourceActiveUsers: 50,
        activeUsers: 20,
        sessions: 100,
        requests: 250,
        prompts: 150,
        promptTokens: 4000,
        outputTokens: 2000,
        generations: 40,
        acceptances: 30,
        locAdded: 200,
        locDeleted: 20,
        isSupported: true,
      },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=1"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.hasCopilotAppData).toBe(true);
    expect(json.dataSource).toBe("enterprise");
    expect(json.capabilities).toEqual({
      adopters: false,
      scopedFiltering: false,
      modelBreakdown: false,
      languageBreakdown: false,
    });
    expect(json.kpis.periodActiveUsers).toBe(50);
    expect(json.kpis.appActiveUsers).toBe(20);
    expect(json.kpis.adoptionRate).toBe(40); // 20/50*100
    expect(json.kpis.sessions).toBe(100);
    expect(json.modelBreakdown).toEqual([]);
    expect(json.languageBreakdown).toEqual([]);
    expect(json.adoptionTrend).toHaveLength(1);
    expect(json.adoptionTrend[0]).toMatchObject({ activeUsers: 20, sessions: 100 });
  });

  it("falls back to the organization aggregate when exactly one org is selected with a single enterprise", async () => {
    const { end } = getDateRange(1);
    state.scope = {
      allowedLogins: new Set(["alice", "bob"]),
      enterpriseSlugs: undefined,
      hasFilter: true,
      selectedTeams: [],
      selectedOrgs: ["acme-org"],
    };
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.effectiveEnterprises = 1;
    state.orgDaily = [
      {
        day: end,
        sourceActiveUsers: 10,
        activeUsers: 4,
        sessions: 20,
        requests: 50,
        prompts: 30,
        promptTokens: 800,
        outputTokens: 400,
        generations: 8,
        acceptances: 6,
        locAdded: 40,
        locDeleted: 4,
        isSupported: true,
      },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=1&orgs=acme-org"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("organization");
    expect(json.hasCopilotAppData).toBe(true);
    expect(json.kpis.periodActiveUsers).toBe(10);
    expect(json.kpis.appActiveUsers).toBe(4);
    expect(getOrganizationCopilotAppDaily).toHaveBeenCalledWith("acme-org", expect.any(String), expect.any(String), undefined);
  });

  it("never uses the aggregate fallback for a team-scoped filter, even if org/enterprise aggregate rows exist", async () => {
    state.scope = {
      allowedLogins: new Set(["alice"]),
      enterpriseSlugs: undefined,
      hasFilter: true,
      selectedTeams: ["platform-team"],
      selectedOrgs: [],
    };
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.effectiveEnterprises = 1;
    state.enterpriseDaily = [
      {
        day: "2026-01-01",
        sourceActiveUsers: 50,
        activeUsers: 20,
        sessions: 100,
        requests: 250,
        prompts: 150,
        promptTokens: 4000,
        outputTokens: 2000,
        generations: 40,
        acceptances: 30,
        locAdded: 200,
        locDeleted: 20,
        isSupported: true,
      },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7&teams=platform-team"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("none");
    expect(json.hasCopilotAppData).toBe(false);
    expect(getEnterpriseCopilotAppDaily).not.toHaveBeenCalled();
    expect(getOrganizationCopilotAppDaily).not.toHaveBeenCalled();
  });

  it("never uses the aggregate fallback when a filtered scope resolves to zero effective users", async () => {
    state.scope = {
      allowedLogins: new Set(),
      enterpriseSlugs: undefined,
      hasFilter: true,
      selectedTeams: [],
      selectedOrgs: ["empty-org"],
    };
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.effectiveEnterprises = 1;
    state.orgDaily = [
      {
        day: "2026-01-01",
        sourceActiveUsers: 10,
        activeUsers: 4,
        sessions: 20,
        requests: 50,
        prompts: 30,
        promptTokens: 800,
        outputTokens: 400,
        generations: 8,
        acceptances: 6,
        locAdded: 40,
        locDeleted: 4,
        isSupported: true,
      },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7&orgs=empty-org"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("none");
    expect(json.hasCopilotAppData).toBe(false);
    expect(getOrganizationCopilotAppDaily).not.toHaveBeenCalled();
  });

  it("never uses the aggregate fallback for an ambiguous multi-enterprise scope", async () => {
    state.scope = {
      allowedLogins: undefined,
      enterpriseSlugs: undefined,
      hasFilter: false,
      selectedTeams: [],
      selectedOrgs: [],
    };
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.effectiveEnterprises = 2;
    state.enterpriseDaily = [
      {
        day: "2026-01-01",
        sourceActiveUsers: 50,
        activeUsers: 20,
        sessions: 100,
        requests: 250,
        prompts: 150,
        promptTokens: 4000,
        outputTokens: 2000,
        generations: 40,
        acceptances: 30,
        locAdded: 200,
        locDeleted: 20,
        isSupported: true,
      },
    ];

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.dataSource).toBe("none");
    expect(json.hasCopilotAppData).toBe(false);
    expect(getEnterpriseCopilotAppDaily).not.toHaveBeenCalled();
  });

  it("includes Cache-Control headers for every 200 branch (users, aggregate, none)", async () => {
    const GET = await getHandler();

    // users branch
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 3 };
    let res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");

    // aggregate (enterprise) branch
    resetState();
    state.userSummary = { ...ZERO_USER_SUMMARY, supportedRows: 0 };
    state.enterpriseDaily = [
      {
        day: "2026-01-01",
        sourceActiveUsers: 5,
        activeUsers: 2,
        sessions: 10,
        requests: 20,
        prompts: 15,
        promptTokens: 100,
        outputTokens: 50,
        generations: 4,
        acceptances: 3,
        locAdded: 10,
        locDeleted: 1,
        isSupported: true,
      },
    ];
    res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");

    // none branch
    resetState();
    res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("propagates allowedLogins as an explicit empty array to the row-count guard and summary query (never unfiltered)", async () => {
    const { estimateCopilotAppRowCount, getCopilotAppUserSummary } = await import("@/lib/db/copilot-app-queries");
    state.scope = {
      allowedLogins: new Set(),
      enterpriseSlugs: undefined,
      hasFilter: true,
      selectedTeams: ["some-team"],
      selectedOrgs: [],
    };
    const GET = await getHandler();
    await GET(new NextRequest("http://localhost/api/metrics/copilot-app?days=7&teams=some-team"));

    expect(estimateCopilotAppRowCount).toHaveBeenCalledWith(expect.any(String), expect.any(String), [], undefined);
    expect(getCopilotAppUserSummary).toHaveBeenCalledWith(expect.any(String), expect.any(String), [], undefined);
  });
});
