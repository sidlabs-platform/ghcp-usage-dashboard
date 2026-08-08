// Per-user AI-Credit consumption client — fetches consumption directly from
// GitHub's per-user AI Credit usage endpoint, for use when a licensing
// reconciliation run needs consumption data outside of (or to backfill) the
// bulk billing report export.
//
// Concurrency is bounded via p-limit (an existing project dependency — see
// src/lib/db/sync-service.ts for the established pattern). A single user's
// 404 is treated as an isolated "no data for this user" signal and never
// triggers a fallback — only a capability/run-level failure (forbidden,
// unavailable, malformed, or transport) detected on a single preflight probe
// causes the whole batch to fall over to the per-organization endpoint.
// This client makes no DB writes — repository persistence is a later
// orchestration concern.

import pLimit from "p-limit";
import { githubFetchWithMeta, GitHubApiError } from "./api-base";

// ── Types ────────────────────────────────────────────────────────────────

export type AicConsumptionSource = "enterprise_api" | "org_api";

/** Distinguishes *why* a given user's consumption could not be retrieved. */
export type AicConsumptionErrorKind =
  | "not_found" // 404 — no data for this specific user (isolated; never triggers fallback)
  | "forbidden" // 403 — credential lacks access to the endpoint (capability/run-level)
  | "unavailable" // any other non-retryable HTTP failure — endpoint not supported/reachable
  | "malformed" // 2xx response body did not match the expected shape
  | "transport_error" // network/transport failure (including retries exhausted)
  | "internal_error"; // an unexpected, non-API failure (e.g. a programmer bug) — never mislabeled as "malformed"

export interface AicConsumptionRecord {
  /** "YYYY-MM" billing period the usage was queried for. */
  billingPeriod: string;
  orgLogin: string | null;
  userLogin: string;
  credits: number;
  grossUsd: number;
  netUsd: number | null;
  source: AicConsumptionSource;
  raw: unknown;
}

export interface AicConsumptionOk {
  status: "ok";
  userLogin: string;
  record: AicConsumptionRecord;
}

export interface AicConsumptionError {
  status: AicConsumptionErrorKind;
  userLogin: string;
  /** Sanitized, safe-to-display message — never includes headers or tokens. */
  message: string;
  /**
   * Non-user-specific detail carried alongside the classification (e.g. the
   * HTTP status for "unavailable", or the parse/shape issue for
   * "malformed"), so a per-user message can be regenerated for *every* user
   * in a batch — without ever reusing another user's fully-rendered message
   * verbatim — when a single capability-level failure is copied across the
   * whole batch (see `buildErrorMessage`/`toBatchFailureResult` below).
   */
  detail?: string;
}

export type AicConsumptionUserResult = AicConsumptionOk | AicConsumptionError;

export interface FetchAicConsumptionOptions {
  /** Enterprise slug to query first, when configured. */
  enterpriseSlug?: string;
  /** Organization login used as a fallback (or primary, when no enterprise is configured). */
  orgLogin?: string;
  year: number;
  /** 1-12 */
  month: number;
  users: string[];
  /** Max concurrent in-flight requests. Default: 4 (matches DEFAULT_AIC_CONCURRENCY / dashboard-config's aicConsumption.concurrency default). */
  concurrency?: number;
  /** USD-per-credit fallback rate, used only when the API response omits an explicit gross USD amount. Default: 0.01 (GitHub flex-billing default). */
  creditToUsd?: number;
}

export interface FetchAicConsumptionResult {
  results: AicConsumptionUserResult[];
  /** Which endpoint ultimately served the batch. */
  source: AicConsumptionSource;
  /** True when the run fell back from the enterprise endpoint to the org endpoint. */
  fellBackToOrg: boolean;
}

export const DEFAULT_AIC_CONCURRENCY = 4;
const DEFAULT_CREDIT_TO_USD = 0.01;

// ── Response normalization ───────────────────────────────────────────────

/**
 * Thrown internally when a 2xx response body does not match the expected
 * shape. Deliberately **user-neutral** — the message never embeds a login —
 * so it can be safely reused as the shared `detail` when a single
 * capability-level failure is copied across an entire batch (see
 * `toBatchFailureResult`); each per-user display message is only ever
 * constructed later, in `buildErrorMessage`, which is the sole place a
 * login is added to the text.
 */
