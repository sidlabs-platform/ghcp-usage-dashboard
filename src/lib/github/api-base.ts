// Shared GitHub API fetch utilities with auth, retry, and pagination

import {
  isAppAuthConfigured,
  getInstallationToken,
  validateAppAuth,
  logAuthMode,
  isAppAuthConfiguredForEnterprise,
  getInstallationTokenForEnterprise,
} from "./app-auth";

const GITHUB_API_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";
const API_VERSION = "2026-03-10";

// ── Auth mode abstraction ─────────────────────────────────────────────

export type AuthMode = "pat" | "app" | "none";

/**
 * Returns the PAT token, or throws if GITHUB_TOKEN is not set.
 * Only called when auth mode resolves to "pat".
 */
function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is required for this endpoint. " +
      "Set it in .env.local or configure GitHub App auth for org-level access."
    );
  }
  return token;
}

/**
 * Resolve auth mode from a URL path.
 * - Non-GitHub absolute URLs (pre-signed Azure/S3) → "none"
 * - Paths starting with `/enterprises/` → "pat" (always)
 * - All other GitHub API paths → "app" if configured, else "pat"
 */
export function resolveAuthMode(path: string, enterpriseSlug?: string): AuthMode {
  // Absolute non-GitHub URLs (e.g., pre-signed download links) need no auth
  if (path.startsWith("http")) {
    const isGitHub =
      path.startsWith(GITHUB_API_BASE) ||
      path.startsWith("https://api.github.com");
    if (!isGitHub) return "none";
    // Extract pathname from absolute GitHub URL
    try {
      const url = new URL(path);
      path = url.pathname;
    } catch {
      // If URL parsing fails, fall through to path-based detection
    }
  }

  // Enterprise endpoints → always PAT
  if (path.startsWith("/enterprises/")) return "pat";

  // If enterpriseSlug provided, check if that enterprise has App auth
  if (enterpriseSlug) {
    return isAppAuthConfiguredForEnterprise(enterpriseSlug) ? "app" : "pat";
  }

  // Everything else (/orgs/, /repos/, /app/, etc.) → App auth if configured
  return isAppAuthConfigured() ? "app" : "pat";
}

async function headersForAuth(mode: AuthMode, enterpriseSlug?: string): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
  };

  switch (mode) {
    case "pat":
      if (enterpriseSlug) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getEnterpriseAuth } = require("@/lib/config/enterprise-config") as {
          getEnterpriseAuth: (slug: string) => { token: string };
        };
        const auth = getEnterpriseAuth(enterpriseSlug);
        base.Authorization = `Bearer ${auth.token}`;
      } else {
        base.Authorization = `Bearer ${getToken()}`;
      }
      break;
    case "app":
      if (enterpriseSlug) {
        base.Authorization = `Bearer ${await getInstallationTokenForEnterprise(enterpriseSlug)}`;
      } else {
        base.Authorization = `Bearer ${await getInstallationToken()}`;
      }
      break;
    case "none":
      // No Authorization header (pre-signed URLs, etc.)
      break;
  }

  return base;
}

// Startup logging — fires once
let authModeLogged = false;
let authValidated = false;
let validationPromise: Promise<void> | null = null;

