import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout } from "./timeout";
import { NextRequest, NextResponse } from "next/server";

// Minimal mock of NextRequest
function makeRequest(url = "http://localhost/api/test"): NextRequest {
  return new NextRequest(new Request(url));
}

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns handler result when it resolves before timeout", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withTimeout(handler, 5000);

    const resultPromise = wrapped(makeRequest());
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 503 when handler exceeds timeout", async () => {
    const handler = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(NextResponse.json({ ok: true })), 10000)),
    );
    const wrapped = withTimeout(handler, 1000);

    const resultPromise = wrapped(makeRequest());
    await vi.advanceTimersByTimeAsync(1001);
    const result = await resultPromise;

    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.error).toContain("timed out");
  });

  it("includes Retry-After header on timeout", async () => {
    const handler = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(NextResponse.json({})), 5000)),
    );
    const wrapped = withTimeout(handler, 100);

    const resultPromise = wrapped(makeRequest());
    await vi.advanceTimersByTimeAsync(101);
    const result = await resultPromise;

    expect(result.headers.get("Retry-After")).toBe("5");
  });

  it("uses default 30s timeout when none specified", async () => {
    const handler = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(NextResponse.json({})), 31000)),
    );
    const wrapped = withTimeout(handler);

    const resultPromise = wrapped(makeRequest());
    await vi.advanceTimersByTimeAsync(30001);
    const result = await resultPromise;

    expect(result.status).toBe(503);
  });

  it("re-throws non-timeout errors", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("DB connection failed"));
    const wrapped = withTimeout(handler, 5000);

    await expect(wrapped(makeRequest())).rejects.toThrow("DB connection failed");
  });
});
