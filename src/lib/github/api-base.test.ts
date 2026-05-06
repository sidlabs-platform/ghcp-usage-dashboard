import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./app-auth", () => ({
  isAppAuthConfigured: vi.fn(() => false),
  getInstallationToken: vi.fn(),
  validateAppAuth: vi.fn(),
  logAuthMode: vi.fn(),
  isAppAuthConfiguredForEnterprise: vi.fn(() => false),
  getInstallationTokenForEnterprise: vi.fn(),
}));

import { resolveAuthMode, githubFetch, githubFetchPaginated, githubFetchPaginatedWithCutoff, githubFetchCursorPaginatedWithCutoff, fetchNDJSON, GitHubApiError } from "./api-base";
import { isAppAuthConfigured, isAppAuthConfiguredForEnterprise } from "./app-auth";

const mockIsApp = isAppAuthConfigured as ReturnType<typeof vi.fn>;
const mockIsAppEnt = isAppAuthConfiguredForEnterprise as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockIsApp.mockReset().mockReturnValue(false);
  mockIsAppEnt.mockReset().mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn());
  process.env.GITHUB_TOKEN = "test-token-123";
});

describe("resolveAuthMode", () => {
  it("returns 'none' for non-GitHub absolute URLs", () => {
    expect(resolveAuthMode("https://storage.azure.com/some-presigned-url")).toBe("none");
    expect(resolveAuthMode("https://s3.amazonaws.com/bucket/key")).toBe("none");
  });

  it("returns 'pat' for enterprise endpoints", () => {
    expect(resolveAuthMode("/enterprises/my-ent/copilot/usage")).toBe("pat");
    expect(resolveAuthMode("/enterprises/acme/copilot/metrics")).toBe("pat");
  });

  it("returns 'pat' for org endpoints when no App auth is configured", () => {
    expect(resolveAuthMode("/orgs/my-org/copilot/usage")).toBe("pat");
  });

  it("returns 'app' for org endpoints when App auth is configured", () => {
    mockIsApp.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/copilot/usage")).toBe("app");
  });

  it("returns 'app' when enterprise slug has app configured", () => {
    mockIsAppEnt.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/metrics", "ent1")).toBe("app");
  });

  it("returns 'pat' when enterprise slug has no app configured", () => {
    mockIsAppEnt.mockReturnValue(false);
    expect(resolveAuthMode("/orgs/my-org/metrics", "ent1")).toBe("pat");
  });

  it("returns 'pat' for absolute GitHub API enterprise URLs", () => {
    expect(resolveAuthMode("https://api.github.com/enterprises/my-ent/copilot/usage")).toBe("pat");
  });

  it("returns 'none' for non-GitHub absolute URLs regardless of path content", () => {
    expect(resolveAuthMode("https://example.com/enterprises/foo")).toBe("none");
  });
});

describe("githubFetch", () => {
  it("returns JSON on successful response", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "hello" }),
      headers: new Map(),
    });
    const result = await githubFetch<{ data: string }>("/orgs/my-org/info");
    expect(result.data).toBe("hello");
  });

  it("returns null on 204", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 204,
      headers: new Map(),
    });
    const result = await githubFetch("/orgs/my-org/info");
    expect(result).toBeNull();
  });

  it("throws GitHubApiError on 4xx", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Map(),
      text: () => Promise.resolve("forbidden"),
    });
    await expect(githubFetch("/orgs/my-org/info")).rejects.toThrow(GitHubApiError);
  });

  it("retries on 429 then succeeds", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "0"]]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetch<{ ok: boolean }>("/orgs/my-org/info");
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on 500", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Map() });
    await expect(githubFetch("/orgs/my-org/info", 2)).rejects.toThrow("GitHub API failed after 2 retries");
  });
});

describe("fetchNDJSON", () => {
  it("parses newline-delimited JSON from text fallback", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      body: null,
      text: () => Promise.resolve('{"a":1}\n{"a":2}\n'),
    });
    const result = await fetchNDJSON<{ a: number }>("https://storage.example.com/data.ndjson");
    expect(result).toHaveLength(2);
    expect(result[0].a).toBe(1);
  });

  it("throws on non-ok response", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchNDJSON("https://storage.example.com/missing")).rejects.toThrow("Failed to download NDJSON");
  });

  it("parses streaming body when resp.body is present", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":1}\n{"a":2}\n'), encoder.encode('{"a":3}\n')];
    let idx = 0;
    const mockReader = { read: vi.fn(async () => idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true, value: undefined }) };
    mockFetch.mockResolvedValue({ ok: true, body: { getReader: () => mockReader } });
    const result = await fetchNDJSON<{ a: number }>("https://storage.example.com/data.ndjson");
    expect(result).toHaveLength(3);
    expect(result[2].a).toBe(3);
  });
});

describe("githubFetchPaginated", () => {
  it("fetches single page of results", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
      headers: new Map(),
    });
    const result = await githubFetchPaginated<{ id: number }>("/orgs/my-org/teams", 100);
    expect(result).toHaveLength(2);
  });

  it("paginates across multiple pages", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const page2 = [{ id: 100 }, { id: 101 }];
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1), headers: new Map() })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page2), headers: new Map() });
    const result = await githubFetchPaginated<{ id: number }>("/orgs/my-org/teams", 100);
    expect(result).toHaveLength(102);
  });

  it("stops on empty array", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
      headers: new Map(),
    });
    const result = await githubFetchPaginated("/orgs/my-org/teams");
    expect(result).toEqual([]);
  });

  it("extracts .seats from non-array response", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ seats: [{ login: "u1" }, { login: "u2" }] }),
      headers: new Map(),
    });
    const result = await githubFetchPaginated<{ login: string }>("/orgs/my-org/copilot/billing/seats");
    expect(result).toHaveLength(2);
    expect(result[0].login).toBe("u1");
  });

  it("returns empty on 204 status", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 204, headers: new Map() });
    const result = await githubFetchPaginated("/orgs/my-org/teams");
    expect(result).toEqual([]);
  });
});

