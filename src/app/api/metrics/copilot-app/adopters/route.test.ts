import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CopilotAppAdopter } from "@/lib/types/metrics";

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

const state = vi.hoisted(() => ({
  scope: {
    allowedLogins: undefined as Set<string> | undefined,
    enterpriseSlugs: undefined as string[] | undefined,
    hasFilter: false,
    selectedTeams: [] as string[],
    selectedOrgs: [] as string[],
  },
  estimate: { exceeds: false, count: 0 },
  adopters: [] as CopilotAppAdopter[],
  total: 0,
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

const estimateCopilotAppRowCount = vi.fn(() => state.estimate);
const getCopilotAppAdopters = vi.fn(() => ({ adopters: state.adopters, total: state.total }));

vi.mock("@/lib/db/copilot-app-queries", () => ({
  estimateCopilotAppRowCount: (...args: unknown[]) => estimateCopilotAppRowCount(...(args as [])),
  getCopilotAppAdopters: (...args: unknown[]) => getCopilotAppAdopters(...(args as [])),
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function makeAdopter(login: string, sessions: number): CopilotAppAdopter {
  return {
    login,
    activeDays: 3,
    sessions,
    requests: sessions * 2,
    prompts: sessions,
    promptTokens: sessions * 100,
    outputTokens: sessions * 50,
    locAdded: sessions * 5,
    locDeleted: sessions,
  };
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
  state.adopters = [];
  state.total = 0;
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/metrics/copilot-app/adopters", () => {
  it("returns 400 for invalid days", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=0"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the row-count guard is exceeded", async () => {
    state.estimate = { exceeds: true, count: 999999 };
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=90"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Result set too large");
  });

  it("returns a paginated adopters response with a nested pagination object", async () => {
    state.adopters = [makeAdopter("alice", 50), makeAdopter("bob", 30)];
    state.total = 2;

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=7&page=1&pageSize=25"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.adopters).toHaveLength(2);
    expect(json.adopters[0]).toMatchObject({ login: "alice", sessions: 50 });
    expect(json.pagination).toEqual({ page: 1, pageSize: 25, totalItems: 2, totalPages: 1 });
  });

  it("passes through page/pageSize/sort/sortDir/search to the query layer", async () => {
    const GET = await getHandler();
    await GET(
      new NextRequest(
        "http://localhost/api/metrics/copilot-app/adopters?days=7&page=3&pageSize=10&sort=locAdded&sortDir=asc&search=ali",
      ),
    );

    expect(getCopilotAppAdopters).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      3,
      10,
      "locAdded",
      "asc",
      "ali",
      undefined,
      undefined,
    );
  });

  it("falls back to sessions/desc defaults when sort params are absent", async () => {
    const GET = await getHandler();
    await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=7"));

    expect(getCopilotAppAdopters).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      1,
      50,
      "sessions",
      "desc",
      undefined,
      undefined,
      undefined,
    );
  });

  it("propagates an explicit empty allowedLogins array to the query layer — never unfiltered", async () => {
    state.scope = {
      allowedLogins: new Set(),
      enterpriseSlugs: undefined,
      hasFilter: true,
      selectedTeams: ["empty-team"],
      selectedOrgs: [],
    };
    state.adopters = [];
    state.total = 0;

    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=7&teams=empty-team"));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.adopters).toEqual([]);
    expect(json.pagination.totalItems).toBe(0);
    expect(getCopilotAppAdopters).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
      expect.any(String),
      undefined,
      [],
      undefined,
    );
  });

  it("returns an empty but valid 200 response when no adopters exist (legacy/no-support case)", async () => {
    state.adopters = [];
    state.total = 0;
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.adopters).toEqual([]);
    expect(json.pagination).toEqual({ page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
  });

  it("includes Cache-Control headers", async () => {
    const GET = await getHandler();
    const res = await GET(new NextRequest("http://localhost/api/metrics/copilot-app/adopters?days=7"));
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });
});
