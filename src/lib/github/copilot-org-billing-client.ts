// GitHub Copilot Org Billing Client — org-level seat breakdown/settings.
// API docs: https://docs.github.com/en/rest/copilot/copilot-user-management#get-copilot-seat-information-and-settings-for-an-organization
//
// `GET /orgs/{org}/copilot/billing` returns a snapshot of an org's Copilot
// subscription: plan type, feature policies, and a `seat_breakdown` totals
// object (including pending cancellations). This client normalizes that
// into a stable shape carrying the observed billing period + timestamp and
// the raw payload for auditability.
//
// This endpoint is optional/preview and commonly returns 404 (Copilot not
// enabled for the org) or 403 (caller lacks `manage_billing:copilot`/
// `read:org`) — both are typed, non-throwing "unavailable" outcomes rather
// than a success-shaped empty result, so callers can distinguish "there is
// no data" from "we don't have access to find out".

import { githubFetchWithMeta, GitHubApiError } from "./api-base";

// ── Raw response shape (partial — only fields this client reads) ───────

interface RawSeatBreakdown {
  total?: number;
  added_this_cycle?: number;
  pending_cancellation?: number;
  pending_invitation?: number;
  active_this_cycle?: number;
  inactive_this_cycle?: number;
}

export interface RawOrgCopilotBilling {
  seat_breakdown?: RawSeatBreakdown;
  seat_management_setting?: string;
  plan_type?: string;
  public_code_suggestions?: string;
  ide_chat?: string;
  platform_chat?: string;
  cli?: string;
  [key: string]: unknown;
}

// ── Normalized shape ─────────────────────────────────────────────────────

export interface NormalizedOrgBillingSnapshot {
  orgLogin: string;
  /** "YYYY-MM", the billing period this snapshot was observed in. */
  billingPeriod: string;
  planType: string | null;
  totalSeats: number;
  pendingCancellation: number;
  observedAt: string;
  raw: RawOrgCopilotBilling;
}

/** Discriminated result so 404/403 (optional-source) outcomes are never mistaken for a success with no data. */
export type OrgBillingResult =
  | { status: "ok"; snapshot: NormalizedOrgBillingSnapshot }
  | { status: "unavailable"; reason: "not_found" | "forbidden"; orgLogin: string }
  | { status: "unknown"; orgLogin: string; message: string };

function currentBillingPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function normalizeOrgBilling(org: string, raw: RawOrgCopilotBilling, now: string): NormalizedOrgBillingSnapshot {
  return {
    orgLogin: org,
    billingPeriod: currentBillingPeriod(),
    planType: raw.plan_type ?? null,
    totalSeats: raw.seat_breakdown?.total ?? 0,
    pendingCancellation: raw.seat_breakdown?.pending_cancellation ?? 0,
    observedAt: now,
    raw,
  };
}

export class CopilotOrgBillingClient {
  /**
   * Fetch and normalize `GET /orgs/{org}/copilot/billing`. Returns a typed
   * `unavailable`/`unknown` result (never success-shaped) on 404/403 or any
   * other non-2xx outcome, since this source is optional and its absence is
   * a meaningful, distinct signal from "zero seats".
   */
  async getOrgBilling(org: string, enterpriseSlug?: string): Promise<OrgBillingResult> {
    const now = new Date().toISOString();
    try {
      const result = await githubFetchWithMeta<RawOrgCopilotBilling>(
        `/orgs/${encodeURIComponent(org)}/copilot/billing`,
        { enterpriseSlug },
      );
      if (!result.data) {
        return { status: "unknown", orgLogin: org, message: "Empty response body from Copilot billing endpoint." };
      }
      return { status: "ok", snapshot: normalizeOrgBilling(org, result.data, now) };
    } catch (err) {
      if (err instanceof GitHubApiError) {
        // Check retryable first: GitHub's primary/secondary rate limits
        // commonly exhaust as 403 with retryable=true, and must be reported
        // as a transient "unknown" outcome — never misclassified as a
        // genuine (non-retryable) permission denial. Mirrors
        // auth-preflight's probeCapability ordering.
        if (err.retryable) {
          return { status: "unknown", orgLogin: org, message: `GitHub API error ${err.status} (retryable) fetching org Copilot billing.` };
        }
        if (err.status === 404) return { status: "unavailable", reason: "not_found", orgLogin: org };
        if (err.status === 403) return { status: "unavailable", reason: "forbidden", orgLogin: org };
        return { status: "unknown", orgLogin: org, message: `GitHub API error ${err.status} fetching org Copilot billing.` };
      }
      throw err;
    }
  }
}

export const copilotOrgBillingClient = new CopilotOrgBillingClient();
