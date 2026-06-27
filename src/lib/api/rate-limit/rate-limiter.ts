// Simple in-memory rate limiter for API routes

import { NextRequest, NextResponse } from "next/server";

interface RateLimitInfo {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitInfo>();

const DEFAULT_LIMIT = parseInt(process.env.API_RATE_LIMIT_RPM || "60", 10) || 60;
const WINDOW_MS = 60 * 1000; // 1 minute

export function getIp(request: NextRequest): string {
  // Try getting IP from standard headers
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  // Fallback if IP cannot be determined
  return "unknown-ip";
}

export function checkRateLimit(ip: string, limit = DEFAULT_LIMIT): { success: boolean; limit: number; remaining: number; resetTime: number } {
  const now = Date.now();
  let info = store.get(ip);

  // If entry doesn't exist or window expired, reset
  if (!info || now >= info.resetTime) {
    info = {
      count: 0,
      resetTime: now + WINDOW_MS,
    };
  }

  info.count++;
  store.set(ip, info);

  const remaining = Math.max(0, limit - info.count);
  const success = info.count <= limit;

  return {
    success,
    limit,
    remaining,
    resetTime: info.resetTime,
  };
}

// Clean up expired entries periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, info] of store.entries()) {
    if (now >= info.resetTime) {
      store.delete(ip);
    }
  }
}, WINDOW_MS).unref();

type RouteHandler = (request: NextRequest) => Promise<NextResponse>;

export function withRateLimit(
  handler: RouteHandler,
  limit: number = DEFAULT_LIMIT
): RouteHandler {
  return async (request: NextRequest): Promise<NextResponse> => {
    const ip = getIp(request);
    const { success, limit: maxLimit, remaining, resetTime } = checkRateLimit(ip, limit);
    
    // Convert reset time to seconds for headers
    const resetTimeSeconds = Math.ceil(resetTime / 1000);
    const retryAfterSeconds = Math.ceil((resetTime - Date.now()) / 1000);

    if (!success) {
      return NextResponse.json(
        { error: "Too Many Requests" },
        { 
          status: 429,
          headers: {
            "X-RateLimit-Limit": maxLimit.toString(),
            "X-RateLimit-Remaining": remaining.toString(),
            "X-RateLimit-Reset": resetTimeSeconds.toString(),
            "Retry-After": retryAfterSeconds.toString(),
          }
        }
      );
    }

    // Call the original handler
    const response = await handler(request);
    
    // Add rate limit headers to successful response
    response.headers.set("X-RateLimit-Limit", maxLimit.toString());
    response.headers.set("X-RateLimit-Remaining", remaining.toString());
    response.headers.set("X-RateLimit-Reset", resetTimeSeconds.toString());
    
    return response;
  };
}