class MalformedAicResponseError extends Error {}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function normalizeAicUsageResponse(
  raw: unknown,
  userLogin: string,
  source: AicConsumptionSource,
  billingPeriod: string,
  creditToUsd: number,
  fallbackOrgLogin: string | null,
): AicConsumptionRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    // User-neutral message — never embeds `userLogin` (see MalformedAicResponseError docs).
    throw new MalformedAicResponseError("response was not a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const credits = firstFiniteNumber(body.credits, body.quantity, body.ai_credits);
  if (credits === undefined) {
    throw new MalformedAicResponseError("response is missing a numeric credits/quantity value");
  }

  const grossUsd =
    firstFiniteNumber(body.gross_amount_usd, body.grossAmountUsd, body.gross_usd) ?? credits * creditToUsd;
  const netUsd = firstFiniteNumber(body.net_amount_usd, body.netAmountUsd, body.net_usd) ?? null;
  const orgLogin = typeof body.organization === "string" && body.organization.length > 0
    ? body.organization
    : fallbackOrgLogin;

  return {
    billingPeriod,
    orgLogin,
    userLogin,
    credits,
    grossUsd,
    netUsd,
    source,
    raw: body,
  };
}

// ── Error classification ─────────────────────────────────────────────────

/**
 * Build a per-user, sanitized display message for a given error kind. Used
 * both for a single freshly-classified error and to *regenerate* a distinct,
 * correctly-user-named message for every user when a single capability-level
 * failure (from the preflight probe) is copied across an entire batch — so
 * no user ever sees another user's login embedded in their message. `detail`
 * (when present) must always be user-neutral text — the *only* place a
 * login is ever woven into the message is here, per-call, for `userLogin`.
 */
function buildErrorMessage(kind: AicConsumptionErrorKind, userLogin: string, detail?: string): string {
  switch (kind) {
    case "not_found":
      return `No AI credit usage found for user "${userLogin}"`;
    case "forbidden":
      return `Access to the AI credit usage endpoint is forbidden for user "${userLogin}"`;
    case "transport_error":
      return `Transport error fetching AI credit usage for user "${userLogin}"`;
    case "unavailable":
      return `AI credit usage endpoint returned HTTP ${detail ?? "?"} for user "${userLogin}"`;
    case "malformed":
      return detail
        ? `Malformed AI credit usage response for user "${userLogin}": ${detail}`
        : `Malformed AI credit usage response for user "${userLogin}"`;
    case "internal_error":
      return detail
        ? `Unexpected internal error fetching AI credit usage for user "${userLogin}": ${detail}`
        : `Unexpected internal error fetching AI credit usage for user "${userLogin}"`;
  }
}

function classifyError(err: unknown, userLogin: string): AicConsumptionError {
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return { status: "not_found", userLogin, message: buildErrorMessage("not_found", userLogin) };
    }
    if (err.status === 403) {
      return { status: "forbidden", userLogin, message: buildErrorMessage("forbidden", userLogin) };
    }
    if (err.status === 0) {
      return { status: "transport_error", userLogin, message: buildErrorMessage("transport_error", userLogin) };
    }
    const detail = String(err.status);
    return { status: "unavailable", userLogin, message: buildErrorMessage("unavailable", userLogin, detail), detail };
  }
  if (err instanceof MalformedAicResponseError) {
    // err.message is guaranteed user-neutral (see MalformedAicResponseError docs).
    return { status: "malformed", userLogin, message: buildErrorMessage("malformed", userLogin, err.message), detail: err.message };
  }
  // Any other unexpected failure (e.g. a programmer bug surfaced as a
  // TypeError, or some other non-network, non-API-shape exception) is
  // deliberately NOT classified as "malformed" — that classification means
  // "the API replied but its body didn't match the expected shape", which
  // this is not. Isolating it as its own "internal_error" kind (rather than
  // re-throwing) preserves this batch's per-user isolation guarantee — one
  // user's unexpected failure never aborts the other concurrent fetches —
  // while still keeping it clearly distinguishable from both a genuine
  // malformed API response and a false "ok".
  const detail = err instanceof Error ? err.message : String(err);
  return { status: "internal_error", userLogin, message: buildErrorMessage("internal_error", userLogin, detail), detail };
}

