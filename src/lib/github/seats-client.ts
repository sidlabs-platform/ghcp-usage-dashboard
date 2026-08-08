// GitHub Copilot Seat Management API Client

import { createHash } from "node:crypto";
import { githubFetch, githubFetchPaginated } from "./api-base";
import type { CopilotSeat, CopilotSeatsResponse } from "@/lib/types/seats";

// ── Historical-pipeline seat normalization ──────────────────────────────
//
// The live `GET /*/copilot/billing/seats` endpoint occasionally returns a
// seat whose `assignee` has no resolvable `login` (e.g. a deleted/renamed
// user, or a seat held by an identity GitHub hasn't fully materialized).
// `seats-repo.ts` intentionally skips those for the *current-snapshot*
// `copilot_seats` table (unchanged — see `upsertSeat`/`upsertSeats` there),
// but the historical seat-assignment ledger still needs a stable way to
// track that holder across syncs. `normalizeSeat`/`normalizeSeats` below
// compute a `holderKey` that is:
//   1. The numeric GitHub user id (`id:<id>`) when present — preferred,
//      since it's immutable across login renames.
//   2. Otherwise the login, lowercased (`login:<login>`) — still stable but
//      vulnerable to renames.
//   3. Otherwise a deterministic internal key derived by hashing whatever
//      stable raw identifiers the seat does carry (`node_id`, `url`,
//      `html_url`, `avatar_url`) — so the same fully-unresolved seat
//      produces the same key on every sync instead of being silently
//      dropped or double-counted.
// `unresolved` is true whenever there was no numeric id and no login, so
// downstream consumers can flag/report on these rather than treat them as
// a normal resolved holder.

/** Historical-pipeline-ready normalization of a single live Copilot seat. */
export interface NormalizedCopilotSeat {
  /** Stable identifier for this seat's holder — see module doc for precedence rules. */
  holderKey: string;
  /** Numeric GitHub user id, when the API provided one. */
  githubUserId: number | null;
  /** Login as observed on this seat, when the API provided one (may be absent even with a numeric id). */
  observedLogin: string | null;
  /** True when neither a numeric id nor a login was resolvable (holderKey falls back to a raw-identifier hash). */
  unresolved: boolean;
  orgLogin: string;
  planType: string;
  assignedVia: string;
  lastActivityAt: string | null;
  lastActivityEditor: string | null;
  pendingCancellationDate: string | null;
  createdAt: string;
  updatedAt: string;
  /** The original, unmodified seat payload — retained for auditability. */
  raw: CopilotSeat;
}

/**
 * Deterministically hash whatever stable raw identifiers a fully-unresolved
 * seat (no numeric id, no login) still carries, so the same seat produces
 * the same internal holder key across repeated syncs instead of being
 * dropped or non-deterministically re-keyed.
 */
