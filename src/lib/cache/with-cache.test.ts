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

  it("returns original response when body is not valid JSON", async () => {
    const handler = vi.fn().mockResolvedValue(
      new NextResponse("plain text", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const wrapped = withCache(handler);

    const result = await wrapped(makeRequest());
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toBe("plain text");
  });

  it("strips X-Cache header from handler response when caching", async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true }, { headers: { "X-Cache": "UPSTREAM-HIT", "X-Custom": "keep" } }),
    );
    const wrapped = withCache(handler);

    const miss = await wrapped(makeRequest());
    expect(miss.headers.get("X-Cache")).toBe("MISS");
    expect(miss.headers.get("X-Custom")).toBe("keep");

    const hit = await wrapped(makeRequest());
    expect(hit.headers.get("X-Cache")).toBe("HIT");
    expect(hit.headers.get("X-Custom")).toBe("keep");
  });
});