/**
 * Re-classify an already-classified capability-level failure for a
 * *different* user, without re-issuing any request or performing a broad
 * catch — this is used when a single preflight failure (forbidden,
 * unavailable, malformed, or transport_error) is applied across an entire
 * batch because no org fallback destination is configured. Each user gets
 * its own correctly-named message built from the same non-user-specific
 * `detail`, so the failure is never a verbatim copy of the preflight user's
 * result.
 */
function toBatchFailureResult(failure: AicConsumptionError, userLogin: string): AicConsumptionError {
  return {
    status: failure.status,
    userLogin,
    message: buildErrorMessage(failure.status, userLogin, failure.detail),
    detail: failure.detail,
  };
}

// ── Deduplication ─────────────────────────────────────────────────────────

/**
 * Dedupe a list of user logins case-insensitively — GitHub logins are
 * case-insensitive, so "Alice"/"alice"/"ALICE" all identify the same
 * holder. Preserves the first-seen literal casing and first-seen order for
 * each distinct holder, so exactly one call (preflight or otherwise) is
 * ever issued per distinct holder, regardless of how many differently-cased
 * duplicates were requested.
 */
function dedupeUsersCaseInsensitive(users: string[]): string[] {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const user of users) {
    const key = user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(user);
  }
  return distinct;
}

// ── Endpoint path builders ───────────────────────────────────────────────

function enterpriseUsagePath(enterpriseSlug: string, year: number, month: number, user: string): string {
  return `/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/ai_credit/usage?year=${year}&month=${month}&user=${encodeURIComponent(user)}`;
}

function orgUsagePath(orgLogin: string, year: number, month: number, user: string): string {
  return `/organizations/${encodeURIComponent(orgLogin)}/settings/billing/ai_credit/usage?year=${year}&month=${month}&user=${encodeURIComponent(user)}`;
}

// ── Single-user fetch ─────────────────────────────────────────────────────

