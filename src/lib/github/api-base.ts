// Shared GitHub API fetch utilities with auth, retry, and pagination

import {
  isAppAuthConfigured,
  getInstallationToken,
  validateAppAuth,
  logAuthMode,
  isAppAuthConfiguredForEnterprise,
  getInstallationTokenForEnterprise,
} from "./app-auth";

const GITHUB_API_BASE= process.env.GITHUB_API_BASE || "https://api.github.com";
const API_VERSION = "2026-03-10";

// ── Allowed-origin set for SSRF protection ────────────────────────────

const ALLOWED_ORIGINS: Set<string> = new Set();
try { ALLOWED_ORIGINS.add(new URL(GITHUB_API_BASE).origin); } catch { /* env misconfigured — will fail at fetch time */ }
ALLOWED_ORIGINS.add("https://api.github.com");

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

// ── Enterprise slug lookup ─────────────────────────────────────────────

// Lazy-resolved reference to enterprise config; false = resolution failed permanently
let _getEnterpriseSlugs: (() => string[]) | null | false = null;

/**
 * @internal For testing: inject a custom enterprise slugs provider.
 * Pass null to reset to the default (require-based) resolution.
 */
export function _setEnterpriseSlugsForTesting(fn: (() => string[]) | null): void {
  _getEnterpriseSlugs = fn;
}

function getEnterpriseSlugsInternal(): string[] {
  if (_getEnterpriseSlugs === false) return [];
  if (_getEnterpriseSlugs) return _getEnterpriseSlugs();

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@/lib/config/enterprise-config") as {
      getEnterpriseSlugs: () => string[];
    };
    _getEnterpriseSlugs = mod.getEnterpriseSlugs;
    return _getEnterpriseSlugs();
  } catch {
    _getEnterpriseSlugs = false;
    return [];
  }
}

/**
 * Look up an enterprise slug in the server configuration.
 * Returns the server-owned slug string from config if found, or undefined.
 * This breaks the taint chain: the returned value comes from the config
 * array, not from the user-provided input.
 */
function lookupConfiguredSlug(slug?: string): string | undefined {
  if (!slug) return undefined;
  const knownSlugs = getEnterpriseSlugsInternal();
  return knownSlugs.find(s => s === slug);
}

// ── Validated URL construction ────────────────────────────────────────

/**
 * Construct a validated URL from a root-relative GitHub API path.
 * Absolute and protocol-relative URLs are rejected so caller-controlled input
 * cannot replace the configured API origin.
 */
function assertRootRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`GitHub API path must be root-relative (start with /): ${path.slice(0, 120).replace(/\n|\r/g, "")}`);
  }
}

/**
 * Convert a GitHub API pagination link to the root-relative path accepted by
 * the authenticated transport, rejecting links that escape the API allowlist.
 */
export function toRootRelativeGitHubApiPath(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("/") && !pathOrUrl.startsWith("//")) {
    return pathOrUrl;
  }

  let parsed: URL;
  try {
    parsed = new URL(pathOrUrl);
  } catch {
    throw new Error("GitHub API pagination link is not a valid URL.");
  }
  if (!ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error(`GitHub API pagination link uses a disallowed origin: ${parsed.origin.replace(/\n|\r/g, "")}`);
  }

  let pathname = parsed.pathname;
  try {
    const configuredBase = new URL(GITHUB_API_BASE);
    const basePath = configuredBase.pathname.replace(/\/+$/, "");
    if (
      parsed.origin === configuredBase.origin &&
      basePath &&
      basePath !== "/" &&
      (pathname === basePath || pathname.startsWith(`${basePath}/`))
    ) {
      pathname = pathname.slice(basePath.length) || "/";
    }
  } catch {
    // buildValidatedUrl reports a sanitized configuration error at request time.
  }

  const path = `${pathname}${parsed.search}`;
  assertRootRelativePath(path);
  return path;
}

