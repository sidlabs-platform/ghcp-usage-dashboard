// In-memory TTL cache with LRU eviction for API route responses

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  lastAccessed: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

class MemoryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private maxEntries: number;

  constructor(maxEntries = MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    entry.lastAccessed = Date.now();
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = DEFAULT_TTL_MS): void {
    // Evict if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.evictLRU();
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      lastAccessed: Date.now(),
    });
  }

  /** Delete all keys that start with the given prefix */
  invalidateByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Delete all entries */
  invalidateAll(): void {
    this.store.clear();
  }

  /** Get current cache size */
  get size(): number {
    return this.store.size;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.store) {
      // Also evict expired entries while scanning
      if (Date.now() > entry.expiresAt) {
        this.store.delete(key);
        return;
      }
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.store.delete(oldestKey);
    }
  }
}

// Singleton instance shared across all API routes
export const cache = new MemoryCache();

/** TTL constants for different route types */
export const CACHE_TTL = {
  SHORT: 2 * 60 * 1000,   // 2 minutes
  MEDIUM: 5 * 60 * 1000,  // 5 minutes (default)
  LONG: 10 * 60 * 1000,   // 10 minutes
  FILTERS: 30 * 60 * 1000, // 30 minutes
} as const;
