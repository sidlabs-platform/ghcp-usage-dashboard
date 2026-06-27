import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getIp, checkRateLimit, withRateLimit } from "./rate-limiter";

describe("rate-limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe("getIp", () => {
    it("gets IP from x-forwarded-for header", () => {
      const req = new NextRequest("http://localhost", {
        headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      });
      expect(getIp(req)).toBe("1.2.3.4");
    });

    it("gets IP from x-real-ip header", () => {
      const req = new NextRequest("http://localhost", {
        headers: { "x-real-ip": "1.2.3.4" },
      });
      expect(getIp(req)).toBe("1.2.3.4");
    });

    it("falls back to unknown-ip if headers are missing", () => {
      const req = new NextRequest("http://localhost");
      expect(getIp(req)).toBe("unknown-ip");
    });
  });

  describe("checkRateLimit", () => {
    it("allows requests below limit", () => {
      // Need a fresh IP to avoid interference with global store
      const ip = "fresh-ip-1";
      const result1 = checkRateLimit(ip, 2);
      expect(result1.success).toBe(true);
      expect(result1.remaining).toBe(1);

      const result2 = checkRateLimit(ip, 2);
      expect(result2.success).toBe(true);
      expect(result2.remaining).toBe(0);
    });

    it("blocks requests above limit", () => {
      const ip = "fresh-ip-2";
      checkRateLimit(ip, 1); // 1
      const result = checkRateLimit(ip, 1); // 2
      
      expect(result.success).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("resets limit after window expires", () => {
      const ip = "fresh-ip-3";
      checkRateLimit(ip, 1);
      
      let result = checkRateLimit(ip, 1);
      expect(result.success).toBe(false);

      // Advance time by 61 seconds (past WINDOW_MS)
      vi.advanceTimersByTime(61 * 1000);

      result = checkRateLimit(ip, 1);
      expect(result.success).toBe(true);
    });
  });
});
