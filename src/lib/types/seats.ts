// Types for the Copilot User Management (Seats) API

/**
 * GitHub's Copilot seat `assignee` is documented as always carrying `login`
 * and `id`, but seats held by an identity GitHub hasn't fully materialized
 * (e.g. very recently provisioned, or already-deleted) have been observed
 * omitting either or both — hence both are optional here. Any code reading
 * them must not assume presence; `seats-repo.ts` already guards on
 * `seat.assignee?.login` before persisting to the current-snapshot table,
 * and `seats-client.ts`'s historical-ledger normalization is built
 * specifically to handle their absence via a stable `holderKey` fallback.
 */
export interface CopilotSeatAssignee {
  login?: string;
  id?: number;
  node_id?: string;
  avatar_url?: string;
  url?: string;
  html_url?: string;
  type?: string;
  site_admin?: boolean;
}

export interface CopilotAssigningTeam {
  id: number;
  node_id: string;
  name: string;
  slug: string;
  description: string;
  privacy: string;
  permission: string;
  url: string;
  html_url: string;
}

export interface CopilotSeatOrganization {
  login: string;
  id: number;
  node_id?: string;
  url?: string;
  avatar_url?: string;
  description?: string | null;
}

export interface CopilotSeat {
  created_at: string;
  updated_at: string;
  pending_cancellation_date: string | null;
  last_activity_at: string | null;
  last_activity_editor: string | null;
  last_authenticated_at: string | null;
  plan_type: string;
  assignee: CopilotSeatAssignee;
  assigning_team?: CopilotAssigningTeam;
  organization?: CopilotSeatOrganization | null;
}

export interface CopilotSeatsResponse {
  total_seats: number;
  seats: CopilotSeat[];
}
