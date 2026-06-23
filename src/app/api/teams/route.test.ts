import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  rangeResult: { start: "2024-01-01", end: "2024-01-07" } as
    | { start: string; end: string }
    | { error: string },
  prepare: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({
  withCache: (handler: unknown) => handler,
}));

vi.mock("@/lib/api/timeout", () => ({
  withTimeout: (handler: unknown) => handler,
}));

vi.mock("@/lib/cache/memory-cache", () => ({
  CACHE_TTL: { MEDIUM: 300 },
}));

vi.mock("@/lib/utils", () => ({
  parseDateRangeParams: vi.fn(() => mockState.rangeResult),
}));

vi.mock("@/lib/db/database", () => ({
  getDb: vi.fn(() => ({
    prepare: mockState.prepare,
  })),
}));

vi.mock("@/lib/db/teams-repo", () => ({
  getAllTeamsWithMembers: vi.fn(() => []),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  getAllUserMetrics: vi.fn(() => []),
}));

vi.mock("@/lib/aggregation/team-metrics", () => ({
  computeTeamSummary: vi.fn(),
}));

vi.mock("@/lib/db/summary-tables", () => ({
  refreshTeamSummary: vi.fn(),
}));

const routePromise = import("./route");

beforeEach(() => {
  mockState.rangeResult = { start: "2024-01-01", end: "2024-01-07" };
  mockState.prepare.mockImplementation((sql: string) => {
    if (sql.includes("SELECT 1 FROM team_summary_cache")) {
      return { get: vi.fn(() => ({ exists: 1 })) };
    }
    if (sql.includes("COUNT(*) as total")) {
      return { get: vi.fn(() => ({ total: 2 })) };
    }
    if (sql.includes("FROM team_summary_cache")) {
      return {
        all: vi.fn(() => [
          {
            team_slug: "eng",
            team_name: "Engineering",
            source: "enterprise",
            org_slug: "platform",
            total_members: 12,
            avg_daily_active_users: 8,
            total_loc_added: 500,
            total_interactions: 120,
            overall_acceptance_rate: 61.2,
            agent_adoption_rate: 50,
            chat_adoption_rate: 75,
            cli_adoption_rate: 25,
            code_review_adoption_rate: 33.3,
          },
          {
            team_slug: "ops",
            team_name: "Operations",
            source: "org",
            org_slug: "platform",
            total_members: 6,
            avg_daily_active_users: 3,
            total_loc_added: 120,
            total_interactions: 40,
            overall_acceptance_rate: 44.4,
            agent_adoption_rate: 20,
            chat_adoption_rate: 30,
            cli_adoption_rate: 10,
            code_review_adoption_rate: 15,
          },
        ]),
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("teams route", { timeout: 10000 }, () => {
  it("serves cached team summaries with normalized pagination", async () => {
    const { GET } = await routePromise;
    const response = await GET(
      new NextRequest(
        "http://localhost/api/teams?days=7&teams=eng,ops&orgs=platform&enterprises=ent-a&page=0&pageSize=999&sort=teamName&sortDir=asc",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teams: [
        {
          teamSlug: "eng",
          teamName: "Engineering",
          source: "enterprise",
          orgSlug: "platform",
          totalMembers: 12,
          avgDailyActiveUsers: 8,
          totalLocAdded: 500,
          totalInteractions: 120,
          overallAcceptanceRate: 61.2,
          agentAdoptionRate: 50,
          chatAdoptionRate: 75,
          cliAdoptionRate: 25,
          codeReviewAdoptionRate: 33.3,
        },
        {
          teamSlug: "ops",
          teamName: "Operations",
          source: "org",
          orgSlug: "platform",
          totalMembers: 6,
          avgDailyActiveUsers: 3,
          totalLocAdded: 120,
          totalInteractions: 40,
          overallAcceptanceRate: 44.4,
          agentAdoptionRate: 20,
          chatAdoptionRate: 30,
          cliAdoptionRate: 10,
          codeReviewAdoptionRate: 15,
        },
      ],
      pagination: {
        page: 1,
        pageSize: 200,
        totalItems: 2,
        totalPages: 1,
      },
    });
  });

  it("returns validation errors from date parsing", async () => {
    mockState.rangeResult = { error: "Invalid date range." };

    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/teams?days=0"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid date range." });
  });
});
