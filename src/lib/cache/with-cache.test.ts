import { describe, it, expect, vi, beforeEach } from "vitest";
import { withCache } from "./with-cache";
import { cache } from "./memory-cache";
import { NextRequest, NextResponse } from "next/server";

function makeRequest(url = "http://localhost/api/test?days=7"): NextRequest {
  return new NextRequest(new Request(url));
}

function makeNoCacheRequest(url = "http://localhost/api/test"): NextRequest {
  return new NextRequest(new Request(url, { headers: { "Cache-Control": "no-cache" } }));
}

describe("withCache", () => {
  beforeEach(() => {
    cache.invalidateAll();
  });

  it("returns MISS on first request and caches the result", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ count: 42 }));
    const wrapped = withCache(handler);

    const result = await wrapped(makeRequest());
    expect(result.headers.get("X-Cache")).toBe("MISS");
    const body = await result.json();
    expect(body).toEqual({ count: 42 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns HIT on subsequent requests", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ count: 42 }));
    const wrapped = withCache(handler);

    await wrapped(makeRequest());
    const result = await wrapped(makeRequest());

    expect(result.headers.get("X-Cache")).toBe("HIT");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache when Cache-Control: no-cache is set", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ fresh: true }));
    const wrapped = withCache(handler);

    // Prime cache
    await wrapped(makeRequest("http://localhost/api/test"));
    // no-cache request
    const result = await wrapped(makeNoCacheRequest("http://localhost/api/test"));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.headers.get("X-Cache")).toBeNull();
  });

  it("does not cache non-200 responses", async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ error: "bad" }, { status: 400 }),
    );
    const wrapped = withCache(handler);

    await wrapped(makeRequest());
    await wrapped(makeRequest());

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("uses sorted query params for cache key consistency", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withCache(handler);

    await wrapped(makeRequest("http://localhost/api/test?b=2&a=1"));
    const result = await wrapped(makeRequest("http://localhost/api/test?a=1&b=2"));

    expect(result.headers.get("X-Cache")).toBe("HIT");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