async function ensureAuthReady(mode: AuthMode): Promise<void> {
  if (!authModeLogged) {
    logAuthMode();
    authModeLogged = true;
  }
  if (!authValidated && mode === "app") {
    // Mutex: concurrent callers await the same validation promise
    if (!validationPromise) {
      validationPromise = validateAppAuth()
        .then(() => { authValidated = true; })
        .finally(() => { validationPromise = null; });
    }
    await validationPromise;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Adaptive rate-limit tracking (per auth context) ───────────────────

interface RateLimitState {
  remaining: number;
  resetAt: number; // Unix timestamp in ms
}

const rateLimitStates = new Map<string, RateLimitState>();

function rateLimitKey(mode: AuthMode, enterpriseSlug?: string): string {
  return `${enterpriseSlug ?? "default"}:${mode}`;
}

function getRateLimitState(mode: AuthMode, enterpriseSlug?: string): RateLimitState {
  const key = rateLimitKey(mode, enterpriseSlug);
  let state = rateLimitStates.get(key);
  if (!state) {
    state = { remaining: 5000, resetAt: Date.now() + 3600_000 };
    rateLimitStates.set(key, state);
  }
  return state;
}

function updateRateLimit(resp: Response, mode: AuthMode, enterpriseSlug?: string): void {
  const state = getRateLimitState(mode, enterpriseSlug);
  const remaining = resp.headers.get("x-ratelimit-remaining");
  const reset = resp.headers.get("x-ratelimit-reset");
  if (remaining !== null) {
    state.remaining = parseInt(remaining, 10);
  }
  if (reset !== null) {
    state.resetAt = parseInt(reset, 10) * 1000;
  }
}

/**
 * Adaptive delay based on remaining rate limit quota for a specific auth context.
 * - > 1000 remaining: no delay
 * - 100–1000 remaining: 200ms delay
 * - < 100 remaining: wait until reset
 */
async function adaptiveRateDelay(mode: AuthMode, enterpriseSlug?: string): Promise<void> {
  if (mode === "none") return; // No rate limits for pre-signed URLs
  const state = getRateLimitState(mode, enterpriseSlug);
  if (state.remaining > 1000) return;
  if (state.remaining > 100) {
    await sleep(200);
    return;
  }
  // Low quota: wait until reset
  const waitMs = Math.max(0, state.resetAt - Date.now() + 1000);
  if (waitMs > 0 && waitMs < 3600_000) {
    const label = enterpriseSlug ? `${enterpriseSlug}:${mode}` : mode;
    console.warn(`[Rate Limit] (${label}) Only ${state.remaining} requests remaining, waiting ${Math.round(waitMs / 1000)}s until reset`);
    await sleep(waitMs);
  }
}

/** Typed error carrying the HTTP status code from a failed GitHub API call. */
export class GitHubApiError extends Error {
  constructor(public readonly status: number, path: string, body: string) {
    super(`GitHub API error ${status} on ${path}: ${body}`);
    this.name = "GitHubApiError";
  }
}

export async function githubFetch<T>(path: string, retries = 3, authMode?: AuthMode, enterpriseSlug?: string): Promise<T> {
  const mode = authMode ?? resolveAuthMode(path, enterpriseSlug);
  await ensureAuthReady(mode);
  const url = path.startsWith("http") ? path : `${GITHUB_API_BASE}${path}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    await adaptiveRateDelay(mode, enterpriseSlug);
    const hdrs = await headersForAuth(mode, enterpriseSlug);
    const resp = await fetch(url, { headers: hdrs, cache: "no-store" });
    updateRateLimit(resp, mode, enterpriseSlug);

    if (resp.ok) {
      return resp.json() as Promise<T>;
    }

    if (resp.status === 429 || resp.status >= 500) {
      const retryAfter = resp.headers.get("retry-after");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const waitMs = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : Math.pow(2, attempt) * 1000;
      console.warn(`GitHub API ${resp.status} on ${path}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(waitMs);
      continue;
    }

    if (resp.status === 204) {
      return null as T;
    }

    const body = await resp.text().catch(() => "");
    throw new GitHubApiError(resp.status, path, body);
  }

  throw new Error(`GitHub API failed after ${retries} retries on ${path}`);
}

export async function githubFetchPaginated<T>(path: string, perPage = 100, authMode?: AuthMode, enterpriseSlug?: string): Promise<T[]> {
  const mode = authMode ?? resolveAuthMode(path, enterpriseSlug);
  await ensureAuthReady(mode);
  const all: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}per_page=${perPage}&page=${page}`;
    await adaptiveRateDelay(mode, enterpriseSlug);
    const hdrs = await headersForAuth(mode, enterpriseSlug);
    const resp = await fetch(
      url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`,
      { headers: hdrs, cache: "no-store" }
    );

    if (!resp.ok) {
      if (resp.status === 204) break;
      throw new Error(`GitHub API error ${resp.status} on ${url}`);
    }

    updateRateLimit(resp, mode, enterpriseSlug);

    const data = await resp.json();
    const items = Array.isArray(data) ? data : data.seats || data.members || [];
    if (items.length === 0) break;

    all.push(...items);
    if (items.length < perPage) break;
    page++;
  }

  return all;
}

export async function fetchNDJSON<T>(downloadUrl: string): Promise<T[]> {
  const resp = await fetch(downloadUrl, { cache: "no-store" });
  if (!resp.ok) {
    throw new Error(`Failed to download NDJSON: ${resp.status}`);
  }

  const results: T[] = [];

  // Use streaming if body is available, otherwise fall back to text
  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep incomplete last line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          results.push(JSON.parse(trimmed) as T);
        }
      }
    }

    // Process remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      results.push(JSON.parse(remaining) as T);
    }
  } else {
    // Fallback: load entire response as text
    const text = await resp.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        results.push(JSON.parse(trimmed) as T);
      }
    }
  }

  return results;
}

