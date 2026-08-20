import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  scope: {
    selectedTeams: [] as string[],
    selectedOrgs: [] as string[],
    selectedEnterprises: [] as string[],
    hasFilter: false,
    allowedLogins: undefined as Set<string> | undefined,
    enterpriseSlugs: undefined as string[] | undefined,
  },
  stats: {
    onboardedUsers: 0,
    offboardedUsers: 0,
    onboardedEvents: 0,
    offboardedEvents: 0,
    netChange: 0,
    churnRate: null as number | null,
  },
  trend: [] as unknown[],
  rows: {} as Record<string, { rows: unknown[]; total: number }>,
  coverage: { source: "none", trackingStartedAt: null as string | null, onboardingOnly: false },
  throwOnRead: false,
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

const getSeatLifecycleStats = vi.fn(() => {
  if (state.throwOnRead) throw new Error("no such table: copilot_seat_lifecycle_events");
  return state.stats;
});
const getSeatLifecycleTrend = vi.fn(() => state.trend);
const getSeatLifecycleRows = vi.fn((_q: unknown, eventType: string) => state.rows[eventType] ?? { rows: [], total: 0 });
const getSeatLifecycleCoverage = vi.fn(() => state.coverage);

vi.mock("@/lib/db/seat-lifecycle-repo", () => ({
  getSeatLifecycleStats: (...args: unknown[]) => getSeatLifecycleStats(...(args as [])),
  getSeatLifecycleTrend: (...args: unknown[]) => getSeatLifecycleTrend(...(args as [])),
  getSeatLifecycleRows: (...args: [unknown, string, unknown]) => getSeatLifecycleRows(...args),
  getSeatLifecycleCoverage: (...args: unknown[]) => getSeatLifecycleCoverage(...(args as [])),
  SEAT_LIFECYCLE_SORT_COLUMNS: ["event_date", "user_login", "org_slug", "plan_type", "last_activity_at", "assigning_team_name"],
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/seats/lifecycle${query}`);
}

beforeEach(() => {
  state.scope = {
    selectedTeams: [],
    selectedOrgs: [],
    selectedEnterprises: [],
    hasFilter: false,
    allowedLogins: undefined,
    enterpriseSlugs: undefined,
  };
  state.stats = {
    onboardedUsers: 0,
    offboardedUsers: 0,
    onboardedEvents: 0,
    offboardedEvents: 0,
    netChange: 0,
    churnRate: null,
  };
  state.trend = [];
  state.rows = {};
  state.coverage = { source: "none", trackingStartedAt: null, onboardingOnly: false };
  state.throwOnRead = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/seats/lifecycle", () => {
  it("returns a valid zeroed payload when the ledger is empty", async () => {
    const GET = await getHandler();
    const res = await GET(req("?days=30"));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stats.onboardedUsers).toBe(0);
    expect(json.stats.churnRate).toBeNull();
    expect(json.trend).toEqual([]);
    expect(json.onboarded.rows).toEqual([]);
    expect(json.offboarded.rows).toEqual([]);
    expect(json.coverage.source).toBe("none");
    expect(json.available).toBe(true);
    expect(res.headers.get("Cache-Control")).toContain("max-age=300");
  });

  it("never 500s when the ledger tables do not exist yet", async () => {
    state.throwOnRead = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const GET = await getHandler();
    const res = await GET(req("?days=30"));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.available).toBe(false);
    expect(json.stats.onboardedUsers).toBe(0);
    expect(json.coverage.source).toBe("none");
    errorSpy.mockRestore();
  });

  it("returns onboarded and offboarded rows with independent pagination", async () => {
    state.rows = {
      onboarded: { rows: [{ user_login: "alice", event_type: "onboarded" }], total: 3 },
      offboarded: { rows: [{ user_login: "bob", event_type: "offboarded" }], total: 7 },
    };
    state.stats = {
      onboardedUsers: 3,
      offboardedUsers: 7,
      onboardedEvents: 3,
      offboardedEvents: 7,
      netChange: -4,
      churnRate: 5.2,
    };

    const GET = await getHandler();
    const res = await GET(req("?days=30&pageSize=2&onboardedPage=1&offboardedPage=3"));
    const json = await res.json();

    expect(json.onboarded.rows[0].user_login).toBe("alice");
    expect(json.onboarded.pagination).toMatchObject({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });
    expect(json.offboarded.pagination).toMatchObject({ page: 3, pageSize: 2, totalItems: 7, totalPages: 4 });
    expect(json.stats.netChange).toBe(-4);
    expect(json.stats.churnRate).toBe(5.2);
  });

  it("honours an explicit start/end window over the days preset", async () => {
    const GET = await getHandler();
    const res = await GET(req("?days=30&start=2025-01-01&end=2025-01-31"));
    const json = await res.json();

    expect(json.window).toEqual({ start: "2025-01-01", end: "2025-01-31", explicit: true });
    expect(getSeatLifecycleStats).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2025-01-01", end: "2025-01-31" }),
    );
  });

  it("includes today in the default preset window", async () => {
    const GET = await getHandler();
    const res = await GET(req("?days=7"));
    const json = await res.json();

    // Lifecycle events can be recorded today, unlike lagging usage metrics.
    expect(json.window.end).toBe(new Date().toISOString().split("T")[0]);
    expect(json.window.explicit).toBe(false);
  });

  it("returns 400 when only one of start/end is supplied", async () => {
    const GET = await getHandler();
    const res = await GET(req("?start=2025-01-01"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("must be provided together");
  });

  it("returns 400 when end is before start", async () => {
    const GET = await getHandler();
    const res = await GET(req("?start=2025-02-01&end=2025-01-01"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("on or before");
  });

  it("returns 400 for a malformed date", async () => {
    const GET = await getHandler();
    const res = await GET(req("?start=01-01-2025&end=2025-01-31"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("YYYY-MM-DD");
  });

  it("returns 400 for an invalid days value", async () => {
    const GET = await getHandler();
    expect((await GET(req("?days=abc"))).status).toBe(400);
    expect((await GET(req("?days=99999"))).status).toBe(400);
  });

  it("rejects a sort column outside the allowlist", async () => {
    const GET = await getHandler();
    const res = await GET(req("?sort=user_login%3B+DROP+TABLE"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid sort column");
  });

  it("passes scope filters through to the repository", async () => {
    state.scope = {
      selectedTeams: ["team-a"],
      selectedOrgs: ["org-a"],
      selectedEnterprises: ["ent-a"],
      hasFilter: true,
      allowedLogins: new Set(["alice"]),
      enterpriseSlugs: ["ent-a"],
    };

    const GET = await getHandler();
    const res = await GET(req("?days=30&teams=team-a&orgs=org-a&enterprises=ent-a"));
    const json = await res.json();

    expect(json.filtered).toBe(true);
    expect(getSeatLifecycleStats).toHaveBeenCalledWith(
      expect.objectContaining({
        enterpriseSlugs: ["ent-a"],
        orgs: ["org-a"],
        allowedLogins: new Set(["alice"]),
      }),
    );
    expect(getSeatLifecycleCoverage).toHaveBeenCalledWith(["ent-a"]);
  });

  it("clamps page size and page number to sane bounds", async () => {
    const GET = await getHandler();
    await GET(req("?days=30&pageSize=100000&onboardedPage=-4"));

    expect(getSeatLifecycleRows).toHaveBeenCalledWith(
      expect.anything(),
      "onboarded",
      expect.objectContaining({ page: 1, pageSize: 200 }),
    );
  });

  it("surfaces the coverage banner data for snapshot-diff-only installs", async () => {
    state.coverage = { source: "sync_diff", trackingStartedAt: "2025-05-01T00:00:00Z", onboardingOnly: false };

    const GET = await getHandler();
    const json = await (await GET(req("?days=30"))).json();

    expect(json.coverage).toEqual({
      source: "sync_diff",
      trackingStartedAt: "2025-05-01T00:00:00Z",
      onboardingOnly: false,
    });
  });
});