function hashRawSeatIdentifiers(seat: CopilotSeat, orgLogin: string): string {
  const assignee = seat.assignee ?? {};
  const material = JSON.stringify([
    orgLogin,
    assignee.node_id ?? "",
    assignee.url ?? "",
    assignee.html_url ?? "",
    assignee.avatar_url ?? "",
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Normalize a single live seat into the holder-key-stable shape the
 * historical ledger source needs. Never throws and never drops a seat —
 * unlike `seats-repo.ts`'s current-snapshot writers, which intentionally
 * skip seats with no resolvable login.
 */
export function normalizeSeat(seat: CopilotSeat, orgLogin: string): NormalizedCopilotSeat {
  const assignee = seat.assignee;
  const numericId = typeof assignee?.id === "number" && Number.isFinite(assignee.id) ? assignee.id : null;
  const login = assignee?.login || null;

  let holderKey: string;
  let unresolved = false;
  if (numericId !== null) {
    holderKey = `id:${numericId}`;
  } else if (login) {
    holderKey = `login:${login.toLowerCase()}`;
  } else {
    holderKey = `internal:${hashRawSeatIdentifiers(seat, orgLogin)}`;
    unresolved = true;
  }

  return {
    holderKey,
    githubUserId: numericId,
    observedLogin: login,
    unresolved,
    orgLogin,
    planType: seat.plan_type,
    assignedVia: seat.assigning_team?.slug ? "team" : "direct",
    lastActivityAt: seat.last_activity_at,
    lastActivityEditor: seat.last_activity_editor,
    pendingCancellationDate: seat.pending_cancellation_date,
    createdAt: seat.created_at,
    updatedAt: seat.updated_at,
    raw: seat,
  };
}

/** Normalize a batch of live seats for the same org. See `normalizeSeat`. */
export function normalizeSeats(seats: CopilotSeat[], orgLogin: string): NormalizedCopilotSeat[] {
  return seats.map((seat) => normalizeSeat(seat, orgLogin));
}

export class SeatsClient {
  async getOrgSeats(org: string, enterpriseSlug?: string): Promise<{ totalSeats: number; seats: CopilotSeat[] }> {
    // First call to get total_seats count
    const first = await githubFetch<CopilotSeatsResponse>(
      `/orgs/${org}/copilot/billing/seats?per_page=100`,
      3, undefined, enterpriseSlug
    );

    if (!first) return { totalSeats: 0, seats: [] };

    const allSeats: CopilotSeat[] = [...(first.seats || [])];

    // Paginate if more seats exist (max 100 pages as safety limit)
    if (first.total_seats > 100) {
      let page = 2;
      const maxPages = 100;
      while (allSeats.length < first.total_seats && page <= maxPages) {
        const resp = await githubFetch<CopilotSeatsResponse>(
          `/orgs/${org}/copilot/billing/seats?per_page=100&page=${page}`,
          3, undefined, enterpriseSlug
        );
        if (!resp?.seats?.length) break;
        allSeats.push(...resp.seats);
        page++;
      }
    }

    return { totalSeats: first.total_seats, seats: allSeats };
  }

  async getEnterpriseSeats(enterprise: string, enterpriseSlug?: string): Promise<{ totalSeats: number; seats: CopilotSeat[] }> {
    const first = await githubFetch<CopilotSeatsResponse>(
      `/enterprises/${enterprise}/copilot/billing/seats?per_page=100`,
      3, undefined, enterpriseSlug
    );

    if (!first) return { totalSeats: 0, seats: [] };

    const allSeats: CopilotSeat[] = [...(first.seats || [])];

    if (first.total_seats > 100) {
      let page = 2;
      const maxPages = 100;
      while (allSeats.length < first.total_seats && page <= maxPages) {
        const resp = await githubFetch<CopilotSeatsResponse>(
          `/enterprises/${enterprise}/copilot/billing/seats?per_page=100&page=${page}`,
          3, undefined, enterpriseSlug
        );
        if (!resp?.seats?.length) break;
        allSeats.push(...resp.seats);
        page++;
      }
    }

    return { totalSeats: first.total_seats, seats: allSeats };
  }

  /**
   * Org-scoped seats, normalized for the historical seat ledger. Unlike
   * `seats-repo.ts`'s current-snapshot writers, unresolved seats (no login)
   * are preserved here via `holderKey` rather than skipped.
   */
  async getOrgSeatsNormalized(org: string, enterpriseSlug?: string): Promise<{ totalSeats: number; seats: NormalizedCopilotSeat[] }> {
    const { totalSeats, seats } = await this.getOrgSeats(org, enterpriseSlug);
    return { totalSeats, seats: normalizeSeats(seats, org) };
  }

  /**
   * Enterprise-scoped seats, normalized for the historical seat ledger.
   * Each seat's `orgLogin` is taken from its own `organization.login` (an
   * enterprise-level seat listing spans multiple orgs), falling back to an
   * empty string when the API didn't attribute the seat to an org.
   */
  async getEnterpriseSeatsNormalized(enterprise: string, enterpriseSlug?: string): Promise<{ totalSeats: number; seats: NormalizedCopilotSeat[] }> {
    const { totalSeats, seats } = await this.getEnterpriseSeats(enterprise, enterpriseSlug);
    const normalized = seats.map((seat) => normalizeSeat(seat, seat.organization?.login || ""));
    return { totalSeats, seats: normalized };
  }
}

export const seatsClient = new SeatsClient();
