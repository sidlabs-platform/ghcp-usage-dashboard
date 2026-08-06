import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getUserAiCreditsUsersPaginated: vi.fn(),
  getUserAiCreditsTotals: vi.fn(),
}));

const scopeState = vi.hoisted(() => ({
  parseScopeFilter: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (h: unknown) => h }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (h: unknown) => h }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (h: unknown) => h }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/utils", () => ({
  parseDateRangeParams: vi.fn(() => ({ start: "2026-07-01", end: "2026-07-28" })),
}));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (...args: unknown[]) => scopeState.parseScopeFilter(...args),
}));

vi.mock("@/lib/db/metrics-repo", () => ({
  getUserAiCreditsUsersPaginated: (...args: unknown[]) =>
    repoState.getUserAiCreditsUsersPaginated(...args),
  getUserAiCreditsTotals: (...args: unknown[]) => repoState.getUserAiCreditsTotals(...args),
}));

import { GET } from "./route";

beforeEach(() => {
  scopeState.parseScopeFilter.mockReturnValue({
    enterpriseSlugs: ["ent-a"],
    allowedLogins: new Set(["octo", "mona"]),
  });
  repoState.getUserAiCreditsUsersPaginated.mockReturnValue({
    users: [
      {
        user_login: "octo",
        total_ai_credits_used: 42.5,
        active_days: 3,
        avg_daily_ai_credits: 14.1666666667,
        last_active_day: "2026-07-28",
      },
    ],
    total: 1,
  });
  repoState.getUserAiCreditsTotals.mockReturnValue({
    total_ai_credits_used: 42.5,
    tracked_users: 1,
    top_user_login: "octo",
    top_user_ai_credits_used: 42.5,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AI Credits users route", () => {
  it("returns sortable paginated user AI credit consumption", async () => {
    const res = await GET(
      new NextRequest(
        "http://localhost/api/billing/ai-credits/users?days=28&page=2&pageSize=10&sort=avg_daily_ai_credits&sortDir=asc&search=oct&teams=eng&enterprises=ent-a",
      ),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      users: [
        {
          user_login: "octo",
          total_ai_credits_used: 42.5,
          active_days: 3,
          avg_daily_ai_credits: 14.1666666667,
          last_active_day: "2026-07-28",
        },
      ],
      totals: {
        total_ai_credits_used: 42.5,
        tracked_users: 1,
        top_user_login: "octo",
        top_user_ai_credits_used: 42.5,
      },
      pagination: {
        page: 2,
        pageSize: 10,
        totalItems: 1,
        totalPages: 1,
      },
    });

    expect(scopeState.parseScopeFilter).toHaveBeenCalled();
    expect(repoState.getUserAiCreditsUsersPaginated).toHaveBeenCalledWith(
      "2026-07-01",
      "2026-07-28",
      2,
      10,
      "avg_daily_ai_credits",
      "asc",
      "oct",
      { allowedLogins: ["octo", "mona"], search: "oct" },
      ["ent-a"],
    );
    expect(repoState.getUserAiCreditsTotals).toHaveBeenCalledWith(
      "2026-07-01",
      "2026-07-28",
      { allowedLogins: ["octo", "mona"], search: "oct" },
      ["ent-a"],
    );
  });
});