export async function githubFetchPaginatedWithCutoff<
  T extends { updated_at: string },
>(
  path: string,
  cutoffDate: string | null = null,
  perPage = 100,
  authMode?: AuthMode,
  enterpriseSlug?: string,
): Promise<T[]> {
  const mode = authMode ?? resolveAuthMode(path, enterpriseSlug);
  await ensureAuthReady(mode);
  const all: T[] = [];
  let page = 1;
  const MAX_PAGES = 500;

  while (page <= MAX_PAGES) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${path}${separator}per_page=${perPage}&page=${page}`;
    const fullUrl = url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`;
    await adaptiveRateDelay(mode, enterpriseSlug);
    const hdrs = await headersForAuth(mode, enterpriseSlug);
    const resp = await fetch(fullUrl, { headers: hdrs, cache: "no-store" });

    if (!resp.ok) {
      if (resp.status === 204) break;
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const parsedRetry = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const waitMs = Number.isFinite(parsedRetry) && parsedRetry > 0
          ? parsedRetry * 1000
          : Math.pow(2, page % 3) * 1000;
        console.warn(`GitHub API ${resp.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const body = await resp.text().catch(() => "");
      throw new Error(`GitHub API error ${resp.status}: ${body}`);
    }

    const batch: T[] = await resp.json();
    updateRateLimit(resp, mode, enterpriseSlug);
    if (!batch || batch.length === 0) break;

    if (cutoffDate) {
      let foundCutoff = false;
      for (const item of batch) {
        if (item.updated_at >= cutoffDate) {
          all.push(item);
        } else {
          foundCutoff = true;
        }
      }
      if (foundCutoff) return all;
    } else {
      all.push(...batch);
    }

    if (batch.length < perPage) break;
    page++;
  }

  return all;
}

export async function githubFetchCursorPaginatedWithCutoff<
  T extends { updated_at: string },
>(
  path: string,
  cutoffDate: string | null = null,
  perPage = 100,
  authMode?: AuthMode,
  enterpriseSlug?: string,
): Promise<T[]> {
  const mode = authMode ?? resolveAuthMode(path, enterpriseSlug);
  await ensureAuthReady(mode);
  const all: T[] = [];
  let after: string | null = null;
  const MAX_ITERATIONS = 500;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const separator: string = path.includes("?") ? "&" : "?";
    const cursorParam: string = after ? `&after=${after}` : "";
    const url: string = `${path}${separator}per_page=${perPage}${cursorParam}`;
    const fullUrl: string = url.startsWith("http") ? url : `${GITHUB_API_BASE}${url}`;
    await adaptiveRateDelay(mode, enterpriseSlug);
    const hdrs = await headersForAuth(mode, enterpriseSlug);
    const resp: Response = await fetch(fullUrl, { headers: hdrs, cache: "no-store" });

    if (!resp.ok) {
      if (resp.status === 204) break;
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("retry-after");
        const parsedRetry = retryAfter ? parseInt(retryAfter, 10) : NaN;
        const waitMs = Number.isFinite(parsedRetry) && parsedRetry > 0
          ? parsedRetry * 1000
          : Math.pow(2, i % 3) * 1000;
        console.warn(`GitHub API ${resp.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      const body = await resp.text().catch(() => "");
      throw new Error(`GitHub API error ${resp.status}: ${body}`);
    }

    const batch: T[] = await resp.json();
    updateRateLimit(resp, mode, enterpriseSlug);
    if (!batch || batch.length === 0) break;

    if (cutoffDate) {
      let foundCutoff = false;
      for (const item of batch) {
        if (item.updated_at >= cutoffDate) {
          all.push(item);
        } else {
          foundCutoff = true;
        }
      }
      if (foundCutoff) return all;
    } else {
      all.push(...batch);
    }

    // Extract cursor from Link header: <...&after=CURSOR>; rel="next"
    const linkHeader: string = resp.headers.get("link") || "";
    const nextMatch: RegExpMatchArray | null = linkHeader.match(/<[^>]*[?&]after=([^&>]+)[^>]*>;\s*rel="next"/);
    if (nextMatch) {
      after = nextMatch[1];
    } else {
      break;
    }
  }

  return all;
}

export { GITHUB_API_BASE, sleep, adaptiveRateDelay };
