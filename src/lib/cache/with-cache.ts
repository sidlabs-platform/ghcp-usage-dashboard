// Cache wrapper for Next.js API route handlers

import { NextRequest, NextResponse } from "next/server";
import { cache, CACHE_TTL } from "./memory-cache";

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

/**
 * Wraps a GET API route handler with in-memory caching.
 * Cache key is derived from the route URL + query params.
 * Skips cache when the request has `Cache-Control: no-cache`.
 */
export function withCache(
  handler: RouteHandler,
  ttlMs: number = CACHE_TTL.MEDIUM,
): RouteHandler {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Skip cache if explicitly requested
    const cacheControl = request.headers.get("cache-control");
    if (cacheControl?.includes("no-cache")) {
      return handler(request);
    }

    // Build cache key from URL pathname + sorted search params
    const url = request.nextUrl;
    const sortedParams = new URLSearchParams([...url.searchParams.entries()].sort());
    const cacheKey = `${url.pathname}?${sortedParams.toString()}`;

    // Check cache
    const cached = cache.get<{ body: unknown; status: number; headers: Record<string, string> }>(cacheKey);
    if (cached) {
      return NextResponse.json(cached.body, {
        status: cached.status,
        headers: {
          ...cached.headers,
          "X-Cache": "HIT",
        },
      });
    }

    // Execute handler
    const response = await handler(request);

    // Only cache successful responses
    if (response.status === 200) {
      // Clone before consuming body so fallback can return the original intact
      const cloned = response.clone();
      try {
        const body = await cloned.json();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== "x-cache") {
            headers[key] = value;
          }
        });

        cache.set(cacheKey, { body, status: 200, headers }, ttlMs);

        return NextResponse.json(body, {
          status: 200,
          headers: {
            ...headers,
            "X-Cache": "MISS",
          },
        });
      } catch {
        // If we can't parse JSON, return original response (body still intact)
        return response;
      }
    }

    return response;
  };
}