describe("githubFetchPaginatedWithCutoff", () => {
  it("fetches all items when no cutoff", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ updated_at: "2024-01-01", id: 1 }]),
      headers: new Map(),
    });
    const result = await githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/code-scanning/alerts");
    expect(result).toHaveLength(1);
  });

  it("stops at cutoff date", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { updated_at: "2024-01-05", id: 1 },
        { updated_at: "2024-01-01", id: 2 },
      ]),
      headers: new Map(),
    });
    const result = await githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts", "2024-01-03");
    expect(result).toHaveLength(1);
    expect((result[0] as any).id).toBe(1);
  });

  it("returns empty on 204", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 204, headers: new Map() });
    const result = await githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts");
    expect(result).toEqual([]);
  });

  it("retries on 429 then succeeds", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "1"]]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ updated_at: "2024-01-05", id: 1 }]), headers: new Map() });
    const result = await githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts");
    expect(result).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("429"));
    warnSpy.mockRestore();
  });

  it("throws on non-retryable error with body text", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Map(), text: () => Promise.resolve("Forbidden") });
    await expect(githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts")).rejects.toThrow("GitHub API error 403: Forbidden");
  });

  it("fetches multiple pages when first page is full", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const page1 = Array.from({ length: 100 }, (_, i) => ({ updated_at: "2024-01-05", id: i }));
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page1), headers: new Map() })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ updated_at: "2024-01-05", id: 100 }]), headers: new Map() });
    const result = await githubFetchPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts");
    expect(result).toHaveLength(101);
  });
});

describe("githubFetchCursorPaginatedWithCutoff", () => {
  it("fetches all items with cursor pagination", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ updated_at: "2024-01-05", id: 1 }]),
      headers: new Map([["link", ""]]),
    });
    const result = await githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/dependabot/alerts");
    expect(result).toHaveLength(1);
  });

  it("follows next cursor from Link header", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ updated_at: "2024-01-05", id: 1 }]),
        headers: new Map([["link", '<https://api.github.com/orgs/o/dependabot/alerts?per_page=100&after=cursor123>; rel="next"']]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
        headers: new Map([["link", ""]]),
      });
    const result = await githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/dependabot/alerts");
    expect(result).toHaveLength(1);
  });

  it("stops at cutoff date", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { updated_at: "2024-01-10", id: 1 },
        { updated_at: "2024-01-01", id: 2 },
      ]),
      headers: new Map([["link", ""]]),
    });
    const result = await githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts", "2024-01-05");
    expect(result).toHaveLength(1);
  });

  it("retries on 429 then succeeds", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({
        ok: false, status: 429,
        headers: new Map([["retry-after", "1"]]),
        text: () => Promise.resolve("rate limited"),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ updated_at: "2024-01-05", id: 1 }]),
        headers: new Map([["link", ""]]),
      });
    const result = await githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts");
    expect(result).toHaveLength(1);
  });

  it("throws on 4xx non-retryable error", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: false, status: 404,
      headers: new Map(),
      text: () => Promise.resolve("not found"),
    });
    await expect(githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/alerts")).rejects.toThrow("404");
  });

  it("returns empty on 204", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 204, headers: new Map() });
    const result = await githubFetchCursorPaginatedWithCutoff<{ updated_at: string }>("/orgs/o/dependabot/alerts");
    expect(result).toEqual([]);
  });
});

describe("resolveAuthMode (absolute GitHub URL)", () => {
  it("extracts path from absolute GitHub API URL", () => {
    expect(resolveAuthMode("https://api.github.com/enterprises/ent/copilot")).toBe("pat");
  });

  it("returns app for org path in absolute GitHub URL", () => {
    mockIsApp.mockReturnValue(true);
    expect(resolveAuthMode("https://api.github.com/orgs/my-org/copilot")).toBe("app");
  });
});

describe("adaptiveRateDelay", () => {
  it("delays 200ms when remaining is between 100-1000", async () => {
    vi.useFakeTimers();
    const { adaptiveRateDelay } = await import("./api-base");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map([["x-ratelimit-remaining", "500"], ["x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 60)]]),
    });
    // Prime the rate limit state
    await githubFetch("/orgs/test/copilot", 1, "pat");
    // adaptiveRateDelay should sleep 200ms
    const p = adaptiveRateDelay("pat");
    await vi.advanceTimersByTimeAsync(200);
    await p;
    vi.useRealTimers();
  });

  it("waits until reset when remaining < 100", async () => {
    vi.useFakeTimers();
    const { adaptiveRateDelay } = await import("./api-base");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const resetAt = Math.floor(Date.now() / 1000) + 5; // 5s from now
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map([["x-ratelimit-remaining", "50"], ["x-ratelimit-reset", String(resetAt)]]),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Prime state — need to advance timers since adaptiveRateDelay may sleep
    const fetchP = githubFetch("/orgs/low/info", 1, "pat");
    await vi.advanceTimersByTimeAsync(1000);
    await fetchP;
    // Now adaptiveRateDelay should see remaining=50 and wait until reset
    const p = adaptiveRateDelay("pat");
    await vi.advanceTimersByTimeAsync(7000);
    await p;
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Only 50 requests remaining"));
    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});