function buildValidatedUrl(pathOrUrl: string): string {
  assertRootRelativePath(pathOrUrl);
  // Use string concatenation to preserve GHES path prefixes (e.g., /api/v3),
  // then parse to normalize and validate the result.
  const fullUrl = `${GITHUB_API_BASE}${pathOrUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(fullUrl);
  } catch {
    throw new Error(`Invalid constructed URL: ${fullUrl.slice(0, 120).replace(/\n|\r/g, "")}`);
  }
  if (!ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error(`Constructed URL escapes allowed origin: ${parsed.origin.replace(/\n|\r/g, "")}`);
  }
  return parsed.href;
}

// ── Auth context resolution ───────────────────────────────────────────

interface AuthContext {
  mode: AuthMode;
  enterpriseSlug?: string;
}

/**
 * Resolve auth mode and validate enterprise slug in one step.
 * Returns a context with the resolved mode and only a validated enterprise slug.
 * The slug is checked against server config so control-flow decisions
 * are based on server-controlled data, not raw user input.
 */
function resolveAuthContext(path: string, enterpriseSlug?: string): AuthContext {
  // Look up enterprise slug in server config (returns server-owned string or undefined)
  const configuredSlug = lookupConfiguredSlug(enterpriseSlug);

  // If slug was provided but not found in config, fall back to global PAT
  if (enterpriseSlug && !configuredSlug) {
    return { mode: "pat" };
  }

  // Enterprise endpoints → always PAT
  if (path.startsWith("/enterprises/")) {
    return { mode: "pat", enterpriseSlug: configuredSlug };
  }

  // If valid enterprise context (server-owned slug), check for enterprise-level App auth
  if (configuredSlug) {
    return {
      mode: isAppAuthConfiguredForEnterprise(configuredSlug) ? "app" : "pat",
      enterpriseSlug: configuredSlug,
    };
  }

  // Everything else (/orgs/, /repos/, /app/, etc.) → App auth if configured
  return { mode: isAppAuthConfigured() ? "app" : "pat" };
}

/**
 * Resolve auth mode from a root-relative GitHub API path.
 * - Absolute and protocol-relative URLs are rejected
 * - Paths starting with `/enterprises/` → "pat" (always)
 * - All other GitHub API paths → "app" if configured, else "pat"
 */
export function resolveAuthMode(path: string, enterpriseSlug?: string): AuthMode {
  assertRootRelativePath(path);
  return resolveAuthContext(path, enterpriseSlug).mode;
}

/**
 * Resolve auth context, optionally overriding mode with caller-provided value.
 * Validates enterprise slug in both paths to prevent drift.
 */
function resolveOrOverrideContext(
  path: string,
  authMode?: AuthMode,
  enterpriseSlug?: string,
): AuthContext {
  if (authMode) {
    return {
      mode: authMode,
      enterpriseSlug: lookupConfiguredSlug(enterpriseSlug),
    };
  }
  return resolveAuthContext(path, enterpriseSlug);
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
        if (!auth.token) {
          throw new Error(
            `PAT auth requested for enterprise "${enterpriseSlug}" but token is empty. ` +
            `This may indicate an enterprise endpoint is being called in org-only mode.`
          );
        }
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

function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === "string" && reason.length > 0 ? reason : "The operation was aborted.",
    "AbortError",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortErrorFromSignal(signal);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErrorFromSignal(signal!));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ── Adaptive rate-limit tracking (per auth context) ───────────────────

interface RateLimitState {
  remaining: number;
  resetAt: number; // Unix timestamp in ms
}

const rateLimitStates = new Map<string, RateLimitState>();

/** @internal Reset adaptive rate-limit tracking state — for testing only. */
export function _resetRateLimitStateForTesting(): void {
  rateLimitStates.clear();
}

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
    const parsed = parseInt(remaining, 10);
    if (Number.isFinite(parsed)) state.remaining = parsed;
  }
  if (reset !== null) {
    const parsed = parseInt(reset, 10);
    if (Number.isFinite(parsed)) state.resetAt = parsed * 1000;
  }
}

// Cap the proactive "wait until reset" delay so a single low-quota check
// can never stall a request for close to an hour — mirrors the cap applied
// to explicit server-provided retry hints further below (Retry-After/reset).
const ADAPTIVE_DELAY_CAP_MS = 120_000;

/**
 * Adaptive delay based on remaining rate limit quota for a specific auth context.
 * - > 1000 remaining: no delay
 * - 100–1000 remaining: 200ms delay
 * - < 100 remaining: wait until reset, capped at `ADAPTIVE_DELAY_CAP_MS`
 */
async function adaptiveRateDelay(mode: AuthMode, enterpriseSlug?: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (mode === "none") return; // No rate limits for pre-signed URLs
  const state = getRateLimitState(mode, enterpriseSlug);
  if (state.remaining > 1000) return;
  if (state.remaining > 100) {
    await sleep(200, signal);
    return;
  }
  // Low quota: wait until reset, but never more than the cap — a stale or
  // bogus far-future reset timestamp must not stall the request for close
  // to an hour.
  const waitMs = Math.min(Math.max(0, state.resetAt - Date.now() + 1000), ADAPTIVE_DELAY_CAP_MS);
  if (waitMs > 0) {
    const label = enterpriseSlug ? `${enterpriseSlug.replace(/\n|\r/g, "")}:${mode}` : mode;
    console.warn("[Rate Limit] (%s) Only %d requests remaining, waiting %ds until reset", label, state.remaining, Math.round(waitMs / 1000));
    await sleep(waitMs, signal);
  }
}

/**
 * Typed error carrying the HTTP status code from a failed GitHub API call.
 * `retryable` marks failures that were classified as transient/rate-limited
 * at the time they were thrown (429, 5xx, secondary/primary rate-limited
 * 403s, or a transport-level failure using the `0` sentinel status) — even
 * when retries were exhausted or skipped (e.g. a single-attempt probe).
 * Callers like the auth preflight use this to distinguish "throttled, try
 * again later" from a genuine permission denial.
 */
export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    path: string,
    body: string,
    public readonly retryable: boolean = false,
  ) {
    super(`GitHub API error ${status} on ${path}: ${body}`);
    this.name = "GitHubApiError";
  }
}

// ── Selected response header exposure (never Authorization) ──────────

// Explicit allowlist — Authorization must never appear here even if a
// misbehaving upstream (or test double) echoes it back. Because we only
// ever iterate this fixed allowlist (which never contains "authorization")
// to populate the result, there is no code path that could set it — no
// defensive `delete` is needed or possible to exercise.
const SELECTED_RESPONSE_HEADERS = [
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
  "x-ratelimit-resource",
  "retry-after",
  "link",
] as const;

function selectResponseHeaders(resp: Response): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of SELECTED_RESPONSE_HEADERS) {
    const value = resp.headers.get(key);
    if (value != null) selected[key] = value;
  }
  return selected;
}

// ── Hardened retry classification & capped exponential full jitter ───

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
// Ceiling applied to explicit server-provided waits (Retry-After / reset)
// so a misbehaving upstream can't stall a request indefinitely.
const SERVER_HINT_CAP_MS = 120_000;
// Sentinel status used for GitHubApiError when no HTTP response was ever
// received (DNS failure, connection refused, timeout, etc.) — 0 is not a
// valid HTTP status code, so it's unambiguous as a "transport failure" marker.
const TRANSPORT_FAILURE_STATUS = 0;

function isRateLimitedResponseBody(bodyText: string): boolean {
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("secondary rate limit") ||
    lower.includes("secondary-rate-limit") ||
    lower.includes("abuse detection") ||
    // Primary rate limiting — GitHub returns this exact phrase (historically
    // as 403, occasionally as 429) when the request quota is exhausted.
    lower.includes("api rate limit exceeded")
  );
}

/** Read a response body defensively — tolerates test doubles without `.text()`. */
async function safeResponseText(resp: Response): Promise<string> {
  if (typeof resp.text !== "function") return "";
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/**
 * Determine whether a failed response should be retried:
 * - 429 and 5xx are always retryable.
 * - 403 is retryable only when it carries primary/secondary/abuse rate-limit
 *   signals (a Retry-After header, or a recognizable phrase in the body).
 *   Plain 403s (missing scope, disabled feature, etc.) still fail fast.
 * This is the single source of truth for retry classification — every
 * failure branch below routes through it so there's no duplicated (and
 * potentially drifting) logic. It also doubles as the "is this failure
 * rate-limit-related?" signal carried on GitHubApiError.retryable, so
 * callers (e.g. the auth preflight) can tell throttling apart from a
 * genuine permission denial even on a single-attempt request.
 */
function isRetryableFailure(status: number, resp: Response, bodyText: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 403) {
    if (resp.headers.get("retry-after") != null) return true;
    return isRateLimitedResponseBody(bodyText);
  }
  return false;
}

/**
 * Capped exponential backoff with full jitter: random(0, min(cap, base*2^attempt)).
 * Exported (as a thin wrapper) so tests can assert exact, deterministic
 * values by stubbing Math.random instead of relying on fake-timer ranges.
 */
function jitterBackoffMs(attempt: number): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  return Math.random() * exponential;
}

/**
 * Compute the wait time before the next retry attempt, given the raw
 * Retry-After and X-RateLimit-Reset header values (or null if absent).
 * Priority: Retry-After header > X-RateLimit-Reset header > capped
 * exponential backoff with full jitter. Server-provided hints are capped at
 * `SERVER_HINT_CAP_MS` so a misbehaving upstream can't stall indefinitely.
 */
function computeRetryDelayMs(attempt: number, retryAfterHeader: string | null, resetHeader: string | null): number {
  const parsedRetryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
  if (Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0) {
    return Math.min(parsedRetryAfter * 1000, SERVER_HINT_CAP_MS);
  }

  const parsedReset = resetHeader ? parseInt(resetHeader, 10) : NaN;
  if (Number.isFinite(parsedReset)) {
    const waitMs = parsedReset * 1000 - Date.now();
    if (waitMs > 0) return Math.min(waitMs, SERVER_HINT_CAP_MS);
  }

  return jitterBackoffMs(attempt);
}

function computeRetryDelayMsForResponse(attempt: number, resp: Response): number {
  return computeRetryDelayMs(attempt, resp.headers.get("retry-after"), resp.headers.get("x-ratelimit-reset"));
}

/**
 * @internal Pure, deterministic access to the retry backoff formula — for
 * testing only. Lets tests assert exact delay values (e.g. with Math.random
 * stubbed to 0 or 1) instead of relying on loose fake-timer ranges.
 */
export function _computeRetryDelayMsForTesting(
  attempt: number,
  retryAfterHeader: string | null = null,
  resetHeader: string | null = null,
): number {
  return computeRetryDelayMs(attempt, retryAfterHeader, resetHeader);
}

export interface GithubFetchMetaOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  retries?: number;
  authMode?: AuthMode;
  enterpriseSlug?: string;
  extraHeaders?: Record<string, string>;
  /** Optional cancellation signal for callers that need to bound one request including retry/backoff waits. */
  signal?: AbortSignal;
}

export interface GithubFetchMetaResult<T> {
  /**
   * The parsed response body, or `null` for a 204 No Content response.
   * Honestly typed as nullable — see `githubFetch` for the historical
   * non-null public contract preserved on top of this primitive.
   */
  data: T | null;
  status: number;
  /** Selected response headers only — never includes Authorization. */
  headers: Record<string, string>;
}

// Header names that extraHeaders may never set, case-insensitively — these
// are owned by the request primitive itself: real credentials, and the
// content type that matches the JSON body we actually send.
const PROTECTED_REQUEST_HEADER_NAMES = new Set(["authorization", "content-type"]);

/**
 * Merge auth headers with caller-supplied extraHeaders into a real Headers
 * instance (so header-name matching is case-insensitive, matching what the
 * underlying fetch implementation will do), while guaranteeing extraHeaders
 * can never override Authorization or the JSON body's Content-Type.
 */
function buildRequestHeaders(
  authHeaders: Record<string, string>,
  extraHeaders: Record<string, string> | undefined,
  hasJsonBody: boolean,
): Headers {
  const headers = new Headers(authHeaders);
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      if (PROTECTED_REQUEST_HEADER_NAMES.has(key.toLowerCase())) continue;
      headers.set(key, value);
    }
  }
  if (hasJsonBody) headers.set("Content-Type", "application/json");
  return headers;
}

/**
 * @internal Authenticated request primitive shared by githubFetch and the
 * GraphQL/preflight clients. Reuses validated URL construction, enterprise
 * token selection, auth readiness, adaptive rate tracking, and hardened
 * retry behavior. Returns the parsed body alongside status and a small
 * allowlisted set of response headers — the Authorization header sent on
 * the request is never exposed on the returned result, and extraHeaders can
 * never override Authorization or Content-Type.
 *
 * Retry exhaustion (for retryable 429/5xx/secondary-403 failures, or
 * repeated transport-level failures such as a refused connection) throws a
 * typed GitHubApiError carrying the last observed status/body — transport
 * failures use a `0` sentinel status — with `retryable: true`, so callers
 * like the auth preflight can classify these as "unknown" outcomes rather
 * than a genuine permission denial, instead of only ever seeing a generic
 * error. Non-retryable failures (a real permission-denied 403, a plain
 * 404, etc.) throw immediately with `retryable: false`.
 */
export async function githubFetchWithMeta<T>(
  path: string,
  options: GithubFetchMetaOptions = {},
): Promise<GithubFetchMetaResult<T>> {
  const { method = "GET", body, retries = 3, authMode, enterpriseSlug, extraHeaders, signal } = options;
  const url = buildValidatedUrl(path);
  const ctx = resolveOrOverrideContext(path, authMode, enterpriseSlug);
  await ensureAuthReady(ctx.mode);
  throwIfAborted(signal);

  let lastStatus = TRANSPORT_FAILURE_STATUS;
  let lastBody = "";

  for (let attempt = 0; attempt < retries; attempt++) {
    await adaptiveRateDelay(ctx.mode, ctx.enterpriseSlug, signal);
    throwIfAborted(signal);
    const authHeaders = await headersForAuth(ctx.mode, ctx.enterpriseSlug);
    throwIfAborted(signal);
    const headers = buildRequestHeaders(authHeaders, extraHeaders, body !== undefined);
    const init: RequestInit = { method, headers, cache: "no-store" };
    if (signal) init.signal = signal;
    if (body !== undefined) init.body = JSON.stringify(body);

    let resp: Response;
    try {
      resp = await fetch(url, init);
    } catch (err) {
      if (signal?.aborted) throw abortErrorFromSignal(signal);
      // Transport-level failure — no HTTP response was ever received (DNS,
      // connection refused, timeout, etc.). Treat it like any other
      // retryable failure so a transient network blip doesn't need special
      // handling by callers.
      lastStatus = TRANSPORT_FAILURE_STATUS;
      lastBody = err instanceof Error ? err.message : String(err);
      if (attempt < retries - 1) {
        const waitMs = jitterBackoffMs(attempt);
        console.warn(
          "GitHub API transport error on %s, retrying in %dms (attempt %d/%d): %s",
          path.replace(/\n|\r/g, ""), Math.round(waitMs), attempt + 1, retries, lastBody.replace(/\n|\r/g, ""),
        );
        await sleep(waitMs, signal);
        continue;
      }
      break;
    }

    updateRateLimit(resp, ctx.mode, ctx.enterpriseSlug);

    // Per the Fetch spec, a 204 response always has `ok === true` — there is
    // no real-world case where a 204 arrives with `ok === false`, so only
    // this branch (nested under `resp.ok`) is ever reachable for it.
    if (resp.ok) {
      let data: T | null = null;
      if (resp.status !== 204) {
        try {
          data = (await resp.json()) as T;
        } catch {
          throw new GitHubApiError(resp.status, path, "Response body was not valid JSON.", false);
        }
      }
      return { data, status: resp.status, headers: selectResponseHeaders(resp) };
    }

    const bodyText = await safeResponseText(resp);

    if (isRetryableFailure(resp.status, resp, bodyText)) {
      lastStatus = resp.status;
      lastBody = bodyText;
      if (attempt < retries - 1) {
        const waitMs = computeRetryDelayMsForResponse(attempt, resp);
        console.warn(
          "GitHub API %d on %s, retrying in %dms (attempt %d/%d)",
          resp.status, path.replace(/\n|\r/g, ""), Math.round(waitMs), attempt + 1, retries,
        );
        await sleep(waitMs, signal);
        continue;
      }
      break;
    }

    throw new GitHubApiError(resp.status, path, bodyText, false);
  }

  // Exhausted all retry attempts on a retryable failure — preserve the last
  // observed status/body as a typed GitHubApiError instead of a generic
  // Error, so callers (e.g. the auth preflight) can classify the outcome
  // (e.g. "unknown") rather than only ever seeing an opaque failure. We only
  // ever reach here via a retryable (or transport) path — a non-retryable
  // failure always throws immediately above — so `retryable` is always true.
  throw new GitHubApiError(
    lastStatus,
    path,
    lastBody || `Exhausted ${retries} retries with no response body.`,
    true,
  );
}

/**
 * Public, backward-compatible entry point. `githubFetch` has always
 * resolved to `null` (cast to the caller's expected `T`) for 204 responses;
 * `githubFetchWithMeta` now honestly types that as `T | null`, so this
 * explicit cast preserves githubFetch's original runtime behavior and
 * public type signature without forcing every existing caller to add a
 * null-check for a case they've never had to handle.
 */
export async function githubFetch<T>(path: string, retries = 3, authMode?: AuthMode, enterpriseSlug?: string): Promise<T> {
  const result = await githubFetchWithMeta<T>(path, { retries, authMode, enterpriseSlug });
  return result.data as T;
}

export async function githubFetchPaginated<T>(path: string, perPage = 100, authMode?: AuthMode, enterpriseSlug?: string): Promise<T[]> {
  const ctx = resolveOrOverrideContext(path, authMode, enterpriseSlug);
  await ensureAuthReady(ctx.mode);
  const all: T[] = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const pageUrl = `${path}${separator}per_page=${perPage}&page=${page}`;
    const fullUrl = buildValidatedUrl(pageUrl);
    await adaptiveRateDelay(ctx.mode, ctx.enterpriseSlug);
    const hdrs = await headersForAuth(ctx.mode, ctx.enterpriseSlug);
    const resp = await fetch(fullUrl, { headers: hdrs, cache: "no-store" });

    if (!resp.ok) {
      if (resp.status === 204) break;
      throw new Error(`GitHub API error ${resp.status} on ${pageUrl.replace(/\n|\r/g, "")}`);
    }

    updateRateLimit(resp, ctx.mode, ctx.enterpriseSlug);

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
  let skipped = 0;

  function safeParse(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      skipped++;
      console.warn("[fetchNDJSON] Skipping malformed line: %s", trimmed.slice(0, 120).replace(/\n|\r/g, ""));
    }
  }

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
      buffer = lines.pop() || "";

      for (const line of lines) {
        safeParse(line);
      }
    }

    safeParse(buffer);
  } else {
    const text = await resp.text();
    for (const line of text.split("\n")) {
      safeParse(line);
    }
  }

  if (skipped > 0) {
    console.warn(`[fetchNDJSON] Skipped ${skipped} malformed line(s) out of ${results.length + skipped}`);
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
  const ctx = resolveOrOverrideContext(path, authMode, enterpriseSlug);
  await ensureAuthReady(ctx.mode);
  const all: T[] = [];
  let page = 1;
  const MAX_PAGES = 500;

  while (page <= MAX_PAGES) {
    const separator = path.includes("?") ? "&" : "?";
    const pageUrl = `${path}${separator}per_page=${perPage}&page=${page}`;
    const fullUrl = buildValidatedUrl(pageUrl);
    await adaptiveRateDelay(ctx.mode, ctx.enterpriseSlug);
    const hdrs = await headersForAuth(ctx.mode, ctx.enterpriseSlug);
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
      throw new Error(`GitHub API error ${resp.status}: ${body.replace(/\n|\r/g, "")}`);
    }

    const batch: T[] = await resp.json();
    updateRateLimit(resp, ctx.mode, ctx.enterpriseSlug);
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
  const ctx = resolveOrOverrideContext(path, authMode, enterpriseSlug);
  await ensureAuthReady(ctx.mode);
  const all: T[] = [];
  let after: string | null = null;
  const MAX_ITERATIONS = 500;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const separator: string = path.includes("?") ? "&" : "?";
    const cursorParam: string = after ? `&after=${after}` : "";
    const pageUrl: string = `${path}${separator}per_page=${perPage}${cursorParam}`;
    const fullUrl: string = buildValidatedUrl(pageUrl);
    await adaptiveRateDelay(ctx.mode, ctx.enterpriseSlug);
    const hdrs = await headersForAuth(ctx.mode, ctx.enterpriseSlug);
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
      throw new Error(`GitHub API error ${resp.status}: ${body.replace(/\n|\r/g, "")}`);
    }

    const batch: T[] = await resp.json();
    updateRateLimit(resp, ctx.mode, ctx.enterpriseSlug);
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
