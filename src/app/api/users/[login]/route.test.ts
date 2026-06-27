import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockState = vi.hoisted(() => ({
  rangeResult: { start: "2024-01-01", end: "2024-01-07" } as
    | { start: string; end: string }
    | { error: string },
  scopeFilter: {
    allowedLogins: new Set(["octocat"]),
    enterpriseSlugs: ["ent-a"],
  },
  prepare: vi.fn(),
}));

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

vi.mock("@/lib/utils", () => ({
  parseDateRangeParams: vi.fn(() => mockState.rangeResult),
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => mockState.scopeFilter),
}));

vi.mock("@/lib/db/database", () => ({
  getDb: vi.fn(() => ({
    prepare: mockState.prepare,
  })),
}));

const routePromise = import("./route");

beforeEach(() => {
  mockState.rangeResult = { start: "2024-01-01", end: "2024-01-07" };
  mockState.scopeFilter = {
    allowedLogins: new Set(["octocat"]),
    enterpriseSlugs: ["ent-a"],
  };
  mockState.prepare.mockImplementation((sql: string) => {
    if (sql.includes("SELECT day,")) {
      return {
        all: vi.fn(() => [
          {
            day: "2024-01-01",
            codeGen: 10,
            codeAccept: 4,
            locSuggested: 60,
            locAccepted: 70,
            locSuggestedDelete: 1,
            locDeleted: 4,
            interactions: 8,
            aiCreditsUsed: 1,
            agentLocAdded: 20,
            agentLocDeleted: 2,
          },
          {
            day: "2024-01-02",
            codeGen: 10,
            codeAccept: 4,
            locSuggested: 60,
            locAccepted: 80,
            locSuggestedDelete: 2,
            locDeleted: 6,
            interactions: 6,
            aiCreditsUsed: 0.5,
            agentLocAdded: 20,
            agentLocDeleted: 3,
          },
        ]),
      };
    }
    if (sql.includes("COUNT(DISTINCT day) AS totalActiveDays")) {
      return {
        get: vi.fn(() => ({
          totalActiveDays: 2,
          totalLocSuggested: 120,
          totalLocAccepted: 150,
          totalLocSuggestedDelete: 3,
          totalLocDeleted: 10,
          totalInteractions: 14,
          totalAiCreditsUsed: 1.5,
          totalCodeGen: 20,
          totalCodeAccept: 8,
          usedAgent: 1,
          usedChat: 1,
          usedCli: 1,
          usedCodeReview: 0,
          usedCodingAgent: 1,
          usedCodeReviewPassive: 0,
        })),
      };
    }
    if (sql.includes("SUM(CASE WHEN json_valid(agent_edit)")) {
      return {
        get: vi.fn(() => ({
          agentLocAdded: 40,
          agentLocDeleted: 5,
        })),
      };
    }
    if (sql.includes("compLocSuggested")) {
      return {
        get: vi.fn(() => ({
          compLocSuggested: 120,
          compLocAccepted: 110,
          compLocDeleted: 5,
          compCodeGen: 18,
          compCodeAccept: 9,
        })),
      };
    }
    if (sql.includes("GROUP BY language")) {
      return {
        all: vi.fn(() => [
          { language: "TypeScript", suggestions: 12, acceptances: 6 },
          { language: "Python", suggestions: 4, acceptances: 2 },
        ]),
      };
    }
    if (sql.includes("GROUP BY model")) {
      return {
        all: vi.fn(() => [
          { model: "gpt-5.4", interactions: 9 },
          { model: "claude-sonnet-4.6", interactions: 5 },
        ]),
      };
    }
    if (sql.includes("GROUP BY ide")) {
      return {
        all: vi.fn(() => [
          { ide: "vscode", interactions: 10 },
          { ide: "neovim", interactions: 4 },
        ]),
      };
    }
    if (sql.includes("json_extract(j.value, '$.feature') AS feature")) {
      return {
        all: vi.fn(() => [
          { feature: "code_completion", interactions: 8, codeGen: 16, codeAccept: 8, locAdded: 110 },
          { feature: "agent_edit", interactions: 2, codeGen: 0, codeAccept: 0, locAdded: 40 },
        ]),
      };
    }
    if (sql.includes("SUM(chat_panel_agent_mode)")) {
      return {
        get: vi.fn(() => ({
          agent: 3,
          ask: 4,
          edit: 2,
          plan: 1,
          custom: 0,
          unknown: 0,
        })),
      };
    }
    if (sql.includes("SUM(json_extract(totals_by_cli")) {
      return {
        get: vi.fn(() => ({
          sessions: 2,
          requests: 5,
          prompts: 7,
          promptTokens: 100,
          outputTokens: 200,
        })),
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("user detail route", { timeout: 10000 }, () => {
  it("returns user-level activity, completion metrics, and breakdowns", async () => {
    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/users/octocat?days=7"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: "octocat",
      dailyActivity: [
        {
          day: "2024-01-01",
          codeGen: 10,
          codeAccept: 4,
          locSuggested: 60,
          locAccepted: 70,
          locSuggestedDelete: 1,
          locDeleted: 4,
          interactions: 8,
          aiCreditsUsed: 1,
          agentLocAdded: 20,
          agentLocDeleted: 2,
        },
        {
          day: "2024-01-02",
          codeGen: 10,
          codeAccept: 4,
          locSuggested: 60,
          locAccepted: 80,
          locSuggestedDelete: 2,
          locDeleted: 6,
          interactions: 6,
          aiCreditsUsed: 0.5,
          agentLocAdded: 20,
          agentLocDeleted: 3,
        },
      ],
      summary: {
        totalActiveDays: 2,
        totalLocAdded: 120,
        totalLocAccepted: 150,
        totalLocSuggestedDelete: 3,
        totalLocDeleted: 10,
        totalInteractions: 14,
        totalAiCreditsUsed: 1.5,
        totalCodeGen: 20,
        totalCodeAccept: 8,
        acceptanceRate: 40,
        agentLocAdded: 40,
        agentLocDeleted: 5,
        totalLocSuggested: 120,
        completionLocAccepted: 110,
        completionLocDeleted: 5,
        completionAcceptanceRate: 50,
        usedAgent: true,
        usedChat: true,
        usedCli: true,
        usedCodeReview: false,
        usedCodingAgent: true,
        usedCodeReviewPassive: false,
      },
      topLanguages: [
        { language: "TypeScript", suggestions: 12, acceptances: 6 },
        { language: "Python", suggestions: 4, acceptances: 2 },
      ],
      topModels: [
        { model: "gpt-5.4", interactions: 9 },
        { model: "claude-sonnet-4.6", interactions: 5 },
      ],
      ideUsage: [
        { ide: "vscode", interactions: 10 },
        { ide: "neovim", interactions: 4 },
      ],
      featureUsage: [
        { feature: "code_completion", interactions: 8, codeGen: 16, codeAccept: 8, locAdded: 110 },
        { feature: "agent_edit", interactions: 2, codeGen: 0, codeAccept: 0, locAdded: 40 },
      ],
      chatModes: {
        agent: 3,
        ask: 4,
        edit: 2,
        plan: 1,
        custom: 0,
        unknown: 0,
      },
      cliStats: {
        sessions: 2,
        requests: 5,
        prompts: 7,
        promptTokens: 100,
        outputTokens: 200,
      },
    });
  });

  it("returns 404 when the login is outside the selected scope", async () => {
    mockState.scopeFilter = {
      allowedLogins: new Set(["hubot"]),
      enterpriseSlugs: ["ent-a"],
    };

    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/users/octocat?days=7"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "User not found in selected scope",
    });
  });
});
