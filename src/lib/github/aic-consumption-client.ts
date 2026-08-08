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
  | "transport_error"; // network/transport failure (including retries exhausted)

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

/** Thrown internally when a 2xx response body does not match the expected shape. */
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
    throw new MalformedAicResponseError(`AI credit usage response for user "${userLogin}" was not a JSON object`);
  }
  const body = raw as Record<string, unknown>;

  const credits = firstFiniteNumber(body.credits, body.quantity, body.ai_credits);
  if (credits === undefined) {
    throw new MalformedAicResponseError(
      `AI credit usage response for user "${userLogin}" is missing a numeric credits/quantity value`
    );
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

function classifyError(err: unknown, userLogin: string): AicConsumptionError {
  if (err instanceof GitHubApiError) {
    if (err.status === 404) {
      return { status: "not_found", userLogin, message: `No AI credit usage found for user "${userLogin}"` };
    }
    if (err.status === 403) {
      return {
        status: "forbidden",
        userLogin,
        message: `Access to the AI credit usage endpoint is forbidden for user "${userLogin}"`,
      };
    }
    if (err.status === 0) {
      return {
        status: "transport_error",
        userLogin,
        message: `Transport error fetching AI credit usage for user "${userLogin}"`,
      };
    }
    return {
      status: "unavailable",
      userLogin,
      message: `AI credit usage endpoint returned HTTP ${err.status} for user "${userLogin}"`,
    };
  }
  if (err instanceof MalformedAicResponseError) {
    return { status: "malformed", userLogin, message: err.message };
  }
  // Any other unexpected failure (e.g. a JSON parse error surfaced as a
  // SyntaxError) is treated as malformed rather than aborting the batch.
  return {
    status: "malformed",
    userLogin,
    message: err instanceof Error ? err.message : String(err),
  };
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
 */
export async function fetchAicConsumptionForUsers(
  options: FetchAicConsumptionOptions,
): Promise<FetchAicConsumptionResult> {
  const {
    enterpriseSlug,
    orgLogin,
    year,
    month,
    users,
    concurrency = DEFAULT_AIC_CONCURRENCY,
    creditToUsd = DEFAULT_CREDIT_TO_USD,
  } = options;

  if (!enterpriseSlug && !orgLogin) {
    throw new Error("fetchAicConsumptionForUsers requires either enterpriseSlug or orgLogin to be configured");
  }

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
      // No fallback destination configured — every user fails the same way
      // the preflight probe did, without issuing further requests.
      const failure = preflightResult as AicConsumptionError;
      const results: AicConsumptionUserResult[] = users.map((user) => ({ ...failure, userLogin: user }));
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
