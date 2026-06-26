// Request timeout protection for API routes

import { NextRequest, NextResponse } from "next/server";

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Wraps an API route handler with a timeout.
 * Returns 503 Service Unavailable if the handler takes too long.
 */
export function withTimeout(
  handler: RouteHandler,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): RouteHandler {
  return async (request: NextRequest): Promise<NextResponse> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await Promise.race([
        handler(request),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(new Error(`Request timed out after ${timeoutMs}ms`));
          });
        }),
      ]);
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes("timed out")) {
        return NextResponse.json(
          { error: "Request timed out. Try a narrower date range or add filters." },
          {
            status: 503,
            headers: { "Retry-After": "5" },
          },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
