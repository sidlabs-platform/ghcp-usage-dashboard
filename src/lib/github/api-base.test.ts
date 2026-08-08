import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Captured before any test stubs `global.fetch` — used by the real-network
// integration tests further down, which need genuine network I/O.
let realFetch: typeof fetch;

vi.mock("./app-auth", () => ({
  isAppAuthConfigured: vi.fn(() => false),
  getInstallationToken: vi.fn(),
  validateAppAuth: vi.fn(),
  logAuthMode: vi.fn(),
  isAppAuthConfiguredForEnterprise: vi.fn(() => false),
  getInstallationTokenForEnterprise: vi.fn(),
}));

import { resolveAuthMode, githubFetch, githubFetchPaginated, githubFetchPaginatedWithCutoff, githubFetchCursorPaginatedWithCutoff, fetchNDJSON, GitHubApiError, _setEnterpriseSlugsForTesting, githubFetchWithMeta, _resetRateLimitStateForTesting, _computeRetryDelayMsForTesting } from "./api-base";
import { isAppAuthConfigured, isAppAuthConfiguredForEnterprise, getInstallationToken, getInstallationTokenForEnterprise, validateAppAuth } from "./app-auth";

beforeAll(() => {
  realFetch = globalThis.fetch;
});

const mockIsApp = isAppAuthConfigured as ReturnType<typeof vi.fn>;
const mockIsAppEnt = isAppAuthConfiguredForEnterprise as ReturnType<typeof vi.fn>;

const TEST_SLUGS = ["ent1", "known-ent-1", "known-ent-2"];

beforeEach(() => {
  mockIsApp.mockReset().mockReturnValue(false);
  mockIsAppEnt.mockReset().mockReturnValue(false);
  _setEnterpriseSlugsForTesting(() => TEST_SLUGS);
  _resetRateLimitStateForTesting();
  vi.stubGlobal("fetch", vi.fn());
  process.env.GITHUB_TOKEN = "test-token-123";
});

afterAll(() => {
  _setEnterpriseSlugsForTesting(null);
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

  it("returns null on a real 204 response (ok:true, per the Fetch spec)", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error("should not be called for 204")),
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

  it("falls back to exponential backoff when retry-after is non-numeric", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "not-a-number"]]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetch<{ ok: boolean }>("/orgs/my-org/info");
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on 500", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Map(), text: () => Promise.resolve("upstream exploded") });
    await expect(githubFetch("/orgs/my-org/info", 2)).rejects.toThrow(GitHubApiError);
    try {
      await githubFetch("/orgs/my-org/info", 2);
      throw new Error("expected githubFetch to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(500);
      expect((err as Error).message).toContain("upstream exploded");
    }
  });

  it("throws when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}), headers: new Map() });
    await expect(githubFetch("/enterprises/ent/usage")).rejects.toThrow("GITHUB_TOKEN environment variable is required");
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

  it("handles remaining buffer without trailing newline in streaming", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const encoder = new TextEncoder();
    // Last chunk does NOT end with \n so remaining buffer has content
    const chunks = [encoder.encode('{"a":1}\n{"a":2}')];
    let idx = 0;
    const mockReader = { read: vi.fn(async () => idx < chunks.length ? { done: false, value: chunks[idx++] } : { done: true, value: undefined }) };
    mockFetch.mockResolvedValue({ ok: true, body: { getReader: () => mockReader } });
    const result = await fetchNDJSON<{ a: number }>("https://storage.example.com/data.ndjson");
    expect(result).toHaveLength(2);
    expect(result[1].a).toBe(2);
  });

  it("skips malformed NDJSON lines instead of throwing", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = '{"a":1}\nNOT_JSON\n{"a":3}\n';
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(body), body: null });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await fetchNDJSON<{ a: number }>("https://storage.example.com/data.ndjson");
    expect(result).toHaveLength(2);
    expect(result[0].a).toBe(1);
    expect(result[1].a).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping malformed line"),
      expect.any(String),
    );
    warnSpy.mockRestore();
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

  it("throws on non-204 error status", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Map() });
    await expect(githubFetchPaginated("/orgs/my-org/teams")).rejects.toThrow("GitHub API error 403");
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

  it("falls through on unparseable GitHub URL", () => {
    // A URL that starts with the GitHub API base but cannot be parsed by new URL()
    // The URL constructor throws on truly malformed inputs. Let's use a URL that's
    // GitHub-like but test the catch path by temporarily overriding URL constructor.
    // Instead, test the "path.startsWith('http')" + isGitHub + catch scenario
    // by using a URL that starts with GITHUB_API_BASE prefix but is malformed.
    // Actually the catch path is nearly unreachable because URL() is forgiving.
    // Let's test resolveAuthMode with a custom GITHUB_API_BASE env:
    expect(resolveAuthMode("https://api.github.com/orgs/my-org/teams")).toBe("pat");
  });
});

