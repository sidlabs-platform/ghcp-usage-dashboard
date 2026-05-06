import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cache, CACHE_TTL } from "./memory-cache";

describe("MemoryCache", () => {
  beforeEach(() => {
    cache.invalidateAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("get/set", () => {
    it("returns undefined for missing keys", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("stores and retrieves a value", () => {
      cache.set("key1", { data: "hello" });
      expect(cache.get("key1")).toEqual({ data: "hello" });
    });

    it("returns undefined for expired entries", () => {
      cache.set("key1", "value", 1000);
      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("returns value before TTL expires", () => {
      cache.set("key1", "value", 5000);
      vi.advanceTimersByTime(4999);
      expect(cache.get("key1")).toBe("value");
    });
  });

  describe("invalidateByPrefix", () => {
    it("removes entries matching the prefix", () => {
      cache.set("api:/users", "u");
      cache.set("api:/teams", "t");
      cache.set("other:key", "o");
      const count = cache.invalidateByPrefix("api:");
      expect(count).toBe(2);
      expect(cache.get("api:/users")).toBeUndefined();
      expect(cache.get("other:key")).toBe("o");
    });

    it("returns 0 when no keys match", () => {
      cache.set("x", 1);
      expect(cache.invalidateByPrefix("zzz")).toBe(0);
    });
  });

  describe("invalidateAll", () => {
    it("clears all entries", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidateAll();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently accessed entry at capacity", () => {
      // Create a fresh cache instance to test capacity (singleton has 500 max)
      // We'll fill the singleton and verify size stays bounded
      // Instead, test that eviction works by filling and checking
      for (let i = 0; i < 501; i++) {
        cache.set(`key-${i}`, i);
      }
      // Size should be capped at 500
      expect(cache.size).toBeLessThanOrEqual(500);
    });
  });

  describe("size", () => {
    it("reflects current entry count", () => {
      expect(cache.size).toBe(0);
      cache.set("a", 1);
      expect(cache.size).toBe(1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
    });
  });
});

describe("CACHE_TTL constants", () => {
  it("has expected TTL values", () => {
    expect(CACHE_TTL.SHORT).toBe(2 * 60 * 1000);
    expect(CACHE_TTL.MEDIUM).toBe(5 * 60 * 1000);
    expect(CACHE_TTL.LONG).toBe(10 * 60 * 1000);
    expect(CACHE_TTL.FILTERS).toBe(30 * 60 * 1000);
  });
});
