// GitHub Audit Log Client — Copilot seat assignment/cancellation events.
// API docs: https://docs.github.com/en/rest/orgs/orgs#get-the-audit-log-for-an-organization
//           https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/using-the-audit-log-api-for-your-enterprise
//
// GitHub's audit log carries seat lifecycle events under several action
// names that have changed over time (a "modern" Copilot-for-Business name
// plus a couple of legacy aliases seen in older enterprises). This client
// requests only Copilot-related entries (`phrase=action:copilot`, GitHub's
// audit-log search syntax for filtering by action category), filters the
// result down to only the seat assign/cancel actions this pipeline cares
// about, and normalizes those into a small, stable shape — preserving the
// GitHub user id/login, external identity (SCIM/SAML nameid, when the entry
// carries one), org, team, and the original raw JSON for auditability.
//
// The audit log is an optional source (an org/enterprise may not have audit
// log access enabled, or the caller's credential may lack `read:audit_log`),
// so every fetch returns a discriminated `AuditFetchResult` rather than
// throwing or silently returning an empty (success-shaped) array — see the
// "Result contract" section below.

import { githubFetchWithMeta, GitHubApiError } from "./api-base";
import { createHash } from "node:crypto";

// ── Raw audit log event (partial — the real payload varies significantly
// by action/category; only fields this client reads are typed) ─────────

/**
 * A raw GitHub audit log entry. GitHub does not publish a single fixed
 * schema for every action — this is deliberately loose/partial, typing only
 * the fields this client actually reads, with everything else preserved
 * untouched in the normalized record's `raw` field.
 */
export interface RawCopilotAuditEvent {
  action?: string;
  actor?: string;
  actor_id?: number;
  /** The affected user's login (i.e. the seat holder), not the actor. */
  user?: string;
  user_id?: number;
  org?: string;
  team?: string;
  business?: string;
  external_identity_nameid?: string;
  external_identity_username?: string;
  /** Epoch milliseconds — the modern audit log timestamp field. */
  "@timestamp"?: number;
  /** Epoch milliseconds — legacy audit log timestamp field, still emitted by some actions. */
  created_at?: number;
  /** Present on most entries; the closest thing to a stable per-event id GitHub provides. */
  _document_id?: string;
  [key: string]: unknown;
}

// ── Action classification (modern + legacy names) ───────────────────────

export type CopilotAuditAction = "assign" | "cancel";

const ASSIGN_ACTIONS: ReadonlySet<string> = new Set([
  "cfb_seat_added",
  "cfb_seat_assignment_created",
  "seat_assigned",
  "seat_refresh",
]);

const CANCEL_ACTIONS: ReadonlySet<string> = new Set([
  "cfb_seat_cancelled",
  "cfb_seat_assignment_unassigned",
  "access_revoked",
  "seat_cancelled",
]);

function classifyAction(action: string | undefined): CopilotAuditAction | null {
  if (!action) return null;
  if (ASSIGN_ACTIONS.has(action)) return "assign";
  if (CANCEL_ACTIONS.has(action)) return "cancel";
  return null;
}

// ── Normalized event shape ───────────────────────────────────────────────

export interface NormalizedCopilotAuditEvent {
  /** Deterministic id — `_document_id` when GitHub provides one, else a stable hash of the event's identifying fields. */
  eventId: string;
  orgLogin: string;
  action: CopilotAuditAction;
  /** ISO 8601 timestamp. */
  occurredAt: string;
  githubUserId: number | null;
  observedLogin: string | null;
  externalIdentity: string | null;
  team: string | null;
  source: "audit_log";
  raw: RawCopilotAuditEvent;
}

function eventTimestampMs(event: RawCopilotAuditEvent): number | null {
  const ts = event["@timestamp"] ?? event.created_at;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
}

/**
 * Build a deterministic event id. GitHub's `_document_id` is already
 * effectively unique and stable across repeated fetches of the same event,
 * so it's used whenever present. When absent, a stable hash of the event's
 * identifying fields is used instead so the same underlying event always
 * produces the same id (needed for dedupe-safe output and idempotent
 * downstream persistence).
 */