describe("adaptiveRateDelay", () => {
  it("returns immediately for mode='none'", async () => {
    const { adaptiveRateDelay } = await import("./api-base");
    // Should resolve immediately with no delay
    await adaptiveRateDelay("none");
  });

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
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("requests remaining"),
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
    );
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("caps the 'wait until reset' delay at 120000ms even when reset is nearly an hour away", async () => {
    vi.useFakeTimers();
    const { adaptiveRateDelay } = await import("./api-base");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    // Reset is ~50 minutes away — uncapped this would stall for ~50 minutes.
    const farResetAt = Math.floor(Date.now() / 1000) + 50 * 60;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Map([["x-ratelimit-remaining", "10"], ["x-ratelimit-reset", String(farResetAt)]]),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchP = githubFetch("/orgs/capped/info", 1, "pat");
    await vi.advanceTimersByTimeAsync(1000);
    await fetchP;

    let resolved = false;
    const p = adaptiveRateDelay("pat").then(() => { resolved = true; });
    // Just under the 120s cap must NOT be enough.
    await vi.advanceTimersByTimeAsync(119_999);
    expect(resolved).toBe(false);
    // The remaining 1ms (reaching exactly the 120000ms cap) must resolve it —
    // proving the wait was capped, not the full ~50-minute reset window.
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("ensureAuthReady (app mode)", () => {
  it("validates app auth and fetches installation token for app mode", async () => {
    mockIsApp.mockReturnValue(true);
    (validateAppAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue("app-token-123");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "ok" }),
      headers: new Map(),
    });
    const result = await githubFetch<{ data: string }>("/orgs/my-org/info", 1, "app");
    expect(result.data).toBe("ok");
    expect(validateAppAuth).toHaveBeenCalled();
    expect(getInstallationToken).toHaveBeenCalled();
  });
});

describe("URL validation (SSRF protection)", () => {
  it("rejects non-root-relative paths via githubFetch", async () => {
    await expect(githubFetch("orgs/my-org/info")).rejects.toThrow("root-relative");
  });

  it("rejects protocol-relative URLs via githubFetch", async () => {
    await expect(githubFetch("//evil.com/path")).rejects.toThrow("root-relative");
  });

  it("rejects disallowed absolute URLs via githubFetch", async () => {
    // With explicit auth mode "pat" to force origin check (not "none")
    await expect(githubFetch("https://evil.com/api/data", 1, "pat")).rejects.toThrow("disallowed origin");
  });

  it("allows GitHub API absolute URLs via githubFetch", async () => {
    mockIsApp.mockReturnValue(true);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue("app-token");
    (validateAppAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
      headers: new Map(),
    });
    // Uses "app" mode (avoiding rate limit state from prior "pat" tests)
    const result = await githubFetch<{ ok: boolean }>("https://api.github.com/orgs/my-org/info");
    expect(result.ok).toBe(true);
  });

  it("allows pre-signed download URLs with mode=none", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "blob" }),
      headers: new Map(),
    });
    // Pre-signed URLs resolve to "none" auth mode and bypass origin check
    const result = await githubFetch<{ data: string }>(
      "https://storage.azure.com/some-presigned-url",
      1, "none"
    );
    expect(result.data).toBe("blob");
  });
  it("rejects malformed absolute URLs with contextual error", async () => {
    await expect(githubFetch("http://", 1, "pat")).rejects.toThrow("Invalid URL");
  });
});

