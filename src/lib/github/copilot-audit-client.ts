// GitHub Audit Log Client — Copilot seat assignment/cancellation events.
// API docs: https://docs.github.com/en/rest/orgs/orgs#get-the-audit-log-for-an-organization
//           https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/using-the-audit-log-api-for-your-enterprise
//
// GitHub's audit log carries seat lifecycle events under several action
// names that have changed over time (a "modern" Copilot-for-Business name
// plus a couple of legacy aliases seen in older enterprises). This client
// fetches the raw, largely free-form audit log payload, filters it down to
// only the seat assign/cancel actions this pipeline cares about, and
// normalizes those into a small, stable shape — preserving the GitHub user
// id/login, external identity (SCIM/SAML nameid, when the entry carries
// one), org, team, and the original raw JSON for auditability.

import { githubFetchWithMeta } from "./api-base";
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

/** Normalize a single raw event. Returns `null` for unrecognized actions or events with no usable timestamp. */
function normalizeEvent(event: RawCopilotAuditEvent, orgLoginFallback: string): NormalizedCopilotAuditEvent | null {
  const action = classifyAction(event.action);
  if (!action) return null;

  const ts = eventTimestampMs(event);
  if (ts === null) return null;

  const orgLogin = event.org || orgLoginFallback;
  return {
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

async function fetchAuditEvents(
  basePath: string,
  orgLoginFallback: string,
  options: CopilotAuditFetchOptions,
): Promise<NormalizedCopilotAuditEvent[]> {
  const { cutoffMs = null, untilMs = null, maxPages = 200, perPage = 100, enterpriseSlug } = options;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error(`copilotAuditClient: maxPages must be an integer >= 1 (received ${maxPages}).`);
  }

  const separator = basePath.includes("?") ? "&" : "?";
  let url: string | null = `${basePath}${separator}per_page=${perPage}`;
  const seenEventIds = new Set<string>();
  const results: NormalizedCopilotAuditEvent[] = [];

  for (let page = 0; page < maxPages && url; page++) {
    const result = await githubFetchWithMeta<RawCopilotAuditEvent[]>(url, { enterpriseSlug });
    const events = Array.isArray(result.data) ? result.data : [];
    if (events.length === 0) break;

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

      const normalized = normalizeEvent(raw, orgLoginFallback);
      if (!normalized) continue;
      if (seenEventIds.has(normalized.eventId)) continue;
      seenEventIds.add(normalized.eventId);
      results.push(normalized);
    }

    if (cutoffMs !== null && sawOlderThanCutoff) break;

    url = extractNextLink(result.headers.link);
  }

  return results;
}

// ── Exported client ───────────────────────────────────────────────────

export class CopilotAuditClient {
  /** Fetch Copilot seat assign/cancel audit events for an enterprise. Always uses PAT auth (enterprise endpoints require it). */
  async getEnterpriseAuditEvents(
    enterprise: string,
    options: CopilotAuditFetchOptions = {},
  ): Promise<NormalizedCopilotAuditEvent[]> {
    return fetchAuditEvents(`/enterprises/${encodeURIComponent(enterprise)}/audit-log`, "", options);
  }

  /** Fetch Copilot seat assign/cancel audit events for a single organization. */
  async getOrgAuditEvents(
    org: string,
    options: CopilotAuditFetchOptions = {},
  ): Promise<NormalizedCopilotAuditEvent[]> {
    return fetchAuditEvents(`/orgs/${encodeURIComponent(org)}/audit-log`, org, options);
  }
}

export const copilotAuditClient = new CopilotAuditClient();