function deterministicEventId(event: RawCopilotAuditEvent, orgLogin: string): string {
  if (typeof event._document_id === "string" && event._document_id.length > 0) {
    return event._document_id;
  }
  const material = JSON.stringify([
    orgLogin,
    event.action ?? "",
    event.user ?? "",
    event.user_id ?? "",
    event.actor ?? "",
    eventTimestampMs(event) ?? "",
  ]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

/** Outcome of attempting to normalize a single raw audit event. */
type NormalizeEventOutcome =
  | { kind: "normalized"; event: NormalizedCopilotAuditEvent }
  | { kind: "unrecognized_action" }
  | { kind: "missing_timestamp"; action: CopilotAuditAction; eventId: string };

/**
 * Normalize a single raw event. Unrecognized (non seat-lifecycle) actions
 * are silently skipped — they're outside this pipeline's scope, not a data
 * quality problem. An otherwise-relevant assign/cancel event with no
 * parseable timestamp is a genuine data quality gap, so it's reported as
 * `missing_timestamp` (see `fetchAuditEvents`, which turns that into a
 * structured `AuditFetchOk.warnings` entry) rather than dropped silently.
 */
function normalizeEvent(event: RawCopilotAuditEvent, orgLoginFallback: string): NormalizeEventOutcome {
  const action = classifyAction(event.action);
  if (!action) return { kind: "unrecognized_action" };

  const orgLogin = event.org || orgLoginFallback;
  const ts = eventTimestampMs(event);
  if (ts === null) {
    return { kind: "missing_timestamp", action, eventId: deterministicEventId(event, orgLogin) };
  }

  return {
    kind: "normalized",
    event: {
      eventId: deterministicEventId(event, orgLogin),
      orgLogin,
      action,
      occurredAt: new Date(ts).toISOString(),
      githubUserId: typeof event.user_id === "number" && Number.isFinite(event.user_id) ? event.user_id : null,
      observedLogin: event.user ?? null,
      externalIdentity: event.external_identity_nameid ?? event.external_identity_username ?? null,
      team: event.team ?? null,
      source: "audit_log",
      raw: event,
    },
  };
}

// ── Cursor pagination over the audit log's Link header ──────────────────

export interface CopilotAuditFetchOptions {
  /** Only include events observed at/after this instant (epoch ms). */
  cutoffMs?: number | null;
  /** Only include events observed at/before this instant (epoch ms). */
  untilMs?: number | null;
  /** Safety cap on the number of pages fetched. Must be >= 1. Default 200. */
  maxPages?: number;
  /** Page size (GitHub's audit log max is 100). Default 100. */
  perPage?: number;
  /** Enterprise slug to scope PAT/App auth selection to. */
  enterpriseSlug?: string;
}

function extractNextLink(linkHeader: string | undefined): string | null {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match ? match[1] : null;
}

// ── Result contract ───────────────────────────────────────────────────
//
// The audit log is an optional source, so a fetch never throws for a
// missing/forbidden source and never returns an empty array to mean both
// "genuinely no events" and "we couldn't check" — those are always
// distinguishable via `status`. `ok.truncated`/`ok.warnings` additionally
// surface when the `maxPages` safety cap was hit while more pages were
// still available, so a capped result is never mistaken for a complete one.

export interface AuditFetchOk {
  status: "ok";
  events: NormalizedCopilotAuditEvent[];
  /** True when the `maxPages` cap was hit while more pages were still available — `events` is a partial result. */
  truncated: boolean;
  warnings: string[];
}

export interface AuditFetchUnavailable {
  status: "unavailable";
  reason: "not_found" | "forbidden";
  /** The org login or enterprise slug this fetch targeted. */
  target: string;
}

export interface AuditFetchUnknown {
  status: "unknown";
  target: string;
  message: string;
}

export type AuditFetchResult = AuditFetchOk | AuditFetchUnavailable | AuditFetchUnknown;

async function fetchAuditEvents(
  basePath: string,
  orgLoginFallback: string,
  target: string,
  options: CopilotAuditFetchOptions,
): Promise<AuditFetchResult> {
  const { cutoffMs = null, untilMs = null, maxPages = 200, perPage = 100, enterpriseSlug } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`copilotAuditClient: maxPages must be an integer >= 1 (received ${maxPages}).`);
  }

  const separator = basePath.includes("?") ? "&" : "?";
  // `phrase=action:copilot` is GitHub's audit-log search syntax for
  // filtering to the Copilot action category server-side, rather than
  // relying solely on the client-side assign/cancel action allowlist below.
  let url: string | null = `${basePath}${separator}per_page=${perPage}&phrase=${encodeURIComponent("action:copilot")}`;
  const seenEventIds = new Set<string>();
  const results: NormalizedCopilotAuditEvent[] = [];
  const warnings: string[] = [];
  let truncated = false;

  try {
    for (let page = 0; page < maxPages && url; page++) {
      const result = await githubFetchWithMeta<RawCopilotAuditEvent[]>(url, { enterpriseSlug });
      const events = Array.isArray(result.data) ? result.data : [];
      if (events.length === 0) {
        url = null;
        break;
      }

      // GitHub's audit log is returned newest-first by default, so once we
      // encounter an event older than the cutoff, every later page is
      // guaranteed to be older still — safe to stop paginating there.
      let sawOlderThanCutoff = false;

      for (const raw of events) {
        const ts = eventTimestampMs(raw);
        if (cutoffMs !== null && ts !== null && ts < cutoffMs) {
          sawOlderThanCutoff = true;
          continue;
        }
        if (untilMs !== null && ts !== null && ts > untilMs) continue;

        const outcome = normalizeEvent(raw, orgLoginFallback);
        if (outcome.kind === "unrecognized_action") continue;
        if (outcome.kind === "missing_timestamp") {
          // Structured, non-sensitive warning: only the action name and a
          // deterministic event id are included — never the raw payload
          // (which may carry a login, email, or other identity data).
          warnings.push(
            `Skipped a Copilot audit "${outcome.action}" event (id ${outcome.eventId}) with no parseable timestamp.`,
          );
          continue;
        }
        const normalized = outcome.event;
        if (seenEventIds.has(normalized.eventId)) continue;
        seenEventIds.add(normalized.eventId);
        results.push(normalized);
      }

      const nextUrl = extractNextLink(result.headers.link);

      if (cutoffMs !== null && sawOlderThanCutoff) {
        url = null;
        break;
      }

      if (page === maxPages - 1 && nextUrl) {
        // The safety cap was reached but the API reports more pages are
        // still available — surface that explicitly rather than silently
        // returning a partial result that looks complete.
        truncated = true;
        warnings.push(
          `Copilot audit log pagination truncated after reaching the ${maxPages}-page limit while more results were still available.`,
        );
        url = null;
        break;
      }

      url = nextUrl;
    }
  } catch (err) {
    if (err instanceof GitHubApiError) {
      // Check retryable first: GitHub's primary/secondary rate limits
      // commonly exhaust as 403 with retryable=true, and must be reported
      // as a transient "unknown" outcome rather than a genuine permission
      // denial. Mirrors auth-preflight's probeCapability ordering.
      if (err.retryable) {
        return { status: "unknown", target, message: `GitHub API error ${err.status} (retryable) fetching Copilot audit log events.` };
      }
      if (err.status === 404) return { status: "unavailable", reason: "not_found", target };
      if (err.status === 403) return { status: "unavailable", reason: "forbidden", target };
      return { status: "unknown", target, message: `GitHub API error ${err.status} fetching Copilot audit log events.` };
    }
    // Never broad-catch a programmer/unexpected error — only a typed
    // GitHubApiError is a legitimate "optional source unavailable" signal.
    throw err;
  }

  return { status: "ok", events: results, truncated, warnings };
}

// ── Exported client ───────────────────────────────────────────────────

export class CopilotAuditClient {
  /** Fetch Copilot seat assign/cancel audit events for an enterprise. Always uses PAT auth (enterprise endpoints require it). */
  async getEnterpriseAuditEvents(
    enterprise: string,
    options: CopilotAuditFetchOptions = {},
  ): Promise<AuditFetchResult> {
    return fetchAuditEvents(`/enterprises/${encodeURIComponent(enterprise)}/audit-log`, "", enterprise, options);
  }

  /** Fetch Copilot seat assign/cancel audit events for a single organization. */
  async getOrgAuditEvents(
    org: string,
    options: CopilotAuditFetchOptions = {},
  ): Promise<AuditFetchResult> {
    return fetchAuditEvents(`/orgs/${encodeURIComponent(org)}/audit-log`, org, org, options);
  }
}

export const copilotAuditClient = new CopilotAuditClient();
