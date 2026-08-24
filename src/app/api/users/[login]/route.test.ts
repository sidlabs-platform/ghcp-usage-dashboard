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
  copilotAppScalar: { periodActiveUsers: 1, appActiveUsers: 1, supportedRows: 2 },
  copilotAppDedicated: { sessions: 3, requests: 6, prompts: 9, promptTokens: 240, outputTokens: 120 },
  copilotAppFeature: { codeGenerations: 5, codeAcceptances: 4, locAdded: 30, locDeleted: 6 },
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
  mockState.copilotAppScalar = { periodActiveUsers: 1, appActiveUsers: 1, supportedRows: 2 };
  mockState.copilotAppDedicated = { sessions: 3, requests: 6, prompts: 9, promptTokens: 240, outputTokens: 120 };
  mockState.copilotAppFeature = { codeGenerations: 5, codeAcceptances: 4, locAdded: 30, locDeleted: 6 };
  mockState.prepare.mockImplementation((sql: string) => {
    if (sql.includes("ORDER BY day DESC, user_id DESC")) {
      return {
        get: vi.fn(() => ({ userId: 123 })),
      };
    }
    if (sql.includes("as completionAccepted")) {
      return {
        all: vi.fn(() => [
          { day: "2024-01-01", completionSuggested: 55, completionAccepted: 65, completionDeleted: 3, completionSuggestedDelete: 2, agentAdded: 20, agentDeleted: 2, compGenCount: 9, compAcceptCount: 3, appAdded: 3, appDeleted: 1, appGenCount: 1, appAcceptCount: 1 },
          { day: "2024-01-02", completionSuggested: 58, completionAccepted: 75, completionDeleted: 4, completionSuggestedDelete: 3, agentAdded: 20, agentDeleted: 3, compGenCount: 9, compAcceptCount: 3, appAdded: 2, appDeleted: 0, appGenCount: 0, appAcceptCount: 0 },
        ]),
      };
    }
    if (sql.includes("FROM per_user_day") && sql.includes("ORDER BY day ASC")) {
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
          agentLocAdded: 40,
          agentLocDeleted: 5,
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
          compLocSuggestedDelete: 2,
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
    // Copilot App — getCopilotAppUserSummary issues three independent
    // queries (scalar counts, dedicated totals_by_copilot_app sums, and
    // copilot_app feature-code sums). Match each by a substring unique to
    // that query's SELECT list.
    if (sql.includes("as periodActiveUsers")) {
      return {
        get: vi.fn(() => mockState.copilotAppScalar),
      };
    }
    if (sql.includes("as promptTokens")) {
      return {
        get: vi.fn(() => mockState.copilotAppDedicated),
      };
    }
    if (sql.includes("as codeGenerations")) {
      return {
        get: vi.fn(() => mockState.copilotAppFeature),
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("user detail route", { timeout: 10000 }, () => {
  it("authorizes scoped login casing variants", async () => {
    mockState.scopeFilter = {
      allowedLogins: new Set(["OctoCat"]),
      enterpriseSlugs: ["ent-a"],
    };

    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/users/octocat?days=7"));

    expect(response.status).toBe(200);
    const sql = mockState.prepare.mock.calls.map(([statement]) => String(statement));
    expect(sql.some((statement) => /\buser_login\s*=\s*\?/i.test(statement))).toBe(false);
  });

  it("returns user-level activity, completion metrics, and breakdowns", async () => {
    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/users/octocat?days=7"));

    expect(response.status).toBe(200);
    const body = await response.json();
    // completionLocSuggested (55/58, from getCompletionDailyTrend's strict
    // IS_COMPLETION_SQL allowlist) must be strictly less than the top-level
    // locSuggested (60/60, loc_suggested_to_add_sum across ALL features) in
    // this fixture — proving copilot_app/chat_inline/unknown suggested LoC
    // that inflates the top-level field never leaks into completionLocSuggested.
    expect(body.dailyActivity[0].completionLocSuggested).toBeLessThan(body.dailyActivity[0].locSuggested);
    expect(body.dailyActivity[1].completionLocSuggested).toBeLessThan(body.dailyActivity[1].locSuggested);
    expect(body).toEqual({
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
          completionLocSuggested: 55,
          completionLocAccepted: 65,
          completionLocDeleted: 3,
          completionLocSuggestedDelete: 2,
          appLocAdded: 3,
          appLocDeleted: 1,
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
          completionLocSuggested: 58,
          completionLocAccepted: 75,
          completionLocDeleted: 4,
          completionLocSuggestedDelete: 3,
          appLocAdded: 2,
          appLocDeleted: 0,
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
        // Now identical to `completionAcceptanceRate` by design: both are the
        // accept/generate ratio over acceptance-eligible features. The old
        // top-level figure divided the same acceptances by an agent-inclusive
        // generation count, which could only ever understate the rate.
        acceptanceRate: 50,
        agentLocAdded: 40,
        agentLocDeleted: 5,
        cliLocAdded: 0,
        cliLocDeleted: 0,
        totalLocSuggested: 120,
        completionLocAccepted: 110,
        completionLocDeleted: 5,
        completionLocSuggestedDelete: 2,
        completionAcceptanceRate: 50,
        usedAgent: true,
        usedChat: true,
        usedCli: true,
        usedCodeReview: false,
        usedCodingAgent: true,
        usedCodeReviewPassive: false,
        usedCopilotApp: true,
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
      copilotAppStats: {
        sessions: 3,
        requests: 6,
        prompts: 9,
        promptTokens: 240,
        outputTokens: 120,
        avgTokensPerRequest: 60, // (240 + 120) / 6
        codeGenerations: 5,
        codeAcceptances: 4,
        locAdded: 30,
        locDeleted: 6,
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
