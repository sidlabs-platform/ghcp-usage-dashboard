import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { UserSummary } from "@/lib/db/aggregation-queries";

const mockState = vi.hoisted(() => ({
  rangeResult: { start: "2024-01-01", end: "2024-01-07" } as
    | { start: string; end: string }
    | { error: string },
  scopeFilter: {
    selectedTeams: ["eng"],
    selectedOrgs: ["platform"],
    selectedEnterprises: ["ent-a"],
    hasFilter: true,
    allowedLogins: new Set(["octocat"]),
    enterpriseSlugs: ["ent-a"],
  },
  iterateUserSummaries: vi.fn(),
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

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: vi.fn(() => mockState.scopeFilter),
}));

vi.mock("@/lib/db/aggregation-queries", () => ({
  iterateUserSummaries: (...args: unknown[]) => mockState.iterateUserSummaries(...args),
}));

const routePromise = import("./route");

function* createIterator(rows: UserSummary[]): IterableIterator<UserSummary> {
  for (const row of rows) {
    yield row;
  }
}

beforeEach(() => {
  mockState.rangeResult = { start: "2024-01-01", end: "2024-01-07" };
  mockState.scopeFilter = {
    selectedTeams: ["eng"],
    selectedOrgs: ["platform"],
    selectedEnterprises: ["ent-a"],
    hasFilter: true,
    allowedLogins: new Set(["octocat"]),
    enterpriseSlugs: ["ent-a"],
  };
  mockState.iterateUserSummaries.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("users export route", () => {
  it("returns date validation errors from shared range parsing", async () => {
    mockState.rangeResult = { error: "Invalid date range." };

    const { GET } = await routePromise;
    const response = await GET(new NextRequest("http://localhost/api/export/users?days=0"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid date range." });
    expect(mockState.iterateUserSummaries).not.toHaveBeenCalled();
  });

  it("exports the aggregated users CSV contract for days-based requests", async () => {
    mockState.iterateUserSummaries.mockReturnValue(
      createIterator([
        {
          login: "=octocat",
          activeDays: 7,
          locAdded: 123,
          locDeleted: 0,
          interactions: 5,
          aiCreditsUsed: 1.25,
          codeGen: 10,
          codeAccept: 8,
          acceptanceRate: 80,
          usedAgent: true,
          usedChat: false,
          usedCli: true,
          usedCodeReviewActive: false,
          usedCodeReviewPassive: true,
          usedCodingAgent: false,
        },
      ]),
    );

    const { GET } = await routePromise;
    const response = await GET(
      new NextRequest(
        "http://localhost/api/export/users?days=7&teams=eng&orgs=platform&enterprises=ent-a&includeInactive=true",
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain('filename="copilot-users-export-2024-01-01-to-2024-01-07.csv"');

    const csv = await response.text();
    const lines = csv.split("\n");

    expect(lines[0]).toBe("Report,User Explorer");
    expect(lines[1]).toBe("Date Range,Last 7 days");
    expect(lines[2]).toBe("Teams,eng");
    expect(lines[3]).toBe("Organizations,platform");
    expect(lines[4]).toMatch(/^Exported At,/);
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("User,Active Days,LoC Added,Interactions,AI Credits Used,Acceptance %,Features");
    expect(lines[7]).toBe(`"'=octocat",7,123,5,1.25,80.0%,"Agent, CLI, Code Review (Passive)"`);

    expect(mockState.iterateUserSummaries).toHaveBeenCalledWith(
      "2024-01-01",
      "2024-01-07",
      "login",
      "asc",
      undefined,
      ["octocat"],
      ["ent-a"],
      true,
    );
  });
});