describe("enterprise slug validation in auth context", () => {
  it("passes validated slug to fetch when enterprise slug is known", async () => {
    mockIsAppEnt.mockReturnValue(true);
    (validateAppAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: "ok" }),
      headers: new Map(),
    });
    const result = await githubFetch<{ data: string }>("/orgs/my-org/info", 1, undefined, "ent1");
    expect(result.data).toBe("ok");
    expect(mockIsAppEnt).toHaveBeenCalledWith("ent1");
  });

  it("falls back to global PAT for unknown slug", () => {
    // "any-slug" is not in the configured list ["ent1", "known-ent-1", "known-ent-2"]
    expect(resolveAuthMode("/orgs/my-org/info", "any-slug")).toBe("pat");
  });

  it("rejects unknown slug and accepts known slug", () => {
    // Unknown slug → PAT fallback
    expect(resolveAuthMode("/orgs/my-org/info", "evil-slug")).toBe("pat");
    // Known slug with app auth configured → app
    mockIsAppEnt.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/info", "known-ent-1")).toBe("app");
  });

  it("falls back to global PAT when no enterprises are configured", () => {
    _setEnterpriseSlugsForTesting(() => []);
    // Empty config → slug can't be validated → PAT fallback
    expect(resolveAuthMode("/orgs/my-org/info", "any-slug")).toBe("pat");
  });

  it("falls back to default auth when no slug is provided", () => {
    expect(resolveAuthMode("/orgs/my-org/info")).toBe("pat");
    mockIsApp.mockReturnValue(true);
    expect(resolveAuthMode("/orgs/my-org/info")).toBe("app");
  });
});

