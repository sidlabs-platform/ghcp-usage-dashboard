import { NextRequest, NextResponse } from "next/server";
import { getEnterpriseSlugs } from "@/lib/config/enterprise-config";
import {
  preflightEnterpriseAuth,
  ALL_CAPABILITIES,
  type CapabilityResult,
  type CapabilityStatus,
  type EnterprisePreflightResult,
} from "@/lib/github/auth-preflight";
import { GitHubApiError } from "@/lib/github/api-base";
import { withTimeout } from "@/lib/api/timeout";
import { withRateLimit } from "@/lib/api/rate-limit/rate-limiter";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, no-cache, max-age=0" };

// Human labels mirror auth-preflight.ts's internal CAPABILITY_LABELS — kept
// deliberately generic here (no per-capability import needed) since this is
// only used for the two synthesized failure states below.
const CAPABILITY_LABELS: Record<string, string> = {
  copilot_seats: "Copilot seat assignments",
  billing_usage: "Billing usage reports",
  aic_consumption: "AI credit consumption reports",
  audit_log: "Audit log access",
  membership: "Enterprise/org membership",
  identity: "Authenticated identity",
};

const REQUIRED_CAPABILITIES = new Set(["copilot_seats"]);

/**
 * Synthesize a full capability list when the initial identity check itself
 * failed (before any individual capability could be evaluated). Every
 * capability is reported with the same status: "unknown" when the failure
 * was a rate limit or other retryable/transport condition (support genuinely
 * could not be determined — never mislabel this as "unsupported"), or
 * "unsupported" for a definitive, non-retryable credential failure (401/403).
 * The message is always a generic, safe string — the raw error message
 * (which may include upstream diagnostic text) is never echoed to the
 * caller.
 */
function synthesizeResult(enterpriseSlug: string, status: CapabilityStatus, reason: string): EnterprisePreflightResult {
  const capabilities: CapabilityResult[] = ALL_CAPABILITIES.map((capability) => ({
    capability,
    label: CAPABILITY_LABELS[capability] ?? capability,
    status,
    required: REQUIRED_CAPABILITIES.has(capability),
    message: `${CAPABILITY_LABELS[capability] ?? capability}: ${reason}`,
  }));
  return { enterpriseSlug, capabilities, ok: false };
}

async function handler(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const enterprise = params.get("enterprise");
    if (!enterprise) {
      return NextResponse.json(
        { error: "enterprise query parameter is required." },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    if (!getEnterpriseSlugs().includes(enterprise)) {
      return NextResponse.json(
        { error: `Unknown enterprise "${enterprise}".` },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    let result: EnterprisePreflightResult;
    try {
      result = await preflightEnterpriseAuth(enterprise);
    } catch (err) {
      if (err instanceof GitHubApiError) {
        // A retryable failure (primary/secondary rate limiting, or a
        // transport-level condition) means support genuinely could not be
        // determined — report "unknown", not "unsupported".
        if (err.retryable) {
          result = synthesizeResult(enterprise, "unknown", "support could not be determined (rate-limited or temporarily unavailable).");
        } else {
          // A definitive, non-retryable 401/403 on the identity check means
          // the configured credential itself is invalid or unusable. Report
          // every capability as unsupported with a generic, safe message —
          // never echo the raw upstream error message.
          result = synthesizeResult(enterprise, "unsupported", "access could not be verified — the configured credential appears to be invalid.");
        }
      } else {
        throw err;
      }
    }

    return NextResponse.json(result, { status: 200, headers: NO_STORE_HEADERS });
  } catch (err) {
    console.error("License reconciliation preflight error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export const GET = withRateLimit(withTimeout(handler));
