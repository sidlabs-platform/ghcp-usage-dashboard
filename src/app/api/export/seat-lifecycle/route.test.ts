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
  result: { rows: [] as unknown[], truncated: false, total: 0 },
  throwOnRead: false,
}));

vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => state.scope),
}));

const getSeatLifecycleExportRows = vi.fn(() => {
  if (state.throwOnRead) throw new Error("no such table: copilot_seat_lifecycle_events");
  return state.result;
});

vi.mock("@/lib/db/seat-lifecycle-repo", () => ({
  getSeatLifecycleExportRows: (...args: unknown[]) => getSeatLifecycleExportRows(...(args as [])),
  SEAT_LIFECYCLE_EXPORT_MAX_ROWS: 5000,
}));

async function getHandler() {
  const route = await import("./route");
  return route.GET;
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/export/seat-lifecycle${query}`);
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    enterprise_slug: "ent-a",
    org_slug: "org-a",
    user_login: "alice",
    user_id: 1,
    event_type: "onboarded",
    event_date: "2025-01-05",
    occurred_at: "2025-01-05T09:00:00Z",
    plan_type: "business",
    assigning_team_slug: "team-a",
    assigning_team_name: "Team A",
    last_activity_at: "2025-01-06T10:00:00Z",
    source: "seat_created_at",
    ...overrides,
  };
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
  state.result = { rows: [], truncated: false, total: 0 };
  state.throwOnRead = false;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/export/seat-lifecycle", () => {
  it("emits a CSV with metadata, header and data rows", async () => {
    state.result = { rows: [makeRow(), makeRow({ user_login: "bob", event_type: "offboarded" })], truncated: false, total: 2 };

    const GET = await getHandler();
    const res = await GET(req("?start=2025-01-01&end=2025-01-31"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("seat-lifecycle-2025-01-01-to-2025-01-31-all.csv");
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    const csv = await res.text();
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Seat Onboarding & Offboarding");
    expect(lines[1]).toContain("2025-01-01 to 2025-01-31");
    expect(lines[5]).toBe(
      "event_type,event_date,user_login,user_id,enterprise,org,plan_type,assigning_team_slug,assigning_team_name,last_activity_at,occurred_at,source",
    );
    expect(lines[6]).toContain("alice");
    expect(lines[7]).toContain("bob");
  });

  it("emits a header-only CSV when there is no data", async () => {
    const GET = await getHandler();
    const res = await GET(req("?days=30"));

    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("event_type,event_date,user_login");
    expect(csv.split("\r\n")).toHaveLength(6);
  });

  it("degrades to an empty CSV instead of 500 when the ledger tables are missing", async () => {
    state.throwOnRead = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const GET = await getHandler();
    const res = await GET(req("?days=30"));

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("event_type,event_date,user_login");
    errorSpy.mockRestore();
  });

  it("rejects a result set that exceeds the row cap", async () => {
    state.result = { rows: [], truncated: true, total: 9001 };

    const GET = await getHandler();
    const res = await GET(req("?days=30"));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("9001 rows");
  });

  it("filters by event type and reflects it in the filename", async () => {
    const GET = await getHandler();
    const res = await GET(req("?start=2025-01-01&end=2025-01-31&eventType=offboarded"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("-offboarded.csv");
    expect(getSeatLifecycleExportRows).toHaveBeenCalledWith(expect.anything(), "offboarded");
  });

  it("returns 400 for an unknown event type", async () => {
    const GET = await getHandler();
    const res = await GET(req("?days=30&eventType=exploded"));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid eventType");
  });

  it("returns 400 for an invalid window", async () => {
    const GET = await getHandler();
    const res = await GET(req("?start=2025-03-01&end=2025-01-01"));
    expect(res.status).toBe(400);
  });

  it("escapes values that would otherwise break the CSV", async () => {
    state.result = {
      rows: [makeRow({ assigning_team_name: 'Team "A", EMEA' })],
      truncated: false,
      total: 1,
    };

    const GET = await getHandler();
    const csv = await (await GET(req("?days=30"))).text();

    expect(csv).toContain('"Team ""A"", EMEA"');
  });
});