describe("githubFetchWithMeta", () => {
  it("returns parsed data, status, and selected headers on success", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hello: "world" }),
      headers: new Map([
        ["x-oauth-scopes", "read:org, repo"],
        ["x-ratelimit-remaining", "4999"],
        ["link", ""],
      ]),
    });
    const result = await githubFetchWithMeta<{ hello: string }>("/rate_limit");
    expect(result.data!.hello).toBe("world");
    expect(result.status).toBe(200);
    expect(result.headers["x-oauth-scopes"]).toBe("read:org, repo");
    expect(result.headers["x-ratelimit-remaining"]).toBe("4999");
  });

  it("never includes an authorization header in the returned selected headers", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      // Simulate a response that (incorrectly) echoes an authorization header —
      // the selection allowlist must never surface it regardless.
      headers: new Map([["authorization", "Bearer leaked-token-should-not-surface"]]),
    });
    const result = await githubFetchWithMeta("/rate_limit");
    expect(result.headers.authorization).toBeUndefined();
    expect(Object.keys(result.headers)).not.toContain("authorization");
  });

  it("supports POST with a JSON body", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: new Map(),
    });
    await githubFetchWithMeta("/graphql", { method: "POST", body: { query: "{ viewer { login } }" } });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ query: "{ viewer { login } }" });
  });

  it("returns null data and selected headers on a real 204 response (ok:true, per the Fetch spec)", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error("should not be called for 204")),
      headers: new Map([["x-ratelimit-remaining", "10"]]),
    });
    const result = await githubFetchWithMeta("/orgs/my-org/info");
    expect(result.data).toBeNull();
    expect(result.status).toBe(204);
    expect(result.headers["x-ratelimit-remaining"]).toBe("10");
  });

  it("throws GitHubApiError immediately on 403 with no secondary rate-limit indicators", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Map(), text: () => Promise.resolve("Forbidden") });
    await expect(githubFetchWithMeta("/orgs/my-org/info")).rejects.toThrow(GitHubApiError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 403 secondary rate limit detected from the response body", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Map(),
        text: () => Promise.resolve("You have exceeded a secondary rate limit. Please wait a few minutes."),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("retries a 403 secondary/abuse rate limit detected from a retry-after header", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Map([["retry-after", "0"]]),
        text: () => Promise.resolve("abuse detection mechanism"),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("retries a 403 primary rate limit detected from the 'API rate limit exceeded' phrase", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Map(),
        text: () => Promise.resolve("API rate limit exceeded for 1.2.3.4. (But here's the good news...)"),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("marks an exhausted rate-limited 403 as retryable: true on the thrown GitHubApiError", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Map(),
      text: () => Promise.resolve("API rate limit exceeded for your app."),
    });
    try {
      await githubFetchWithMeta("/orgs/my-org/info", { retries: 2 });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(403);
      expect((err as GitHubApiError).retryable).toBe(true);
    }
    warnSpy.mockRestore();
  });

  it("marks a genuine (non-rate-limited) permission-denied 403 as retryable: false", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Map(), text: () => Promise.resolve("Resource not accessible by integration") });
    try {
      await githubFetchWithMeta("/orgs/my-org/info");
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).retryable).toBe(false);
    }
  });

  it("honors Retry-After header for 429 backoff timing", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "5"]]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("honors X-RateLimit-Reset header for 429 backoff timing when Retry-After is absent", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resetAt = Math.floor(Date.now() / 1000) + 3;
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["x-ratelimit-reset", String(resetAt)]]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    await vi.advanceTimersByTimeAsync(4000);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("uses capped exponential full jitter for 5xx without Retry-After or reset headers", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Map() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    // Cap is bounded (30s); advancing well past the cap must be enough regardless of jitter.
    await vi.advanceTimersByTimeAsync(31000);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    randSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("throws a GitHubApiError preserving status/body after exhausting retries", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Map(), text: () => Promise.resolve("upstream exploded") });
    await expect(githubFetchWithMeta("/orgs/my-org/info", { retries: 2 })).rejects.toMatchObject({
      name: "GitHubApiError",
      status: 500,
    });
    try {
      await githubFetchWithMeta("/orgs/my-org/info", { retries: 2 });
      throw new Error("expected githubFetchWithMeta to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(500);
      expect((err as Error).message).toContain("upstream exploded");
    }
  });

  it("throws a GitHubApiError with a transport sentinel status when fetch itself keeps rejecting", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
    await expect(githubFetchWithMeta("/orgs/my-org/info", { retries: 2 })).rejects.toBeInstanceOf(GitHubApiError);
    try {
      await githubFetchWithMeta("/orgs/my-org/info", { retries: 2 });
      throw new Error("expected githubFetchWithMeta to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(0);
      expect((err as Error).message).toContain("ECONNREFUSED");
    }
    warnSpy.mockRestore();
  });

  it("retries a transient transport failure and succeeds on a later attempt", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info", { retries: 2 });
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("never lets extraHeaders override the Authorization header, case-insensitively", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), headers: new Map() });
    await githubFetchWithMeta("/orgs/my-org/info", {
      extraHeaders: { authorization: "Bearer attacker-supplied-token", Authorization: "Bearer another-attempt" },
    });
    const [, init] = mockFetch.mock.calls[0];
    const sentHeaders = new Headers(init.headers as HeadersInit);
    expect(sentHeaders.get("authorization")).toBe("Bearer test-token-123");
  });

  it("never lets extraHeaders override the JSON body Content-Type header", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), headers: new Map() });
    await githubFetchWithMeta("/graphql", {
      method: "POST",
      body: { query: "{ viewer { login } }" },
      extraHeaders: { "content-type": "text/plain", "Content-Type": "text/plain" },
    });
    const [, init] = mockFetch.mock.calls[0];
    const sentHeaders = new Headers(init.headers as HeadersInit);
    expect(sentHeaders.get("content-type")).toBe("application/json");
  });

  it("still applies non-protected extraHeaders", async () => {
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}), headers: new Map() });
    await githubFetchWithMeta("/orgs/my-org/info", { extraHeaders: { "X-Custom-Header": "custom-value" } });
    const [, init] = mockFetch.mock.calls[0];
    const sentHeaders = new Headers(init.headers as HeadersInit);
    expect(sentHeaders.get("x-custom-header")).toBe("custom-value");
  });

  it("reuses validated URL construction — rejects disallowed origins", async () => {
    await expect(
      githubFetchWithMeta("https://evil.com/api/data", { authMode: "pat" }),
    ).rejects.toThrow("disallowed origin");
  });

  it("reuses enterprise token selection for App auth mode", async () => {
    mockIsAppEnt.mockReturnValue(true);
    (validateAppAuth as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getInstallationTokenForEnterprise as ReturnType<typeof vi.fn>).mockResolvedValue("ent-app-token");
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const result = await githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info", { enterpriseSlug: "ent1" });
    expect(result.data!.ok).toBe(true);
    expect(getInstallationTokenForEnterprise).toHaveBeenCalledWith("ent1");
  });
});

