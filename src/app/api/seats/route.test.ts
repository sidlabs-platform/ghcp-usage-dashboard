import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const repoState = vi.hoisted(() => ({
  getSeatStats: vi.fn(),
  getSeatsPaginated: vi.fn(),
}));

const scopeState = vi.hoisted(() => ({
  parseScopeFilter: vi.fn(),
}));

vi.mock("@/lib/cache/with-cache", () => ({ withCache: (handler: unknown) => handler }));
vi.mock("@/lib/api/timeout", () => ({ withTimeout: (handler: unknown) => handler }));
vi.mock("@/lib/api/rate-limit/rate-limiter", () => ({ withRateLimit: (handler: unknown) => handler }));
vi.mock("@/lib/cache/memory-cache", () => ({ CACHE_TTL: { MEDIUM: 300 } }));

vi.mock("@/lib/api/scope-filter", () => ({
  parseScopeFilter: (...args: unknown[]) => scopeState.parseScopeFilter(...args),
}));

vi.mock("@/lib/db/seats-repo", () => ({
  getSeatStats: (...args: unknown[]) => repoState.getSeatStats(...args),
  getSeatsPaginated: (...args: unknown[]) => repoState.getSeatsPaginated(...args),
}));

import { GET } from "./route";

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/seats${query}`);
}

beforeEach(() => {
  scopeState.parseScopeFilter.mockReturnValue({
    selectedTeams: [],
    selectedOrgs: [],
    enterpriseSlugs: ["acme"],
    allowedLogins: undefined,
  });
  repoState.getSeatStats.mockReturnValue({
    total: 0,
    active30d: 0,
    inactive30d: 0,
    pendingCancellation: 0,
    activitySince: "2024-06-01T00:00:00.000Z",
    activityUntil: null,
  });
  repoState.getSeatsPaginated.mockReturnValue({ seats: [], total: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/seats", () => {
  it.each([
    ["page=1abc", "?page=1abc", /page/i],
    ["page=abc", "?page=abc", /page/i],
    ["pageSize=abc", "?pageSize=abc", /pageSize/i],
    ["page= (empty)", "?page=", /page/i],
  ])("rejects malformed pagination parameter %s with a descriptive 400", async (_name, query, pattern) => {
    const response = await GET(req(query));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(pattern);
    expect(repoState.getSeatStats).not.toHaveBeenCalled();
    expect(repoState.getSeatsPaginated).not.toHaveBeenCalled();
  });

  // Out-of-range but well-formed integers stay clamped, matching the sibling
  // paginated routes. Only unparseable values are a caller error.
  it.each([
    ["page=0", "?page=0", 1, 50],
    ["page=-2", "?page=-2", 1, 50],
    ["pageSize=999", "?pageSize=999", 1, 200],
    ["pageSize=0", "?pageSize=0", 1, 1],
  ])("clamps out-of-range pagination parameter %s", async (_name, query, page, pageSize) => {
    const response = await GET(req(query));

    expect(response.status).toBe(200);
    expect(repoState.getSeatsPaginated).toHaveBeenCalledWith(
      page,
      pageSize,
      "_lastActivity",
      "desc",
      undefined,
      ["acme"],
    );
  });

  it("keeps default pagination when page and pageSize are absent", async () => {
    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pagination).toEqual({ page: 1, pageSize: 50, totalItems: 0, totalPages: 0 });
    expect(repoState.getSeatsPaginated).toHaveBeenCalledWith(
      1,
      50,
      "_lastActivity",
      "desc",
      undefined,
      ["acme"],
    );
  });
});
