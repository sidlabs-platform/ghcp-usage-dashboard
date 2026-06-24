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

const routePromise = import("./route");

beforeEach(() => {
  mockState.rangeResult = { start: "2024-01-01", end: "2024-01-07" };
  mockState.prepare.mockImplementation((sql: string) => {
    if (sql.includes("SELECT team_slug, team_name, org_slug")) {
      return {
        get: vi.fn(() => ({
          team_slug: "eng",
          team_name: "Engineering",
          org_slug: "platform",
        })),
      };
    }
    if (sql.includes("COUNT(DISTINCT user_login)")) {
      return { get: vi.fn(() => ({ cnt: 2 })) };
    }
    if (sql.includes("WITH team_logins AS")) {
      return {
        all: vi.fn(() => [
          {
            login: "octocat",
            activeDays: 5,
            locAdded: 100,
            interactions: 10,
            acceptanceRate: 50,
            usedAgent: 1,
            usedChat: 1,
            usedCli: 0,
            usedCodeReview: 0,
          },
          {
            login: "hubot",
            activeDays: 0,
            locAdded: 0,
            interactions: 0,
            acceptanceRate: 0,
            usedAgent: 0,
            usedChat: 0,
            usedCli: 1,
            usedCodeReview: 0,
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

describe("team detail route", { timeout: 10000 }, () => {
  it("returns team members and derived aggregates", async () => {
    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/teams/eng?days=7"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      team: {
        slug: "eng",
        name: "Engineering",
        org: "platform",
        memberCount: 2,
      },
      members: [
        {
          login: "octocat",
          activeDays: 5,
          locAdded: 100,
          interactions: 10,
          acceptanceRate: 50,
          usedAgent: 1,
          usedChat: 1,
          usedCli: 0,
          usedCodeReview: 0,
        },
        {
          login: "hubot",
          activeDays: 0,
          locAdded: 0,
          interactions: 0,
          acceptanceRate: 0,
          usedAgent: 0,
          usedChat: 0,
          usedCli: 1,
          usedCodeReview: 0,
        },
      ],
      aggregates: {
        totalLocAdded: 100,
        avgAcceptanceRate: 50,
        agentAdoption: 50,
        chatAdoption: 50,
        cliAdoption: 50,
        activeMembers: 1,
      },
    });
  });

  it("returns an empty team payload when the slug is unknown", async () => {
    mockState.prepare.mockImplementation((sql: string) => {
      if (sql.includes("SELECT team_slug, team_name, org_slug")) {
        return { get: vi.fn(() => undefined) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/teams/missing?days=7"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      team: null,
      members: [],
      aggregates: null,
    });
  });
});