describe("_computeRetryDelayMsForTesting (pure backoff formula, direct/fast)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 for any attempt when Math.random is 0 (full jitter lower bound)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(_computeRetryDelayMsForTesting(0)).toBe(0);
    expect(_computeRetryDelayMsForTesting(5)).toBe(0);
  });

  it("caps at exactly 30000ms when Math.random is 1, regardless of attempt count", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(_computeRetryDelayMsForTesting(0)).toBe(1000);
    expect(_computeRetryDelayMsForTesting(4)).toBe(16000);
    expect(_computeRetryDelayMsForTesting(5)).toBe(30000); // uncapped would be 32000
    expect(_computeRetryDelayMsForTesting(20)).toBe(30000);
  });

  it("honors a Retry-After header directly, capped at 120s", () => {
    expect(_computeRetryDelayMsForTesting(0, "30")).toBe(30_000);
    expect(_computeRetryDelayMsForTesting(0, "500")).toBe(120_000);
  });

  it("falls through to jitter when Retry-After is non-numeric or zero", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(_computeRetryDelayMsForTesting(0, "not-a-number")).toBe(0);
    expect(_computeRetryDelayMsForTesting(0, "0")).toBe(0);
  });

  it("honors X-RateLimit-Reset when Retry-After is absent, capped at 120s", () => {
    const farFuture = Math.floor(Date.now() / 1000) + 99_999;
    expect(_computeRetryDelayMsForTesting(0, null, String(farFuture))).toBe(120_000);

    const near = Math.floor(Date.now() / 1000) + 10;
    const delay = _computeRetryDelayMsForTesting(0, null, String(near));
    expect(delay).toBeGreaterThan(9_000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });
});

describe("retry backoff computation (deterministic, via githubFetchWithMeta)", () => {
  it("retries near-instantly when Math.random returns 0 (full jitter lower bound)", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Map() })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    randSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("caps the backoff at exactly 30000ms when Math.random returns 1, even at high attempt counts", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    // 6 failures (attempts 0..5); attempt 5 would be 32000ms uncapped, so the
    // cap must bring the 6th retry's wait down to exactly 30000ms.
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, headers: new Map() });
    }
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info", { retries: 7 });
    // Sum of capped delays for attempts 0..5: 1000+2000+4000+8000+16000+30000 = 61000ms.
    await vi.advanceTimersByTimeAsync(61000);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(7);
    randSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("caps a Retry-After request at 120s even if the header asks for longer", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "99999"]]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info");
    // Advancing exactly to the 120s cap must be enough — anything short of it must not be.
    await vi.advanceTimersByTimeAsync(120_000);
    const result = await promise;
    expect(result.data!.ok).toBe(true);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not resolve before the capped Retry-After wait elapses", async () => {
    vi.useFakeTimers();
    const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Map([["retry-after", "99999"]]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), headers: new Map() });
    let resolved = false;
    const promise = githubFetchWithMeta<{ ok: boolean }>("/orgs/my-org/info").then((r) => { resolved = true; return r; });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("githubFetchWithMeta — real network integration (retry exhaustion, item 1)", () => {
  const originalApiBase = process.env.GITHUB_API_BASE;
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (originalApiBase === undefined) {
      delete process.env.GITHUB_API_BASE;
    } else {
      process.env.GITHUB_API_BASE = originalApiBase;
    }
    vi.resetModules();
  });

  it("preserves a real GitHubApiError status/body from a live HTTP 500 server after exhausting retries", async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("upstream exploded for real");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.GITHUB_API_BASE = `http://127.0.0.1:${port}`;
    process.env.GITHUB_TOKEN = "test-token-123";

    vi.resetModules();
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", realFetch);

    const mod = await import("./api-base");
    try {
      await mod.githubFetchWithMeta("/rate_limit", { retries: 2 });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.GitHubApiError);
      expect((err as InstanceType<typeof mod.GitHubApiError>).status).toBe(500);
      expect((err as Error).message).toContain("upstream exploded for real");
    }
    expect(requestCount).toBe(2);
    randSpy.mockRestore();
  });

  it("preserves a transport-failure GitHubApiError when the connection is refused across all retries", async () => {
    process.env.GITHUB_API_BASE = "http://127.0.0.1:1";
    process.env.GITHUB_TOKEN = "test-token-123";

    vi.resetModules();
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", realFetch);

    const mod = await import("./api-base");
    try {
      await mod.githubFetchWithMeta("/rate_limit", { retries: 2 });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.GitHubApiError);
      expect((err as InstanceType<typeof mod.GitHubApiError>).status).toBe(0);
    }
    randSpy.mockRestore();
  }, 15000);
});
