// Authentication capability preflight for licensing/enterprise callers.
// Determines — without ever exposing raw tokens or headers — whether the
// configured credential can reach each capability GitHub's enterprise APIs
// require for usage/billing materialization.
//
// Two detection strategies are used, in priority order:
//  1. Classic PAT: X-OAuth-Scopes is returned on /rate_limit responses for
//     classic personal access tokens. We map the granted scopes (and known
//     alternative/equivalent scopes) directly to capability support.
//  2. Fine-grained PAT / GitHub App installation token: these do not return
//     X-OAuth-Scopes at all, so we probe a minimal read-only endpoint per
//     capability and classify support from the resulting status code.
//
// 401/403 on the initial identity check means the credential itself is
// invalid or unusable — that fails fast rather than producing a
// success-shaped result. Per-capability probe failures (403/404) are
// expected signals of missing (optional) access, not credential failures.

import { githubFetchWithMeta, GitHubApiError } from "./api-base";

// ── Capability catalog ─────────────────────────────────────────────────

export type PreflightCapability =
  | "copilot_seats"
  | "billing_usage"
  | "aic_consumption"
  | "audit_log"
  | "membership"
  | "identity";

export const ALL_CAPABILITIES: readonly PreflightCapability[] = [
  "copilot_seats",
  "billing_usage",
  "aic_consumption",
  "audit_log",
  "membership",
  "identity",
];

// copilot_seats is required for future materialization; everything else is
// optional and only ever produces warnings, never a hard failure.
const REQUIRED_CAPABILITIES = new Set<PreflightCapability>(["copilot_seats"]);

const CAPABILITY_LABELS: Record<PreflightCapability, string> = {
  copilot_seats: "Copilot seat assignments",
  billing_usage: "Billing usage reports",
  aic_consumption: "AI credit consumption reports",
  audit_log: "Audit log access",
  membership: "Enterprise/org membership",
  identity: "Authenticated identity",
};

// Classic PAT scope alternatives — any one of these scopes grants the
// capability. Order does not matter; presence of any is sufficient.
const CAPABILITY_ALT_SCOPES: Record<PreflightCapability, readonly string[]> = {
  copilot_seats: ["manage_billing:copilot", "read:org", "admin:org", "manage_billing:enterprise"],
  billing_usage: ["manage_billing:enterprise", "read:enterprise", "manage_billing:copilot"],
  aic_consumption: ["manage_billing:enterprise", "read:enterprise", "manage_billing:copilot"],
  audit_log: ["read:audit_log", "admin:org", "admin:enterprise"],
  membership: ["read:org", "read:enterprise", "admin:org"],
  identity: ["read:user", "user"],
};

// Minimal read-only probe endpoints used when scope headers are unavailable
// (fine-grained PATs and GitHub App installation tokens don't emit
// X-OAuth-Scopes). Each is the cheapest read call that indicates access.
const PROBE_ENDPOINTS: Record<PreflightCapability, (slug: string) => string> = {
  copilot_seats: (slug) => `/enterprises/${slug}/copilot/billing/seats?per_page=1`,
  billing_usage: (slug) => `/enterprises/${slug}/settings/billing/usage`,
  aic_consumption: (slug) => `/enterprises/${slug}/settings/billing/premium_requests/usage`,
  audit_log: (slug) => `/enterprises/${slug}/audit-log?per_page=1`,
  membership: (slug) => `/enterprises/${slug}/consumed-licenses?per_page=1`,
  identity: () => `/user`,
};

// ── Result types ───────────────────────────────────────────────────────

export type CapabilityStatus = "supported" | "unsupported" | "unknown";

export interface CapabilityResult {
  capability: PreflightCapability;
  /** Human label for display — never includes headers, tokens, or scopes. */
  label: string;
  status: CapabilityStatus;
  required: boolean;
  /** Sanitized, safe-to-display message — never includes headers or tokens. */
  message: string;
}

export interface EnterprisePreflightResult {
  enterpriseSlug: string;
  capabilities: CapabilityResult[];
  /** True only when every required capability is supported. */
  ok: boolean;
}

// ── Message building (sanitized — no headers/tokens ever included) ────

function buildMessage(capability: PreflightCapability, status: CapabilityStatus, required: boolean): string {
  const label = CAPABILITY_LABELS[capability];
  if (status === "supported") return `${label}: access confirmed.`;
  if (status === "unknown") return `${label}: support could not be determined.`;
  return required
    ? `${label}: required access is missing. Grant an appropriate scope or permission.`
    : `${label}: optional access is missing — related features will be unavailable.`;
}

function toResult(capability: PreflightCapability, status: CapabilityStatus): CapabilityResult {
  const required = REQUIRED_CAPABILITIES.has(capability);
  return {
    capability,
    label: CAPABILITY_LABELS[capability],
    status,
    required,
    message: buildMessage(capability, status, required),
  };
}

// ── Fine-grained probing ────────────────────────────────────────────────

/**
 * Probe a minimal read endpoint to determine capability support when scope
 * headers are unavailable. Only narrowly-typed GitHubApiError is inspected:
 * 401 (credential invalid) is rethrown to fail fast; 403/404 (no access to
 * this specific capability) is a legitimate "unsupported" signal; any other
 * GitHubApiError status is reported as "unknown" rather than guessed at.
 * Non-GitHubApiError failures (network errors, etc.) are never swallowed.
 */
async function probeCapability(capability: PreflightCapability, enterpriseSlug: string): Promise<CapabilityStatus> {
  const path = PROBE_ENDPOINTS[capability](enterpriseSlug);
  try {
    await githubFetchWithMeta(path, { retries: 1, authMode: "pat", enterpriseSlug });
    return "supported";
  } catch (err) {
    if (err instanceof GitHubApiError) {
      if (err.status === 401) throw err;
      if (err.status === 403 || err.status === 404) return "unsupported";
      return "unknown";
    }
    throw err;
  }
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Run a capability preflight for a single enterprise's configured PAT.
 * Fails fast (throws) on 401/403 from the initial identity check — that
 * indicates the credential itself is invalid, not merely missing a scope.
 * Returns a structured per-capability result otherwise; only the required
 * `copilot_seats` capability affects the overall `ok` flag.
 */
export async function preflightEnterpriseAuth(enterpriseSlug: string): Promise<EnterprisePreflightResult> {
  // /rate_limit is the cheapest authenticated call and — for classic PATs —
  // returns the granted scopes via X-OAuth-Scopes. A 401/403 here means the
  // credential itself is unusable, so we let it propagate (fail fast).
  const identity = await githubFetchWithMeta<unknown>("/rate_limit", {
    retries: 1,
    authMode: "pat",
    enterpriseSlug,
  });

  const scopesHeader = identity.headers["x-oauth-scopes"];
  const hasClassicScopes = scopesHeader !== undefined;
  const scopes = hasClassicScopes
    ? scopesHeader.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const capabilities: CapabilityResult[] = [];
  for (const capability of ALL_CAPABILITIES) {
    let status: CapabilityStatus;
    if (hasClassicScopes) {
      status = CAPABILITY_ALT_SCOPES[capability].some((scope) => scopes.includes(scope))
        ? "supported"
        : "unsupported";
    } else {
      status = await probeCapability(capability, enterpriseSlug);
    }
    capabilities.push(toResult(capability, status));
  }

  const ok = capabilities
    .filter((c) => c.required)
    .every((c) => c.status === "supported");

  return { enterpriseSlug, capabilities, ok };
}