async function fetchOneUser(
  path: string,
  userLogin: string,
  source: AicConsumptionSource,
  billingPeriod: string,
  creditToUsd: number,
  fallbackOrgLogin: string | null,
  enterpriseSlug: string | undefined,
): Promise<AicConsumptionUserResult> {
  try {
    const resp = await githubFetchWithMeta<unknown>(path, { retries: 3, authMode: "pat", enterpriseSlug });
    const record = normalizeAicUsageResponse(resp.data, userLogin, source, billingPeriod, creditToUsd, fallbackOrgLogin);
    return { status: "ok", userLogin, record };
  } catch (err) {
    return classifyError(err, userLogin);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Fetch per-user AI-credit consumption for a batch of users for a given
 * "YYYY-MM" billing period, bounded by `concurrency` concurrent requests.
 *
 * Behavior:
 *  - When `enterpriseSlug` is configured, a single preflight request is made
 *    for the first user against the enterprise endpoint. A 404 on that
 *    probe is treated the same as any other user's 404 (isolated
 *    "not_found", no fallback) since it only indicates that specific user
 *    has no recorded consumption. Any other failure classification
 *    (forbidden/unavailable/malformed/transport_error) is treated as a
 *    capability/run-level signal that the enterprise endpoint cannot serve
 *    this batch, and — when `orgLogin` is also configured — the *entire*
 *    batch (including the preflight user) is retried against the
 *    organization endpoint instead.
 *  - When only `orgLogin` is configured (no enterprise), every user is
 *    fetched directly from the organization endpoint.
 *  - Once the enterprise endpoint is confirmed usable, every other user's
 *    404 is an isolated per-user result — it never triggers a fallback and
 *    processing of the remaining users continues normally.
 *  - `not_found` (404) is the *only* isolated, per-user classification.
 *    `forbidden`, `unavailable`, `malformed`, `transport_error`, and
 *    `internal_error` are all treated identically as capability/run-level
 *    signals when observed on the preflight probe — each remains
 *    individually distinguishable in the returned results (statuses are
 *    never collapsed into one another), but all five equally trigger the
 *    org fallback (when configured).
 *  - `users` is deduped case-insensitively before any request is made
 *    (GitHub logins are case-insensitive), preserving first-seen casing and
 *    order, so exactly **one call is issued per distinct holder** — never
 *    once per literal, possibly differently-cased, input entry.
 */
export async function fetchAicConsumptionForUsers(
  options: FetchAicConsumptionOptions,
): Promise<FetchAicConsumptionResult> {
  const {
    enterpriseSlug,
    orgLogin,
    year,
    month,
    concurrency = DEFAULT_AIC_CONCURRENCY,
    creditToUsd = DEFAULT_CREDIT_TO_USD,
  } = options;

  if (!enterpriseSlug && !orgLogin) {
    throw new Error("fetchAicConsumptionForUsers requires either enterpriseSlug or orgLogin to be configured");
  }

  // One call per distinct holder: dedupe case-insensitively up front, before
  // the preflight probe, any concurrent fetch, or any org fallback — every
  // later step operates purely on this deduped list.
  const users = dedupeUsersCaseInsensitive(options.users);

  const billingPeriod = `${year}-${String(month).padStart(2, "0")}`;
  const limit = pLimit(Math.max(1, concurrency));

  if (users.length === 0) {
    return { results: [], source: enterpriseSlug ? "enterprise_api" : "org_api", fellBackToOrg: false };
  }

  // Org-only mode: no enterprise endpoint to try at all.
  if (!enterpriseSlug) {
    const results = await Promise.all(
      users.map((user) =>
        limit(() => fetchOneUser(orgUsagePath(orgLogin!, year, month, user), user, "org_api", billingPeriod, creditToUsd, orgLogin!, undefined)),
      ),
    );
    return { results, source: "org_api", fellBackToOrg: false };
  }

  // Preflight: probe the enterprise endpoint with the first user only, to
  // detect capability/run-level unavailability before committing the whole
  // batch to it (see docstring above for the full rationale).
  const [firstUser, ...restUsers] = users;
  const preflightResult = await fetchOneUser(
    enterpriseUsagePath(enterpriseSlug, year, month, firstUser),
    firstUser,
    "enterprise_api",
    billingPeriod,
    creditToUsd,
    orgLogin ?? null,
    enterpriseSlug,
  );

  const isCapabilityLevelFailure = preflightResult.status !== "ok" && preflightResult.status !== "not_found";

  if (isCapabilityLevelFailure) {
    if (!orgLogin) {
      // No fallback destination configured — every user fails with the same
      // *classification* the preflight probe hit, but each gets its own
      // freshly-built, correctly-user-named message (never the preflight
      // user's message copied verbatim) — see `toBatchFailureResult`.
      const failure = preflightResult as AicConsumptionError;
      const results: AicConsumptionUserResult[] = users.map((user) => toBatchFailureResult(failure, user));
      return { results, source: "enterprise_api", fellBackToOrg: false };
    }
    // Capability/run-level failure with a fallback destination — retry the
    // *entire* batch (including the preflight user) against the org endpoint.
    const results = await Promise.all(
      users.map((user) =>
        limit(() => fetchOneUser(orgUsagePath(orgLogin, year, month, user), user, "org_api", billingPeriod, creditToUsd, orgLogin, undefined)),
      ),
    );
    return { results, source: "org_api", fellBackToOrg: true };
  }

  // Enterprise endpoint confirmed usable (ok or isolated not_found) — fetch
  // the remaining users concurrently on the same endpoint.
  const restResults = await Promise.all(
    restUsers.map((user) =>
      limit(() =>
        fetchOneUser(enterpriseUsagePath(enterpriseSlug, year, month, user), user, "enterprise_api", billingPeriod, creditToUsd, orgLogin ?? null, enterpriseSlug),
      ),
    ),
  );

  return { results: [preflightResult, ...restResults], source: "enterprise_api", fellBackToOrg: false };
}
