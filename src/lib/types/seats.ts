// Types for the Copilot User Management (Seats) API

export interface CopilotSeatAssignee {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  url: string;
  html_url: string;
  type: string;
  site_admin: boolean;
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
}

export interface CopilotSeatsResponse {
  total_seats: number;
  seats: CopilotSeat[];
}
